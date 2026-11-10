import { deriveBaseline, NEAR_MIDNIGHT_MS, reconcileFinding, resolveConsumption, resolveSellerConsumption, todayExcludingTests, type BaselinePoint } from "./billing-math";
import { rollupReadingValues, type ReadingSummary } from "./billing-query";
import { CALLS_PER_CHANNEL, LIST_SYNC_RESERVE_PER_MIN, type PlanChannel } from "./billing-plan";
import { channelTypeName } from "./channel-types";
import { QUOTA_PER_DOLLAR } from "./format";
import { dbAll, dbGet, dbRun, dbTransaction } from "./db";
import { getGateway } from "./gateways";
import { syncReconChannel } from "./recon-service";
import { rebindMarkers } from "./rebind";
import { rateLimits } from "./settings";
import { addDays, formatShanghaiTime, logWindow, shanghaiClock, shanghaiMidnight } from "./shanghai";
import { scopeOwnerId } from "./scope";
import type { SessionUser } from "./types";
import { isPostgresUrl } from "./paths";
import { normalizeBaseUrl } from "./url";
import { gatewayApi } from "./gateway-adapter";
import { judgeListPage } from "./list-sweep";
import { fetchUpstreamChannel, testLogQuota, todayQuota, UpstreamFailure } from "./upstream";

type Row = Record<string, unknown>;

async function baselinesFor(channelId: string): Promise<BaselinePoint[]> {
  const rows = (await dbAll("SELECT day, baseline, source FROM channel_baselines WHERE channel_id = ? ORDER BY day", [channelId])) as {
    day: string;
    baseline: number;
    source: string;
  }[];
  return rows.map((row) => ({ day: row.day, baseline: Number(row.baseline), source: String(row.source ?? "") }));
}

/** used_quota at the moment this app created the channel. Anchors the first billed day. */
export async function snapshotCreateBaseline(channelId: string, usedQuota: number, atMs = Date.now()): Promise<void> {
  const quota = Number.isFinite(usedQuota) ? usedQuota : 0;
  const day = shanghaiClock(new Date(atMs)).day;
  await dbRun(
    `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
     VALUES (?, ?, ?, ?, NULL, 'create', ?)
     ON CONFLICT(channel_id, day) DO NOTHING`,
    [channelId, day, quota, quota, Date.now()],
  );
  await dbRun("UPDATE channels SET create_baseline = COALESCE(create_baseline, ?) WHERE id = ?", [quota, channelId]);
}

