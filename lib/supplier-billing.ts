import { dbAll, dbGet, dbRun } from "./db";
import { gatewayApi } from "./gateway-adapter";
import type { GatewaySecret } from "./gateways";
import { getGateway } from "./gateways";
import { readCustomerBilling, type MidnightReading } from "./billing-math";
import { shanghaiClock, shanghaiMidnight } from "./shanghai";

/** 计费源 C：供应商 JWT 站按「一次列表走完」拍每日 0 点快照（docs/plans/2026-11-05-billing-pluggable.md §6）。
 *  快重试 5 次，之后每 15 分钟一轮；同日已成功的快照不覆盖；跨日不回填。 */

const SOURCE_ID = "customer_billing";
const FAST_RETRIES = 5;
const ROUND_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

type Attempt = { fastLeft: number; nextAt: number; done: boolean };

const attempts = new Map<string, Attempt>();

function attemptKey(gatewayId: string, day: string): string {
  return `${gatewayId}:${day}`;
}

async function gatewayDayDone(gatewayId: string, day: string): Promise<boolean> {
  const marker = await dbGet("SELECT 1 AS ok FROM billing_snapshots WHERE channel_id = ? AND day = ? AND source_id = ? AND note = 'gateway-done'", [
    `__gw__:${gatewayId}`,
    day,
    SOURCE_ID,
  ]);
  return Boolean(marker);
}

async function upsertSnapshot(channelId: string, day: string, reading: MidnightReading, raw: Record<string, unknown>, note: string | null): Promise<void> {
  await dbRun(
    `INSERT INTO billing_snapshots (channel_id, day, source_id, quality, amount, unit, fx_rate, upstream_source, state, stale, as_of, pulled_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, day, source_id) DO NOTHING`,
    [
      channelId,
      day,
      SOURCE_ID,
      reading.quality,
      reading.amount,
      reading.unit,
      reading.fxRate,
      reading.upstreamSource,
      raw.state === undefined ? null : String(raw.state),
      raw.stale === true ? 1 : 0,
      raw.as_of === undefined || raw.as_of === null ? null : String(raw.as_of),
      reading.pulledAt,
      note,
    ],
  );
}

export async function runSupplierSnapshots(now = Date.now()): Promise<void> {
  const { supplierBillingEnabled } = await import("./settings");
  if (!(await supplierBillingEnabled())) return;
  const clock = shanghaiClock(new Date(now));
  const day = clock.day;
  const rows = (await dbAll("SELECT id FROM gateways WHERE disabled = 0 AND kind = 'newapi_supplier'")) as { id: string }[];
  for (const row of rows) {
    const key = attemptKey(row.id, day);
    const state = attempts.get(key) ?? { fastLeft: FAST_RETRIES, nextAt: 0, done: false };
    attempts.set(key, state);
    if (state.done || now < state.nextAt) continue;
    if (await gatewayDayDone(row.id, day)) {
      state.done = true;
      continue;
    }
    const gateway = await getGateway(row.id);
    if (!gateway) continue;
    try {
      await snapshotGateway(gateway, day, now);
      await dbRun(
        `INSERT INTO billing_snapshots (channel_id, day, source_id, quality, amount, unit, pulled_at, note)
         VALUES (?, ?, ?, 'ok', NULL, 'usd', ?, 'gateway-done')
         ON CONFLICT(channel_id, day, source_id) DO NOTHING`,
        [`__gw__:${row.id}`, day, SOURCE_ID, now],
      );
      state.done = true;
    } catch (error) {
      if (state.fastLeft > 0) {
        state.fastLeft -= 1;
        state.nextAt = now + 30_000;
      } else {
        state.nextAt = now + ROUND_MS;
      }
      const message = error instanceof Error ? error.message : "snapshotFailed";
      console.info(`[supplier-billing] ${day} ${row.id} ${message} (fast left ${state.fastLeft})`);
      if (/繁忙|限流|超时/.test(message) && state.fastLeft <= 0) state.nextAt = now + ROUND_MS;
    }
  }
}

async function snapshotGateway(gateway: GatewaySecret, day: string, now: number): Promise<void> {
  const dayStart = shanghaiMidnight(day);
  const late = now - dayStart > WINDOW_MS;
  const imported = (await dbAll(
    "SELECT id, upstream_id, imported_at FROM channels WHERE gateway_id = ? AND created_here = 1",
    [gateway.id],
  )) as { id: string; upstream_id: number; imported_at: number | null }[];
  const byUpstream = new Map(imported.map((channel) => [Number(channel.upstream_id), channel]));
  const api = gatewayApi(gateway);
  for (let page = 1; page <= 2000; page += 1) {
    const listed = await api.list(page);
    for (const item of listed.items) {
      const channel = byUpstream.get(item.id);
      if (!channel) continue;
      const prior = await dbGet("SELECT 1 AS ok FROM billing_snapshots WHERE channel_id = ? AND day < ? AND source_id = ?", [
        channel.id,
        day,
        SOURCE_ID,
      ]);
      const reading = readCustomerBilling(item.customerBilling ?? null, now);
      const notes = [
        prior ? null : "import-anchor",
        late && reading.quality === "ok" ? "late" : null,
      ].filter(Boolean);
      await upsertSnapshot(channel.id, day, reading, item.customerBilling ?? {}, notes.length ? notes.join("+") : null);
      if (late && reading.quality === "ok" && notes.includes("late")) {
        console.warn(`[supplier-billing] late snapshot ${day} channel ${channel.id} — 快照晚于日界窗口`);
      }
    }
    if (page * 20 >= listed.total) break;
  }
}

/** 供账单展示：某渠道某日的读数（含前一天），日差交给 billing-math 的 dailyDiff。 */
export async function supplierReadings(channelId: string, day: string): Promise<{ prev: MidnightReading | null; next: MidnightReading | null }> {
  const rows = (await dbAll(
    `SELECT day, quality, amount, unit, fx_rate, upstream_source, pulled_at FROM billing_snapshots
     WHERE channel_id = ? AND source_id = ? AND day IN (?, (SELECT MAX(day) FROM billing_snapshots WHERE channel_id = ? AND source_id = ? AND day < ?))
     ORDER BY day`,
    [channelId, SOURCE_ID, day, channelId, SOURCE_ID, day],
  )) as Record<string, unknown>[];
  const toReading = (row: Record<string, unknown>): MidnightReading => ({
    quality: String(row.quality) as MidnightReading["quality"],
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    unit: String(row.unit) === "quota" ? "quota" : "usd",
    fxRate: row.fx_rate === null || row.fx_rate === undefined ? null : Number(row.fx_rate),
    upstreamSource: String(row.upstream_source ?? ""),
    pulledAt: Number(row.pulled_at ?? 0),
  });
  const dayRows = rows.filter((row) => String(row.day) === day);
  const prevRows = rows.filter((row) => String(row.day) !== day);
  return { prev: prevRows[0] ? toReading(prevRows[0]) : null, next: dayRows[0] ? toReading(dayRows[0]) : null };
}