async function pullSellerBaseline(
  channelId: string,
  baselineDay: string,
  gateway: NonNullable<Awaited<ReturnType<typeof getGateway>>>,
  row: Row,
  upstreamId: number,
): Promise<"ok" | "failed"> {
  const origin = String(row.origin ?? "created");
  const importedAt = row.imported_at ? Number(row.imported_at) : 0;
  const dayStart = shanghaiMidnight(baselineDay);
  if (origin === "imported" && importedAt >= dayStart) {
    await markAttempt(baselineDay, channelId, "ok", null);
    return "ok";
  }
  try {
    const api = gatewayApi(gateway);
    let remote: { usedQuota: number; balance: number | null } | null = null;
    let agreed: number | null = null;
    const seen = new Set<number>();
    let aborted = false;
    for (let page = 1; page <= 2000; page += 1) {
      const listed = await api.list(page);
      const found = listed.items.find((item) => item.id === upstreamId);
      for (const item of listed.items) seen.add(item.id);
      if (found) {
        remote = found;
        break;
      }
      const step = judgeListPage({ explicitTotal: listed.total, agreedTotal: agreed, itemCount: listed.items.length, uniqueIds: seen.size });
      agreed = step.agreedTotal;
      if (step.verdict === "abort") {
        aborted = true;
        break;
      }
      if (step.verdict === "complete") break;
      if (page === 2000) aborted = true;
    }
    if (!remote) {
      if (aborted) throw new UpstreamFailure("incompleteList", true);
      await markMissing(channelId);
      throw new UpstreamFailure("missing", false);
    }
    const pulledAt = Date.now();
    if (pulledAt < dayStart || pulledAt - dayStart > NEAR_MIDNIGHT_MS) throw new UpstreamFailure("missingToday", false);
    const existing = await dbGet("SELECT source FROM channel_baselines WHERE channel_id = ? AND day = ?", [channelId, baselineDay]);
    if (existing?.source === "create" || existing?.source === "import-anchor" || existing?.source === "snapshot") {
      await markAttempt(baselineDay, channelId, "ok", null);
      const run = await dbGet("SELECT status, bill_day FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
      if (run?.status === "published") await writeRow(channelId, String(run.bill_day), Date.now());
      return "ok";
    }
    const prior = await dbGet("SELECT COUNT(*) AS n FROM channel_baselines WHERE channel_id = ?", [channelId]);
    const source = origin === "imported" && Number(prior?.n ?? 0) === 0 ? "import-anchor" : "snapshot";
    await dbRun(
      `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(channel_id, day) DO NOTHING`,
      [channelId, baselineDay, remote.usedQuota, remote.usedQuota, source, pulledAt],
    );
    await dbRun(
      "UPDATE channels SET used_quota = ?, balance = COALESCE(?, balance), last_sync_at = ?, sync_status = 'ok', sync_error = NULL, consecutive_failures = 0, upstream_missing = 0 WHERE id = ?",
      [remote.usedQuota, remote.balance, pulledAt, channelId],
    );
    await markAttempt(baselineDay, channelId, "ok", null);
    const run = await dbGet("SELECT status, bill_day FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
    if (run?.status === "published") await writeRow(channelId, String(run.bill_day), Date.now());
    return "ok";
  } catch (error) {
    return failBaseline(baselineDay, channelId, error);
  }
}

async function failBaseline(baselineDay: string, channelId: string, error: unknown): Promise<"failed"> {
  const message = error instanceof Error ? error.message : "pullFailed";
  const missing = /找不到|不存在|not found|^missing$/i.test(message);
  if (missing) await markMissing(channelId);
  await dbRun(
    `INSERT INTO billing_attempts (baseline_day, channel_id, status, error, updated_at) VALUES (?, ?, 'failed', ?, ?)
     ON CONFLICT(baseline_day, channel_id) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at`,
    [baselineDay, channelId, message.slice(0, 200), Date.now()],
  );
  if (!missing) {
    await dbRun("UPDATE channels SET sync_status = ?, sync_error = ?, last_sync_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?", [
      /繁忙|限流|超时/.test(message) ? "rate_limited" : "failed",
      message.slice(0, 200),
      Date.now(),
      channelId,
    ]);
  }
  return "failed";
}

export async function pullChannelBaseline(channelId: string, baselineDay: string): Promise<"ok" | "failed"> {
  const row = (await dbGet("SELECT * FROM channels WHERE id = ?", [channelId])) as Row | undefined;
  if (!row) return "failed";
  const gateway = await getGateway(String(row.gateway_id));
  if (!gateway) return "failed";
  if (Number(row.created_here) !== 1) return "failed";
  const upstreamId = Number(row.upstream_id);
  if (gateway.kind === "newapi_seller") return pullSellerBaseline(channelId, baselineDay, gateway, row, upstreamId);
  try {
    const remote = await fetchUpstreamChannel(gateway, upstreamId);
    if (!remote) {
      await markMissing(channelId);
      throw new UpstreamFailure("missing", false);
    }
    const kept = await dbGet("SELECT source FROM channel_baselines WHERE channel_id = ? AND day = ?", [channelId, baselineDay]);
    if (kept?.source === "create") {
      await dbRun(
        "UPDATE channels SET used_quota = ?, balance = COALESCE(?, balance), last_sync_at = ?, sync_status = 'ok', sync_error = NULL, consecutive_failures = 0, upstream_missing = 0 WHERE id = ?",
        [remote.usedQuota, remote.balance, Date.now(), channelId],
      );
      await markAttempt(baselineDay, channelId, "ok", null);
      const run = await dbGet("SELECT status, bill_day FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
      if (run?.status === "published") await writeRow(channelId, String(run.bill_day), Date.now());
      return "ok";
    }
    const cumulative = remote.usedQuota;
    const dayStart = shanghaiMidnight(baselineDay);
    let today = remote?.todayFromPayload ?? null;
    if (today === null) today = await todayQuota(gateway, upstreamId, dayStart, Date.now());
    // 今日日志为 0 时测试日志必为 0，跳过两次查询（空闲渠道从最坏 4 个请求降到 2 个）
    if (today !== null && today > 0) {
      const tests = await testLogQuota(gateway, upstreamId, dayStart, Date.now());
      today = todayExcludingTests(today, tests ?? 0);
    }
    const derived = deriveBaseline({ cumulative, today, pulledAt: Date.now(), dayStart });
    if (!derived) throw new UpstreamFailure("missingToday", false);
    await dbRun(
      `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, day) DO UPDATE SET
         baseline = excluded.baseline, cumulative = excluded.cumulative, today_quota = excluded.today_quota,
         source = excluded.source, pulled_at = excluded.pulled_at
       WHERE channel_baselines.source <> 'create'`,
      [channelId, baselineDay, derived.baseline, cumulative, today, derived.source, Date.now()],
    );
    await dbRun(
      "UPDATE channels SET used_quota = ?, today_quota = COALESCE(?, today_quota), balance = COALESCE(?, balance), last_sync_at = ?, sync_status = 'ok', sync_error = NULL, consecutive_failures = 0, upstream_missing = 0 WHERE id = ?",
      [cumulative, today, remote.balance, Date.now(), channelId],
    );
    await markAttempt(baselineDay, channelId, "ok", null);
    const run = await dbGet("SELECT status, bill_day FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
    if (run?.status === "published") await writeRow(channelId, String(run.bill_day), Date.now());
    return "ok";
  } catch (error) {
    const message = error instanceof Error ? error.message : "pullFailed";
    const missing = /找不到|不存在|not found|^missing$/i.test(message);
    if (missing) await markMissing(channelId);
    await dbRun(
      `INSERT INTO billing_attempts (baseline_day, channel_id, status, error, updated_at) VALUES (?, ?, 'failed', ?, ?)
       ON CONFLICT(baseline_day, channel_id) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at`,
      [baselineDay, channelId, message.slice(0, 200), Date.now()],
    );
    if (!missing) {
      await dbRun("UPDATE channels SET sync_status = ?, sync_error = ?, last_sync_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?", [
        /繁忙|限流|超时/.test(message) ? "rate_limited" : "failed",
        message.slice(0, 200),
        Date.now(),
        channelId,
      ]);
    }
    return "failed";
  }
}

async function markMissing(channelId: string): Promise<void> {
  await dbRun("UPDATE channels SET upstream_missing = 1, sync_status = 'missing', sync_error = ? WHERE id = ? AND created_here = 1", [
    "missing",
    channelId,
  ]);
}

async function markAttempt(baselineDay: string, channelId: string, status: "ok" | "failed", error: string | null): Promise<void> {
  await dbRun(
    `INSERT INTO billing_attempts (baseline_day, channel_id, status, error, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(baseline_day, channel_id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`,
    [baselineDay, channelId, status, error, Date.now()],
  );
}

/** Log-stat quota for one channel and window, with model-test consume removed. Null when the logs cannot be read. */
async function logQuotaForSpan(channelId: string, startDay: string, endDay: string): Promise<number | null> {
  const row = (await dbGet("SELECT gateway_id, upstream_id, upstream_missing FROM channels WHERE id = ?", [channelId])) as Row | undefined;
  if (!row || Number(row.upstream_missing) === 1) return null;
  const gateway = await getGateway(String(row.gateway_id));
  if (!gateway) return null;
  const { start, end } = logWindow(startDay, endDay);
  try {
    const total = await todayQuota(gateway, Number(row.upstream_id), start, end);
    if (total === null) return null;
    const tests = await testLogQuota(gateway, Number(row.upstream_id), start, end);
    return todayExcludingTests(total, tests ?? 0);
  } catch {
    return null;
  }
}

async function spanTestQuota(channelId: string, startDay: string, endDay: string): Promise<number> {
  const row = (await dbGet("SELECT gateway_id, upstream_id FROM channels WHERE id = ?", [channelId])) as Row | undefined;
  const { start, end } = logWindow(startDay, endDay);
  if (row) {
    const gateway = await getGateway(String(row.gateway_id));
    if (gateway) {
      try {
        const remote = await testLogQuota(gateway, Number(row.upstream_id), start, end);
        if (remote !== null) return remote;
      } catch {
        /* fall through to the tests we recorded */
      }
    }
  }
  const local = await dbGet(
    "SELECT COALESCE(SUM(quota), 0) AS n FROM test_runs WHERE channel_id = ? AND created_at >= ? AND created_at < ? AND result = 'ok'",
    [channelId, start, end],
  );
  return Number(local?.n ?? 0);
}

async function writeRow(channelId: string, billDay: string, backfillAt: number | null): Promise<void> {
  const channel = await dbGet("SELECT created_here, upstream_missing, gateway_id FROM channels WHERE id = ?", [channelId]);
  if (!channel || Number(channel.created_here) !== 1) {
    await dbRun("DELETE FROM billing_rows WHERE bill_day = ? AND channel_id = ?", [billDay, channelId]);
    await syncReconChannel(billDay, channelId);
    return;
  }
  const gateway = await getGateway(String(channel.gateway_id ?? ""));
  const seller = gateway?.kind === "newapi_seller";
  const resolved = seller ? resolveSellerConsumption(billDay, await baselinesFor(channelId)) : resolveConsumption(billDay, await baselinesFor(channelId));
  const id = `${billDay}:${channelId}`;
  if (resolved.kind === "skip") {
    await dbRun("DELETE FROM billing_rows WHERE bill_day = ? AND channel_id = ?", [billDay, channelId]);
    if (seller) await dbRun("DELETE FROM recon_rows WHERE bill_day = ? AND channel_id = ? AND supplier_action = '' AND admin_resolution = ''", [billDay, channelId]);
    else await syncReconChannel(billDay, channelId);
    return;
  }
  const missing = Number(channel.upstream_missing) === 1;
  if (seller) {
    const finding = missing ? "missing" : "";
    if (resolved.kind === "amount") {
      await dbRun(
        `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, label, consumption, kind, backfill_at, test_quota, finding, log_quota, billing_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'amount', ?, 0, ?, NULL, 'snapshot')
         ON CONFLICT(bill_day, channel_id) DO UPDATE SET
           start_day = excluded.start_day, end_day = excluded.end_day, span_days = excluded.span_days,
           label = excluded.label, consumption = excluded.consumption, kind = 'amount',
           backfill_at = COALESCE(billing_rows.backfill_at, excluded.backfill_at),
           test_quota = 0, finding = excluded.finding, log_quota = NULL, billing_mode = 'snapshot'`,
        [id, billDay, channelId, resolved.startDay, resolved.endDay, resolved.days, resolved.label, resolved.consumption, backfillAt, finding],
      );
    } else {
      await dbRun(
        `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, label, consumption, kind, backfill_at, test_quota, finding, log_quota, billing_mode)
         VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, 0, ?, NULL, 'snapshot')
         ON CONFLICT(bill_day, channel_id) DO UPDATE SET kind = excluded.kind, consumption = NULL, test_quota = 0, finding = excluded.finding, log_quota = NULL, billing_mode = 'snapshot', backfill_at = COALESCE(billing_rows.backfill_at, excluded.backfill_at)`,
        [id, billDay, channelId, billDay, billDay, resolved.kind, backfillAt, finding],
      );
    }
    await dbRun("DELETE FROM recon_rows WHERE bill_day = ? AND channel_id = ? AND supplier_action = '' AND admin_resolution = ''", [billDay, channelId]);
    return;
  }
  if (resolved.kind === "amount") {
    const testQuota = await spanTestQuota(channelId, resolved.startDay, resolved.endDay);
    const logQuota = await logQuotaForSpan(channelId, resolved.startDay, resolved.endDay);
    const finding = reconcileFinding({ missing, consumption: resolved.consumption, logQuota });
    await dbRun(
      `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, label, consumption, kind, backfill_at, test_quota, finding, log_quota)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'amount', ?, ?, ?, ?)
       ON CONFLICT(bill_day, channel_id) DO UPDATE SET
         start_day = excluded.start_day, end_day = excluded.end_day, span_days = excluded.span_days,
         label = excluded.label, consumption = excluded.consumption, kind = 'amount',
         backfill_at = COALESCE(billing_rows.backfill_at, excluded.backfill_at),
         test_quota = excluded.test_quota, finding = excluded.finding, log_quota = excluded.log_quota`,
      [id, billDay, channelId, resolved.startDay, resolved.endDay, resolved.days, resolved.label, resolved.consumption, backfillAt, testQuota, finding, logQuota],
    );
    await syncReconChannel(billDay, channelId);
    return;
  }
  const finding = reconcileFinding({ missing, consumption: null, logQuota: null });
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, label, consumption, kind, backfill_at, test_quota, finding, log_quota)
     VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, 0, ?, NULL)
     ON CONFLICT(bill_day, channel_id) DO UPDATE SET kind = excluded.kind, consumption = NULL, test_quota = 0, finding = excluded.finding, log_quota = NULL, backfill_at = COALESCE(billing_rows.backfill_at, excluded.backfill_at)`,
    [id, billDay, channelId, billDay, billDay, resolved.kind, backfillAt, finding],
  );
  await syncReconChannel(billDay, channelId);
}

/**
 * Publish one bill day.
 * `billing_runs.aggregation` is the rule version, not a boolean.
 * null means legacy: render the stored rows as they were published.
 * 'dedup' means this generation of rules (dedup + disabled-gateway split).
 * A later rule adds a new value instead of reusing these two.
 * A run that is not already published is stamped 'dedup' and its membership is frozen.
 * 2026-11-10 is the first such bill: `ensureBillingRun` publishes it at 06:00 Shanghai.
 * A run that was already published keeps its version and is not re-partitioned.
 */
export async function publishBill(billDay: string, baselineDay: string): Promise<void> {
  const existing = await dbGet("SELECT status FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
  const alreadyPublished = String(existing?.status ?? "") === "published";
  // 供应商 JWT 网关的渠道走源 C 快照差，由 billingView 现算；不进旧基线路径（used_quota=0 会造成假零）
  const channels = (await dbAll(
    `SELECT c.id FROM channels c JOIN gateways g ON g.id = c.gateway_id
     WHERE c.created_here = 1 AND COALESCE(g.kind, 'newapi_admin') <> 'newapi_supplier'`,
  )) as { id: string }[];
  for (const channel of channels) await writeRow(channel.id, billDay, null);
  if (!alreadyPublished) await freezeBillMembership(billDay);
  const counts = await countRun(baselineDay);
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, total_count, ok_count, failed_count, aggregation)
     VALUES (?, ?, 'published', ?, ?, ?, ?, ?, 'dedup')
     ON CONFLICT(baseline_day) DO UPDATE SET status = 'published', published_at = excluded.published_at,
       total_count = excluded.total_count, ok_count = excluded.ok_count, failed_count = excluded.failed_count,
       aggregation = CASE WHEN billing_runs.status = 'published' THEN billing_runs.aggregation ELSE 'dedup' END`,
    [baselineDay, billDay, Date.now(), Date.now(), counts.total, counts.ok, counts.failed],
  );
}

async function countRun(baselineDay: string): Promise<{ total: number; ok: number; failed: number }> {
  const total = Number((await dbGet("SELECT COUNT(*) AS n FROM channels WHERE created_here = 1"))?.n ?? 0);
  const ok = Number(
    (await dbGet(
      "SELECT COUNT(*) AS n FROM channel_baselines b JOIN channels c ON c.id = b.channel_id WHERE b.day = ? AND c.created_here = 1",
      [baselineDay],
    ))?.n ?? 0,
  );
  const failed = Number(
    (await dbGet(
      "SELECT COUNT(*) AS n FROM billing_attempts a JOIN channels c ON c.id = a.channel_id WHERE a.baseline_day = ? AND a.status = 'failed' AND c.created_here = 1",
      [baselineDay],
    ))?.n ?? 0,
  );
  return { total, ok, failed: Math.max(0, Math.min(failed, total - ok)) };
}

export async function ensureBillingRun(now = new Date()): Promise<{ baselineDay: string; billDay: string; status: string } | null> {
  const clock = shanghaiClock(now);
  const baselineDay = clock.day;
  const billDay = addDays(baselineDay, -1);
  const existing = await dbGet("SELECT status FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
  if (!existing) {
    const counts = await countRun(baselineDay);
    await dbRun(
      `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, total_count, ok_count, failed_count)
       VALUES (?, ?, 'collecting', ?, NULL, ?, ?, ?)`,
      [baselineDay, billDay, Date.now(), counts.total, counts.ok, counts.failed],
    );
  }
  const run = await dbGet("SELECT status, total_count FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
  const counts = await countRun(baselineDay);
  const due = clock.hour > 6 || (clock.hour === 6 && clock.minute >= 0);
  const complete = counts.total > 0 && counts.ok >= counts.total;
  if (run?.status !== "published" && (complete || due)) await publishBill(billDay, baselineDay);
  else {
    await dbRun("UPDATE billing_runs SET total_count = ?, ok_count = ?, failed_count = ? WHERE baseline_day = ?", [
      counts.total,
      counts.ok,
      counts.failed,
      baselineDay,
    ]);
  }
  const latest = await dbGet("SELECT status FROM billing_runs WHERE baseline_day = ?", [baselineDay]);
  return { baselineDay, billDay, status: String(latest?.status ?? "collecting") };
}

/** 缺基线渠道及其计划字段：大额消耗优先，带上连续失败计数和最近失败时间供退避。
 *  当天导入的渠道（imported_at >= 基线日 0 点）从首个快照起算，不进当日基线拉取。 */
export async function missingBaselineChannels(baselineDay: string): Promise<PlanChannel[]> {
  const rows = (await dbAll(
    `SELECT c.id, c.gateway_id, c.used_quota, c.created_at, c.consecutive_failures, a.updated_at AS last_failed_at
     FROM channels c
     LEFT JOIN channel_baselines b ON b.channel_id = c.id AND b.day = ?
     LEFT JOIN billing_attempts a ON a.channel_id = c.id AND a.baseline_day = ? AND a.status = 'failed'
     WHERE c.created_here = 1 AND b.channel_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM gateways g WHERE g.id = c.gateway_id AND g.kind = 'newapi_supplier')
       AND NOT (COALESCE(c.origin, 'created') = 'imported' AND c.imported_at IS NOT NULL AND c.imported_at >= ?)
     ORDER BY c.used_quota DESC, c.created_at DESC`,
    [baselineDay, baselineDay, shanghaiMidnight(baselineDay)],
  )) as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    gatewayId: String(row.gateway_id),
    usedQuota: Number(row.used_quota ?? 0),
    createdAt: Number(row.created_at ?? 0),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastFailedAt: row.last_failed_at === null || row.last_failed_at === undefined ? null : Number(row.last_failed_at),
  }));
}

export type BillingViewOptions = {
  unsyncedOnly?: boolean;
  /** 指定账单日（bill_day，上海时区 YYYY-MM-DD）；缺省 = 最新一期已发布账单。 */
  day?: string | null;
  /** 管理员按供应商筛选（用户 id）；供应商恒定只能看自己。 */
  supplierId?: string | null;
};

export type BillPublication = "latest" | "published" | "unpublished" | "none";

function gatewaySite(base: unknown): string {
  const raw = String(base ?? "").trim();
  if (!raw) return "";
  const normalized = normalizeBaseUrl(raw);
  return normalized.ok ? normalized.siteBase : raw;
}

/** One upstream channel counts once. The key is the normalized upstream site plus the upstream channel id. An enabled gateway wins over a disabled copy. */
function partitionBillRows(rows: Row[]): { counted: Row[]; excluded: Row[] } {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const upstream = Number(row.upstream_id);
    const key = Number.isFinite(upstream) ? `${gatewaySite(row.gateway_base)}|${upstream}` : `row:${String(row.channel_id)}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const counted: Row[] = [];
  const excluded: Row[] = [];
  for (const list of groups.values()) {
    const enabled = list.filter((row) => Number(row.gateway_disabled) !== 1);
    const pool = (enabled.length ? enabled : list).slice().sort((a, b) => String(a.channel_id).localeCompare(String(b.channel_id)));
    const winner = pool[0];
    if (!winner) continue;
    if (Number(winner.gateway_disabled) === 1) excluded.push(winner);
    else counted.push(winner);
  }
  return { counted, excluded };
}

function consumptionOf(row: Row): number | null {
  if (String(row.kind) !== "amount") return null;
  if (row.consumption === null || row.consumption === undefined) return null;
  const value = Number(row.consumption);
  return Number.isFinite(value) ? value : null;
}

/** Pre-#12 counted row: kind=amount and a non-null consumption, including non-finite values. */
function legacyAmount(row: Row): boolean {
  return String(row.kind) === "amount" && row.consumption !== null && row.consumption !== undefined;
}

/** Same three states as a group total: no readings, a partial sum, or a complete sum. A missing reading stays null and is never turned into 0. */
export function rollupReadings(rows: Row[]): ReadingSummary {
  return rollupReadingValues(
    rows.map((row) => ({
      kind: String(row.kind ?? ""),
      consumption: row.consumption === null || row.consumption === undefined ? null : Number(row.consumption),
    })),
  );
}

type BillAggregateMode = "legacy" | "live" | "frozen";

/**
 * First bill_day on the dedup rules. A published run on or after this day whose
 * aggregation is still null is stamped on the first read. 2026-11-09 and earlier stay as stored.
 */
export const DEDUP_RULE_START = "2026-11-10";

/**
 * One decision for the open bill and for every day in the trend.
 * Unpublished runs are live. A published null version before DEDUP_RULE_START is the stored rows.
 * 'dedup' is the frozen new rules. Any later version stays on the stored rows until it has a branch.
 */
function billAggregateMode(run: { status?: unknown; aggregation?: unknown } | null | undefined): BillAggregateMode {
  if (!run || String(run.status ?? "") !== "published") return "live";
  switch (String(run.aggregation ?? "")) {
    case "dedup":
      return "frozen";
    default:
      return "legacy";
  }
}

function publishedRun(runs: Row[]): Row | undefined {
  return runs
    .filter((row) => String(row.status) === "published")
    .sort((a, b) => Number(b.published_at ?? 0) - Number(a.published_at ?? 0))[0];
}

function partitionRoles(rows: Row[]): Map<string, "counted" | "excluded" | "duplicate"> {
  const { counted, excluded } = partitionBillRows(rows);
  const roles = new Map<string, "counted" | "excluded" | "duplicate">();
  for (const row of rows) roles.set(String(row.channel_id), "duplicate");
  for (const row of counted) roles.set(String(row.channel_id), "counted");
  for (const row of excluded) roles.set(String(row.channel_id), "excluded");
  return roles;
}

function selectBillRows(
  merged: Row[],
  mode: BillAggregateMode,
  roles: Map<string, string> | null,
): { preferred: Row[]; excluded: Row[] } {
  if (mode === "legacy") return { preferred: merged, excluded: [] };
  if (mode === "frozen" && roles && roles.size > 0) {
    const preferred: Row[] = [];
    const excluded: Row[] = [];
    for (const row of merged) {
      const role = roles.get(String(row.channel_id));
      if (role === "counted") preferred.push(row);
      else if (role === "excluded") excluded.push(row);
    }
    return { preferred, excluded };
  }
  const parts = partitionBillRows(merged);
  return { preferred: parts.counted, excluded: parts.excluded };
}

type GroupSlice = {
  name: string;
  value: number;
  channels: number;
  readings: number;
  consumption: number | null;
  complete: boolean;
};

function groupSlices(rows: Row[], nameOf: (row: Row) => string, legacy: boolean): GroupSlice[] {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const name = nameOf(row) || "unknown";
    const list = buckets.get(name) ?? [];
    list.push(row);
    buckets.set(name, list);
  }
  const slices: GroupSlice[] = [];
  for (const [name, list] of buckets) {
    const rollup = rollupReadings(list);
    if (legacy) {
      const amounts = list.filter(legacyAmount);
      if (!amounts.length) continue;
      slices.push({
        name,
        value: amounts.reduce((sum, row) => sum + Number(row.consumption ?? 0), 0),
        channels: list.length,
        readings: rollup.readings,
        consumption: rollup.consumption,
        complete: rollup.complete,
      });
    } else if (rollup.channels > 0) {
      slices.push({
        name,
        value: rollup.consumption ?? 0,
        channels: rollup.channels,
        readings: rollup.readings,
        consumption: rollup.consumption,
        complete: rollup.complete,
      });
    }
  }
  return slices.sort((a, b) => b.value - a.value);
}

type DayTotal = {
  value: number | null;
  missing: boolean;
  readings: number;
  channels: number;
  complete: boolean;
};

/** The bill-table 合计 for one already-selected row set. No readings stay missing, never 0. */
function summarizeDay(rows: Row[]): DayTotal {
  const rollup = rollupReadings(rows);
  return {
    value: rollup.consumption,
    missing: rollup.readings === 0,
    readings: rollup.readings,
    channels: rollup.channels,
    complete: rollup.complete,
  };
}

type DayAssembly = {
  storedRows: Row[];
  merged: Row[];
  preferred: Row[];
  excluded: Row[];
  legacy: boolean;
  unpublished: boolean;
  total: DayTotal;
};

/** One day's rows, rule, and 合计. The open bill and every trend day both use this. */
async function assembleDay(
  billDay: string,
  scope: string,
  scopeParams: unknown[],
  run: Row | undefined,
  roles: Map<string, string> | null,
): Promise<DayAssembly> {
  const loaded = await loadMergedRows(billDay, scope, scopeParams);
  const mode = billAggregateMode(run);
  const legacy = mode === "legacy";
  const selected = selectBillRows(loaded.merged, mode, mode === "frozen" ? roles : null);
  return {
    storedRows: loaded.storedRows,
    merged: loaded.merged,
    preferred: selected.preferred,
    excluded: selected.excluded,
    legacy,
    unpublished: !run || String(run.status) !== "published",
    total: summarizeDay(selected.preferred),
  };
}

type SqlRead = {
  all(statement: string, params?: unknown[]): Promise<Row[]>;
};

const globalRead: SqlRead = { all: (statement, params = []) => dbAll(statement, params) };

async function loadMergedRows(billDay: string, scope: string, scopeParams: unknown[], db: SqlRead = globalRead): Promise<{ storedRows: Row[]; merged: Row[] }> {
  const rows = (await db.all(
    `SELECT r.*, c.name, c.group_name, c.balance, c.used_quota, c.today_quota, c.type, c.origin, c.upstream_id,
            COALESCE(g.disabled, 0) AS gateway_disabled, g.base_url AS gateway_base, u.name AS creator_name
     FROM billing_rows r
     JOIN channels c ON c.id = r.channel_id
     LEFT JOIN gateways g ON g.id = c.gateway_id
     LEFT JOIN users u ON u.id = c.creator_user_id
     WHERE r.bill_day = ? AND c.created_here = 1 ${scope}
     ORDER BY c.upstream_id`,
    [billDay, ...scopeParams],
  )) as Row[];
  const supplierIdRows = (await db.all(
    `SELECT c.id FROM channels c JOIN gateways g ON g.id = c.gateway_id WHERE g.kind = 'newapi_supplier' AND c.created_here = 1`,
  )) as { id: string }[];
  const supplierIds = new Set(supplierIdRows.map((row) => String(row.id)));
  const supplierChannels = (await db.all(
    `SELECT c.id, c.name, c.group_name, c.type, u.name AS creator_name, c.imported_at, c.upstream_id, c.used_quota, c.balance,
            COALESCE(g.disabled, 0) AS gateway_disabled, g.base_url AS gateway_base
     FROM channels c JOIN gateways g ON g.id = c.gateway_id LEFT JOIN users u ON u.id = c.creator_user_id
     WHERE g.kind = 'newapi_supplier' AND c.created_here = 1 ${scope}`,
    scopeParams,
  )) as Row[];
  const supplierMeta = new Map(supplierChannels.map((row) => [String(row.id), row]));
  const supplierRows = (await supplierBillRows(supplierChannels, billDay, db)).map((row) => {
    const source = supplierMeta.get(String(row.channel_id));
    return source
      ? { ...row, upstream_id: source.upstream_id, gateway_disabled: source.gateway_disabled, gateway_base: source.gateway_base }
      : row;
  });
  return {
    storedRows: rows,
    merged: [...rows.filter((row) => !supplierIds.has(String(row.channel_id))), ...supplierRows],
  };
}

/**
 * Published runs on or after DEDUP_RULE_START that were stored with a null rule version
 * get one live dedup pass, then the same freeze publishBill writes. Earlier null runs are left alone.
 * The stamp and the membership insert commit together. A second caller sees the stamp and does not write again.
 */
async function adoptNullDedupRuns(): Promise<void> {
  const pending = await dbAll(
    `SELECT DISTINCT bill_day FROM billing_runs
     WHERE status = 'published' AND aggregation IS NULL AND bill_day >= ?`,
    [DEDUP_RULE_START],
  );
  for (const row of pending) await adoptNullDedupDay(String(row.bill_day));
}

async function adoptNullDedupDay(billDay: string): Promise<void> {
  if (billDay < DEDUP_RULE_START) return;
  const lock = isPostgresUrl() ? " FOR UPDATE" : "";
  await dbTransaction(async (tx) => {
    const open = await tx.all(
      `SELECT baseline_day FROM billing_runs
       WHERE bill_day = ? AND status = 'published' AND aggregation IS NULL AND bill_day >= ?${lock}`,
      [billDay, DEDUP_RULE_START],
    );
    if (!open.length) return;
    const roles = partitionRoles((await loadMergedRows(billDay, "", [], tx)).merged);
    await tx.run("DELETE FROM billing_membership WHERE bill_day = ?", [billDay]);
    for (const [channelId, role] of roles) {
      await tx.run(
        `INSERT INTO billing_membership (bill_day, channel_id, role) VALUES (?, ?, ?)
         ON CONFLICT(bill_day, channel_id) DO NOTHING`,
        [billDay, channelId, role],
      );
    }
    const stamped = await tx.all(
      `UPDATE billing_runs SET aggregation = 'dedup'
       WHERE bill_day = ? AND status = 'published' AND aggregation IS NULL AND bill_day >= ?
       RETURNING baseline_day`,
      [billDay, DEDUP_RULE_START],
    );
    if (!stamped.length) throw new Error("dedup stamp lost");
  });
}

/**
 * Freeze the unscoped dedup decision for a bill that is being published for the first time.
 * Not inside a transaction: these writes are their own statements, so a later rollback cannot take them with it.
 */
async function freezeBillMembership(billDay: string): Promise<void> {
  const roles = partitionRoles((await loadMergedRows(billDay, "", [])).merged);
  await dbRun("DELETE FROM billing_membership WHERE bill_day = ?", [billDay]);
  for (const [channelId, role] of roles) {
    await dbRun("INSERT INTO billing_membership (bill_day, channel_id, role) VALUES (?, ?, ?)", [billDay, channelId, role]);
  }
}


/** 源 C 行：billDay 与次日两张 0 点快照的 USD 差（billing-pluggable §4/§9）。金额乘 QUOTA_PER_DOLLAR 入 consumption，沿用下游额度→美元格式化。 */
async function supplierBillRows(channels: Row[], billDay: string, db: SqlRead = globalRead): Promise<Row[]> {
  if (!channels.length) return [];
  const { addDays } = await import("./shanghai");
  const nextDay = addDays(billDay, 1);
  const ids = channels.map((channel) => String(channel.id));
  const placeholders = ids.map(() => "?").join(",");
  const snaps = (await db.all(
    `SELECT channel_id, day, quality, amount, fx_rate, upstream_source FROM billing_snapshots
     WHERE source_id = 'customer_billing' AND day IN (?, ?) AND channel_id IN (${placeholders})`,
    [billDay, nextDay, ...ids],
  )) as Row[];
  const byChannel = new Map<string, { today?: Row; next?: Row; firstDay?: string }>();
  const firstDays = (await db.all(
    `SELECT channel_id, MIN(day) AS first_day FROM billing_snapshots WHERE source_id = 'customer_billing' AND channel_id IN (${placeholders}) GROUP BY channel_id`,
    ids,
  )) as Row[];
  const firstBy = new Map(firstDays.map((row) => [String(row.channel_id), String(row.first_day)]));
  for (const snap of snaps) {
    const entry = byChannel.get(String(snap.channel_id)) ?? {};
    if (String(snap.day) === billDay) entry.today = snap;
    if (String(snap.day) === nextDay) entry.next = snap;
    byChannel.set(String(snap.channel_id), entry);
  }
  const out: Row[] = [];
  for (const channel of channels) {
    const id = String(channel.id);
    const entry = byChannel.get(id) ?? {};
    const first = firstBy.get(id);
    const base = {
      channel_id: id,
      name: channel.name,
      group_name: channel.group_name,
      creator_name: channel.creator_name,
      type: channel.type,
      origin: "imported",
      billing_mode: "snapshot",
      test_quota: 0,
      start_day: billDay,
      end_day: nextDay,
      span_days: 1,
      label: "",
      backfill_at: null,
      today_quota: null,
      used_quota: null,
    };
    if (first && first > billDay) {
      out.push({ ...base, kind: "no-baseline", consumption: null, quality: "missing", finding: "" });
      continue;
    }
    const toReading = (row: Row | undefined) =>
      row
        ? {
            quality: String(row.quality) as import("./billing-math").BillingQuality,
            amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
            unit: "usd" as const,
            fxRate: row.fx_rate === null || row.fx_rate === undefined ? null : Number(row.fx_rate),
            upstreamSource: String(row.upstream_source ?? ""),
            pulledAt: 0,
          }
        : null;
    const { dailyDiff } = await import("./billing-math");
    const diff = dailyDiff(toReading(entry.today), toReading(entry.next));
    if (diff.quality !== "ok" || diff.amount === null) {
      out.push({ ...base, kind: "unsynced", consumption: null, quality: diff.quality, finding: "" });
      continue;
    }
    const todayAmount = Number((entry.next as Row).amount) * QUOTA_PER_DOLLAR;
    const cumulative = Number((entry.next as Row).amount) * QUOTA_PER_DOLLAR;
    out.push({
      ...base,
      kind: "amount",
      consumption: diff.amount * QUOTA_PER_DOLLAR,
      today_quota: todayAmount === todayAmount ? diff.amount * QUOTA_PER_DOLLAR : null,
      used_quota: cumulative,
      quality: "ok",
      fx_rate: diff.fxRate,
      finding: diff.anomaly ? "anomaly" : "",
    });
  }
  return out;
}

export async function billingView(actor: SessionUser, options: BillingViewOptions = {}) {
  const unsyncedOnly = options.unsyncedOnly === true;
  await adoptNullDedupRuns();
  const clock = shanghaiClock();
  const live = await dbGet("SELECT * FROM billing_runs WHERE baseline_day = ?", [clock.day]);
  const requested = options.day?.trim() || "";
  const latest = ((await dbAll("SELECT * FROM billing_runs WHERE status = 'published' ORDER BY bill_day DESC LIMIT 1")) as Row[])[0];
  let publication: BillPublication;
  let showing: Row | undefined;
  let billDay: string | null;
  let mode: BillAggregateMode;
  if (!requested) {
    showing = latest;
    publication = showing ? "latest" : "none";
    billDay = showing ? String(showing.bill_day) : null;
    mode = billAggregateMode(showing);
  } else {
    const published = ((await dbAll(
      "SELECT * FROM billing_runs WHERE bill_day = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1",
      [requested],
    )) as Row[])[0];
    if (!published) {
      const open = ((await dbAll(
        "SELECT * FROM billing_runs WHERE bill_day = ? ORDER BY started_at DESC LIMIT 1",
        [requested],
      )) as Row[])[0];
      showing = open;
      publication = "unpublished";
      billDay = open ? requested : null;
      mode = billAggregateMode(open);
    } else {
      showing = published;
      publication = latest && String(latest.bill_day) === requested ? "latest" : "published";
      billDay = String(published.bill_day);
      mode = billAggregateMode(published);
    }
  }
  const scopedToSupplier = actor.role !== "admin" || Boolean(options.supplierId);
  const scopeSupplier = scopedToSupplier ? "AND c.creator_user_id = ?" : "";
  const scopeParams = scopedToSupplier ? [actor.role === "admin" ? String(options.supplierId) : scopeOwnerId(actor)] : [];
  const scope = scopeSupplier;
  const runMeta = (await dbAll("SELECT * FROM billing_runs")) as Row[];
  const rowDays = (await dbAll(
    `SELECT DISTINCT r.bill_day FROM billing_rows r JOIN channels c ON c.id = r.channel_id WHERE c.created_here = 1 ${scope}`,
    scopeParams,
  )) as Row[];
  const runsByDay = new Map<string, Row[]>();
  for (const run of runMeta) {
    const day = String(run.bill_day);
    const list = runsByDay.get(day) ?? [];
    list.push(run);
    runsByDay.set(day, list);
  }
  for (const row of rowDays) {
    const day = String(row.bill_day);
    if (!runsByDay.has(day)) runsByDay.set(day, []);
  }
  if (billDay && !runsByDay.has(billDay)) runsByDay.set(billDay, []);
  const membershipRows = (await dbAll("SELECT bill_day, channel_id, role FROM billing_membership")) as Row[];
  const rolesByDay = new Map<string, Map<string, string>>();
  for (const row of membershipRows) {
    const day = String(row.bill_day);
    const map = rolesByDay.get(day) ?? new Map<string, string>();
    map.set(String(row.channel_id), String(row.role));
    rolesByDay.set(day, map);
  }
  const runFor = (day: string) => {
    const list = runsByDay.get(day) ?? [];
    return publishedRun(list) ?? list.find((run) => String(run.status) !== "published") ?? list[0];
  };
  const assembled = new Map<string, DayAssembly>();
  for (const day of [...runsByDay.keys()].sort()) {
    assembled.set(day, await assembleDay(day, scope, scopeParams, runFor(day), rolesByDay.get(day) ?? null));
  }
  const current = billDay ? assembled.get(billDay) : undefined;
  const rows = current?.storedRows ?? [];
  const merged = current?.merged ?? [];
  const legacy = current ? current.legacy : mode === "legacy";
  const preferred = current?.preferred ?? [];
  const excluded = current?.excluded ?? [];
  const dayTotal = current?.total ?? summarizeDay([]);
  const visible = unsyncedOnly ? preferred.filter((row) => row.kind !== "amount") : preferred;
  const markers = billDay ? await rebindMarkers(visible.map((row) => String(row.channel_id)), billDay) : new Map();
  const unsynced = preferred.filter((row) => row.kind !== "amount");
  const disabledGateway = legacy
    ? { channels: 0, readings: 0, consumption: null, complete: true }
    : rollupReadings(excluded);
  const balanceRows = legacy ? merged : preferred;
  const nameOf = (key: string) => (row: Row) => String(row[key] ?? "") || "unknown";
  const counts = live
    ? await scopedCounts(String(live.baseline_day), actor)
    : { total: 0, ok: 0, failed: 0 };
  let etaMinutes: number | undefined;
  if (live?.status === "collecting" && counts.total > counts.ok) {
    const limits = await rateLimits();
    const gateways = (await dbAll("SELECT id FROM gateways WHERE disabled = 0")) as Row[];
    const perMin = Math.max(1, limits.gatewayPerMin - LIST_SYNC_RESERVE_PER_MIN) * Math.max(1, gateways.length);
    etaMinutes = Math.max(1, Math.ceil(((counts.total - counts.ok) * CALLS_PER_CHANNEL) / perMin));
  }
  const failedIds = live
    ? ((await dbAll(
        `SELECT a.channel_id FROM billing_attempts a JOIN channels c ON c.id = a.channel_id
         WHERE a.baseline_day = ? AND a.status = 'failed' AND c.created_here = 1 ${scope}`,
        [String(live.baseline_day), ...scopeParams],
      )) as { channel_id: string }[]).map((row) => row.channel_id)
    : [];
  const preferredIds = new Set(preferred.map((row) => String(row.channel_id)));
  const reading = {
    channels: dayTotal.channels,
    readings: dayTotal.readings,
    consumption: dayTotal.value,
    complete: dayTotal.complete,
  };
  return {
    copy: "schedule",
    requestedDay: requested || null,
    publication,
    aggregation: legacy ? "legacy" : "dedup",
    collecting: live?.status === "collecting",
    suppliers:
      actor.role === "admin"
        ? ((await dbAll(
            `SELECT DISTINCT u.id, u.name FROM channels c JOIN users u ON u.id = c.creator_user_id
             WHERE c.created_here = 1 ORDER BY u.name`,
          )) as Row[]).map((row) => ({ id: String(row.id), name: String(row.name ?? "") }))
        : [],
    progress: { ...counts, etaMinutes },
    failedIds,
    publishedAt: showing?.published_at ? Number(showing.published_at) : null,
    publishedLabel: formatShanghaiTime(showing?.published_at ? Number(showing.published_at) : null),
    billDay,
    unsyncedCount: unsynced.length,
    incomplete: unsynced.length > 0,
    disabledGateway,
    reading,
    totalConsumption: dayTotal.value ?? 0,
    totalTestQuota: balanceRows.reduce((sum, row) => sum + Number(row.test_quota ?? 0), 0),
    showTestLine: rows.some((row) => (legacy || preferredIds.has(String(row.channel_id))) && String(row.billing_mode ?? "") !== "snapshot"),
    remainingBalance: balanceRows.reduce((sum, row) => sum + (row.balance === null || row.balance === undefined ? 0 : Number(row.balance)), 0),
    usedUsd: balanceRows.reduce((sum, row) => sum + Number(row.used_quota ?? 0), 0) / QUOTA_PER_DOLLAR,
    byType: groupSlices(preferred, (row) => channelTypeName(Number(row.type ?? 0)), legacy),
    bySupplier: groupSlices(preferred, nameOf("creator_name"), legacy),
    byChannel: groupSlices(preferred, nameOf("name"), legacy).slice(0, 8),
    byGroup: groupSlices(preferred, nameOf("group_name"), legacy),
    trend: [...assembled.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, assembly]) => ({
      day,
      label: "",
      spanDays: 1,
      value: assembly.total.missing ? null : assembly.total.value,
      span: false,
      missing: assembly.total.missing,
      unpublished: assembly.unpublished,
    })),
    rows: visible.map((row) => ({
      id: String(row.channel_id),
      name: String(row.name ?? ""),
      group: String(row.group_name ?? ""),
      supplier: String(row.creator_name ?? "") || "unknown",
      consumption: row.consumption === null || row.consumption === undefined ? null : Number(row.consumption),
      today:
        String(row.billing_mode ?? "") === "snapshot"
          ? row.consumption === null || row.consumption === undefined
            ? null
            : Number(row.consumption)
          : row.today_quota === null || row.today_quota === undefined
            ? null
            : Number(row.today_quota),
      billingMode: String(row.billing_mode ?? ""),
      quality: String(row.quality ?? ""),
      imported: String(row.origin ?? "") === "imported",
      before:
        row.used_quota === null || row.used_quota === undefined || row.today_quota === null || row.today_quota === undefined
          ? null
          : Number(row.used_quota) - Number(row.today_quota),
      cumulative: row.used_quota === null || row.used_quota === undefined ? null : Number(row.used_quota),
      typeName: channelTypeName(Number(row.type ?? 0)),
      type: Number(row.type ?? 0),
      testQuota: Number(row.test_quota ?? 0),
      kind: String(row.kind),
      label: row.label ? String(row.label) : "",
      finding: String(row.finding ?? ""),
      span: `${row.start_day}–${row.end_day}`,
      spanDays: Number(row.span_days ?? 1),
      backfillAt: row.backfill_at ? Number(row.backfill_at) : null,
      gray: row.kind !== "amount",
      rebindFrom: markers.get(String(row.channel_id))?.from ?? null,
      rebindTo: markers.get(String(row.channel_id))?.to ?? null,
      oldSegmentQuota: markers.get(String(row.channel_id))?.closeQuota ?? null,
      oldSegmentStatus: markers.get(String(row.channel_id))?.closeStatus ?? "",
    })),
  };
}

async function scopedCounts(baselineDay: string, actor: SessionUser): Promise<{ total: number; ok: number; failed: number }> {
  const scope = actor.role === "admin" ? "" : "AND c.creator_user_id = ?";
  const params = actor.role === "admin" ? [] : [scopeOwnerId(actor)];
  const total = Number((await dbGet(`SELECT COUNT(*) AS n FROM channels c WHERE c.created_here = 1 ${scope}`, params))?.n ?? 0);
  const ok = Number(
    (await dbGet(
      `SELECT COUNT(*) AS n FROM channel_baselines b JOIN channels c ON c.id = b.channel_id WHERE b.day = ? AND c.created_here = 1 ${scope}`,
      [baselineDay, ...params],
    ))?.n ?? 0,
  );
  const failed = Number(
    (await dbGet(
      `SELECT COUNT(*) AS n FROM billing_attempts a JOIN channels c ON c.id = a.channel_id WHERE a.baseline_day = ? AND a.status = 'failed' AND c.created_here = 1 ${scope}`,
      [baselineDay, ...params],
    ))?.n ?? 0,
  );
  return { total, ok, failed };
}

export async function reconView(actor: SessionUser) {
  const published = (await dbAll("SELECT * FROM billing_runs WHERE status = 'published' ORDER BY bill_day DESC LIMIT 1")) as Row[];
  const showing = published[0];
  const billDay = showing ? String(showing.bill_day) : null;
  const scope = actor.role === "admin" ? "" : "AND c.creator_user_id = ?";
  const scopeParams = actor.role === "admin" ? [] : [scopeOwnerId(actor)];
  const rows = billDay
    ? ((await dbAll(
        `SELECT r.*, c.name, c.group_name, u.name AS creator_name
         FROM billing_rows r
         JOIN channels c ON c.id = r.channel_id
         LEFT JOIN users u ON u.id = c.creator_user_id
         WHERE r.bill_day = ? AND c.created_here = 1 ${scope}
         ORDER BY c.upstream_id`,
        [billDay, ...scopeParams],
      )) as Row[])
    : [];
  const mapped = rows.map((row) => {
    const consumption = row.consumption === null || row.consumption === undefined ? null : Number(row.consumption);
    const logQuota = row.log_quota === null || row.log_quota === undefined ? null : Number(row.log_quota);
    return {
      id: String(row.channel_id),
      name: String(row.name ?? ""),
      group: String(row.group_name ?? ""),
      supplier: String(row.creator_name ?? "") || "unknown",
      span: `${row.start_day}–${row.end_day}`,
      spanDays: Number(row.span_days ?? 1),
      kind: String(row.kind),
      label: row.label ? String(row.label) : "",
      finding: String(row.finding ?? ""),
      consumption,
      logQuota,
      delta: consumption === null || logQuota === null ? null : consumption - logQuota,
      backfillAt: row.backfill_at ? Number(row.backfill_at) : null,
      gray: row.kind !== "amount",
    };
  });
  const findingOf = (row: (typeof mapped)[number]) => (row.finding === "异常" ? "anomaly" : row.finding === "网关上找不到" ? "missing" : row.finding);
  return {
    billDay,
    publishedAt: showing?.published_at ? Number(showing.published_at) : null,
    matched: mapped.filter((row) => row.kind === "amount" && !findingOf(row)).length,
    anomaly: mapped.filter((row) => findingOf(row) === "anomaly").length,
    missing: mapped.filter((row) => findingOf(row) === "missing").length,
    unsynced: mapped.filter((row) => row.kind !== "amount").length,
    rows: mapped,
  };
}

export type SnapshotCell = { kind: "amount"; quota: number } | { kind: "missing" } | { kind: "before" };

/** Last 7 Shanghai days of snapshot deltas for one seller gateway. Not a reconciliation. */
export async function sellerSnapshotGrid(actor: SessionUser, gatewayId: string) {
  const gateway = await getGateway(gatewayId);
  if (!gateway || gateway.kind !== "newapi_seller") return null;
  if (actor.role !== "admin" && gateway.ownerUserId !== scopeOwnerId(actor)) return null;
  const today = shanghaiClock().day;
  const days = Array.from({ length: 7 }, (_, index) => addDays(today, index - 7));
  const scope = actor.role === "admin" ? "" : "AND creator_user_id = ?";
  const params = actor.role === "admin" ? [gatewayId] : [gatewayId, scopeOwnerId(actor)];
  const channels = (await dbAll(
    `SELECT id, name, upstream_id, origin FROM channels WHERE gateway_id = ? AND created_here = 1 ${scope} ORDER BY upstream_id`,
    params,
  )) as Row[];
  const rows = [];
  for (const channel of channels) {
    const baselines = await baselinesFor(String(channel.id));
    const first = baselines.map((item) => item.day).sort()[0];
    const cells: SnapshotCell[] = days.map((day) => {
      if (!first || day < first) return { kind: "before" };
      const resolved = resolveSellerConsumption(day, baselines);
      if (resolved.kind === "amount") return { kind: "amount", quota: resolved.consumption };
      if (resolved.kind === "skip") return { kind: "before" };
      return { kind: "missing" };
    });
    const amounts = cells.flatMap((cell) => (cell.kind === "amount" ? [cell.quota] : []));
    rows.push({
      id: String(channel.id),
      name: String(channel.name ?? ""),
      upstreamId: Number(channel.upstream_id),
      imported: String(channel.origin ?? "") === "imported",
      cells,
      total: amounts.length ? amounts.reduce((sum, value) => sum + value, 0) : null,
    });
  }
  return { gatewayId: gateway.id, gatewayName: gateway.name, days, rows };
}
