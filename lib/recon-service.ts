import { evaluateRecon, reconDisplayStatus, rollupFigures, todayExcludingTests, type ReconCheckStatus } from "./billing-math";
import { dbAll, dbGet, dbRun } from "./db";
import { getGateway } from "./gateways";
import { reconPolicy } from "./settings";
import { addDays, logWindow } from "./shanghai";
import type { SessionUser } from "./types";

type Row = Record<string, unknown>;
import { consumeQuota, gatewayConsumeQuota, UpstreamFailure } from "./upstream";

export type ReconAdjustment = { id: string; amountQuota: number; note: string; createdAt: number };

export type ReconNode = {
  id: string;
  kind: "gateway" | "group" | "channel";
  name: string;
  billDay: string;
  spanLabel: string;
  ours: number | null;
  logs: number | null;
  delta: number | null;
  deltaPct: number | null;
  status: ReconCheckStatus | "pending";
  reason: string;
  quotaPerUnit: number;
  supplierAction: string;
  supplierNote: string;
  adminResolution: string;
  adminNote: string;
  adjustments: ReconAdjustment[];
  locked: boolean;
  children: ReconNode[];
};

type GatewayLog = { quota: number | null; timedOut: boolean; quiet: boolean };

const gatewayReads = new Map<string, Promise<GatewayLog>>();

function fail(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

async function periodLocked(month: string): Promise<boolean> {
  const row = await dbGet("SELECT locked FROM recon_periods WHERE month = ?", [month]);
  return Number(row?.locked) === 1;
}

async function readTests(gatewayId: string, upstreamId: number | null, start: number, end: number): Promise<number | null> {
  const gateway = await getGateway(gatewayId);
  if (!gateway) return null;
  const english = await consumeQuota(gateway, upstreamId, start, end, "Model test");
  const chinese = await consumeQuota(gateway, upstreamId, start, end, "模型测试");
  if (english === null && chinese === null) return null;
  return (english ?? 0) + (chinese ?? 0);
}

async function readGatewayLog(gatewayId: string, billDay: string, start: number, end: number): Promise<GatewayLog> {
  const key = `${gatewayId}:${billDay}:${start}:${end}`;
  const cached = gatewayReads.get(key);
  if (cached) return cached;
  const job = (async (): Promise<GatewayLog> => {
    const gateway = await getGateway(gatewayId);
    if (!gateway) return { quota: null, timedOut: false, quiet: false };
    try {
      const total = await gatewayConsumeQuota(gateway, start, end);
      if (total === null) return { quota: null, timedOut: true, quiet: false };
      const tests = await readTests(gatewayId, null, start, end);
      const quota = todayExcludingTests(total, tests ?? 0);
      return { quota, timedOut: false, quiet: quota === 0 };
    } catch (error) {
      const timedOut = !(error instanceof UpstreamFailure) || error.retryable;
      return { quota: null, timedOut, quiet: false };
    }
  })();
  gatewayReads.set(key, job);
  return job;
}

async function readChannelLog(gatewayId: string, upstreamId: number, start: number, end: number, missing: boolean): Promise<{ quota: number | null; timedOut: boolean }> {
  if (missing) return { quota: null, timedOut: false };
  const gateway = await getGateway(gatewayId);
  if (!gateway) return { quota: null, timedOut: false };
  try {
    const total = await consumeQuota(gateway, upstreamId, start, end);
    if (total === null) return { quota: null, timedOut: true };
    const tests = await readTests(gatewayId, upstreamId, start, end);
    return { quota: todayExcludingTests(total, tests ?? 0), timedOut: false };
  } catch (error) {
    const timedOut = !(error instanceof UpstreamFailure) || error.retryable;
    return { quota: null, timedOut };
  }
}

async function zeroStreak(channelId: string, billDay: string): Promise<number> {
  const rows = (await dbAll(
    "SELECT kind, consumption FROM billing_rows WHERE channel_id = ? AND bill_day <= ? ORDER BY bill_day DESC",
    [channelId, billDay],
  )) as Row[];
  let streak = 0;
  for (const row of rows) {
    if (String(row.kind) !== "amount" || row.consumption === null || row.consumption === undefined) break;
    if (Math.abs(Number(row.consumption)) > 0.5) break;
    streak += 1;
  }
  return streak;
}

export async function syncReconChannel(billDay: string, channelId: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDay)) return;
  if (await periodLocked(billDay.slice(0, 7))) return;
  const bill = await dbGet("SELECT * FROM billing_rows WHERE bill_day = ? AND channel_id = ?", [billDay, channelId]);
  if (!bill) {
    await dbRun(
      "DELETE FROM recon_rows WHERE bill_day = ? AND channel_id = ? AND supplier_action = '' AND admin_resolution = ''",
      [billDay, channelId],
    );
    return;
  }
  const channel = await dbGet("SELECT * FROM channels WHERE id = ?", [channelId]);
  if (!channel || Number(channel.created_here) !== 1) return;
  const policy = await reconPolicy();
  const startDay = String(bill.start_day);
  const endDay = String(bill.end_day);
  const prior = await dbGet("SELECT baseline FROM channel_baselines WHERE channel_id = ? AND day = ?", [channelId, startDay]);
  const close = await dbGet("SELECT baseline FROM channel_baselines WHERE channel_id = ? AND day = ?", [channelId, addDays(endDay, 1)]);
  const consumption = bill.kind === "amount" && bill.consumption !== null && bill.consumption !== undefined ? Number(bill.consumption) : null;
  const window = logWindow(startDay, endDay);
  const gatewayId = String(channel.gateway_id);
  const missing = Number(channel.upstream_missing) === 1;
  const gatewayLog = await readGatewayLog(gatewayId, billDay, window.start, window.end);
  if (startDay === billDay && endDay === billDay) {
    await dbRun(
      `INSERT INTO recon_gateway_days (gateway_id, bill_day, log_quota, timed_out) VALUES (?, ?, ?, ?)
       ON CONFLICT(gateway_id, bill_day) DO UPDATE SET log_quota = excluded.log_quota, timed_out = excluded.timed_out`,
      [gatewayId, billDay, gatewayLog.quota, gatewayLog.timedOut ? 1 : 0],
    );
  }
  const channelLog = await readChannelLog(gatewayId, Number(channel.upstream_id), window.start, window.end, missing);
  const streak = await zeroStreak(channelId, billDay);
  const evaluation = evaluateRecon({
    consumption,
    yesterdayBaseline: prior ? Number(prior.baseline) : null,
    todayBaseline: close ? Number(close.baseline) : null,
    logQuota: channelLog.quota,
    logTimedOut: channelLog.timedOut || (gatewayLog.timedOut && channelLog.quota === null),
    gatewayLogsQuiet: gatewayLog.quiet,
    upstreamMissing: missing,
    channelStatus: Number(channel.status),
    zeroStreak: streak,
    zeroDaysLimit: policy.zeroDays,
    tolerance: policy.tolerance,
  });
  const now = Date.now();
  await dbRun(
    `INSERT INTO recon_rows (
      id, bill_day, channel_id, gateway_id, start_day, end_day, span_days, label,
      ours_quota, log_quota, delta, delta_pct, yesterday_baseline, today_baseline,
      channel_status, zero_streak, gateway_quiet, log_timed_out, upstream_missing,
      check_status, reason, tolerance, quota_per_unit, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bill_day, channel_id) DO UPDATE SET
      gateway_id = excluded.gateway_id, start_day = excluded.start_day, end_day = excluded.end_day,
      span_days = excluded.span_days, label = excluded.label, ours_quota = excluded.ours_quota,
      log_quota = excluded.log_quota, delta = excluded.delta, delta_pct = excluded.delta_pct,
      yesterday_baseline = excluded.yesterday_baseline, today_baseline = excluded.today_baseline,
      channel_status = excluded.channel_status, zero_streak = excluded.zero_streak,
      gateway_quiet = excluded.gateway_quiet, log_timed_out = excluded.log_timed_out,
      upstream_missing = excluded.upstream_missing, check_status = excluded.check_status,
      reason = excluded.reason, tolerance = excluded.tolerance, quota_per_unit = excluded.quota_per_unit,
      updated_at = excluded.updated_at`,
    [
      `${billDay}:${channelId}`,
      billDay,
      channelId,
      gatewayId,
      startDay,
      endDay,
      Number(bill.span_days ?? 1),
      String(bill.label ?? ""),
      consumption,
      channelLog.quota,
      evaluation.delta,
      evaluation.deltaPct,
      prior ? Number(prior.baseline) : null,
      close ? Number(close.baseline) : null,
      Number(channel.status),
      streak,
      gatewayLog.quiet ? 1 : 0,
      channelLog.timedOut ? 1 : 0,
      missing ? 1 : 0,
      evaluation.status,
      evaluation.reason,
      policy.tolerance,
      policy.quotaPerUnit,
      now,
    ],
  );
}

async function ownedRow(actor: SessionUser, id: string): Promise<Row> {
  const row = await dbGet(
    `SELECT r.*, c.creator_user_id FROM recon_rows r JOIN channels c ON c.id = r.channel_id WHERE r.id = ?`,
    [id],
  );
  if (!row) throw fail("reconMissing", 404);
  if (actor.role !== "admin" && String(row.creator_user_id) !== actor.id) throw fail("forbidden", 403);
  return row;
}

export async function applyReconAction(actor: SessionUser, body: Record<string, unknown>): Promise<void> {
  const action = String(body.action ?? "");
  if (action === "lock") {
    if (actor.role !== "admin") throw fail("forbidden", 403);
    const month = String(body.month ?? "");
    if (!/^\d{4}-\d{2}$/.test(month)) throw fail("reconMonth", 400);
    await dbRun(
      `INSERT INTO recon_periods (month, locked, locked_at, locked_by, note) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET locked = 1, locked_at = excluded.locked_at, locked_by = excluded.locked_by, note = excluded.note`,
      [month, Date.now(), actor.id, String(body.note ?? "").slice(0, 500)],
    );
    return;
  }
  const id = String(body.id ?? "");
  const row = await ownedRow(actor, id);
  const locked = await periodLocked(String(row.bill_day).slice(0, 7));
  const note = String(body.note ?? "").trim().slice(0, 500);
  if (action === "adjust") {
    if (actor.role !== "admin") throw fail("forbidden", 403);
    const amount = Number(body.amountQuota);
    if (!Number.isFinite(amount)) throw fail("reconAmount", 400);
    if (!note) throw fail("reconNote", 400);
    await dbRun(
      "INSERT INTO recon_adjustments (id, bill_day, channel_id, amount_quota, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), row.bill_day, row.channel_id, amount, note, actor.id, Date.now()],
    );
    return;
  }
  if (locked) throw fail("periodLocked", 409);
  if (action === "confirm" || action === "dispute") {
    if (actor.role === "admin") throw fail("forbidden", 403);
    if (action === "dispute" && !note) throw fail("reconNote", 400);
    await dbRun(
      "UPDATE recon_rows SET supplier_action = ?, supplier_note = ?, supplier_user_id = ?, supplier_at = ?, updated_at = ? WHERE id = ?",
      [action === "confirm" ? "confirmed" : "disputed", note, actor.id, Date.now(), Date.now(), id],
    );
    return;
  }
  if (action === "resolve") {
    if (actor.role !== "admin") throw fail("forbidden", 403);
    if (String(row.supplier_action) !== "disputed") throw fail("reconNothing", 400);
    await dbRun(
      "UPDATE recon_rows SET admin_resolution = 'upheld', admin_note = ?, admin_user_id = ?, admin_at = ?, updated_at = ? WHERE id = ?",
      [note, actor.id, Date.now(), Date.now(), id],
    );
    return;
  }
  throw fail("reconAction", 400);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function reconPage(actor: SessionUser, month: string | null) {
  const days = (await dbAll("SELECT DISTINCT bill_day FROM billing_runs WHERE status = 'published' ORDER BY bill_day DESC")) as { bill_day: string }[];
  const months = [...new Set(days.map((row) => String(row.bill_day).slice(0, 7)))];
  const selected = month && months.includes(month) ? month : months[0] ?? "";
  const inMonth = days.map((row) => String(row.bill_day)).filter((day) => day.startsWith(selected));
  for (const day of inMonth) {
    const pending = await dbGet(
      `SELECT r.channel_id FROM billing_rows r
       JOIN channels c ON c.id = r.channel_id
       LEFT JOIN recon_rows q ON q.bill_day = r.bill_day AND q.channel_id = r.channel_id
       WHERE r.bill_day = ? AND c.created_here = 1 AND q.id IS NULL LIMIT 1`,
      [day],
    );
    if (!pending) continue;
    const channels = (await dbAll(
      `SELECT r.channel_id FROM billing_rows r JOIN channels c ON c.id = r.channel_id
       LEFT JOIN recon_rows q ON q.bill_day = r.bill_day AND q.channel_id = r.channel_id
       WHERE r.bill_day = ? AND c.created_here = 1 AND q.id IS NULL`,
      [day],
    )) as { channel_id: string }[];
    for (const channel of channels) await syncReconChannel(day, channel.channel_id);
  }
  const scope = actor.role === "admin" ? "" : "AND c.creator_user_id = ?";
  const params = selected ? [selected, ...(actor.role === "admin" ? [] : [actor.id])] : [];
  const rows = selected
    ? ((await dbAll(
        `SELECT q.*, c.name, c.group_name, c.upstream_id, g.name AS gateway_name, u.name AS supplier_name
         FROM recon_rows q
         JOIN channels c ON c.id = q.channel_id
         JOIN gateways g ON g.id = q.gateway_id
         LEFT JOIN users u ON u.id = c.creator_user_id
         WHERE q.bill_day LIKE ? AND c.created_here = 1 ${scope}
         ORDER BY g.name, c.group_name, c.upstream_id, q.bill_day`,
        [`${selected}%`, ...params.slice(1)],
      )) as Row[])
    : [];
  const adjustments = selected
    ? ((await dbAll(
        `SELECT a.* FROM recon_adjustments a JOIN channels c ON c.id = a.channel_id
         WHERE a.bill_day LIKE ? ${scope} ORDER BY a.created_at`,
        [`${selected}%`, ...(actor.role === "admin" ? [] : [actor.id])],
      )) as Row[])
    : [];
  const byChannel = new Map<string, ReconAdjustment[]>();
  for (const item of adjustments) {
    const key = `${item.bill_day}:${item.channel_id}`;
    const list = byChannel.get(key) ?? [];
    list.push({ id: String(item.id), amountQuota: Number(item.amount_quota), note: String(item.note ?? ""), createdAt: Number(item.created_at) });
    byChannel.set(key, list);
  }
  const locked = selected ? await periodLocked(selected) : false;
  const policy = await reconPolicy();
  const gatewayLogs = selected
    ? ((await dbAll("SELECT * FROM recon_gateway_days WHERE bill_day LIKE ?", [`${selected}%`])) as Row[])
    : [];
  const channels: ReconNode[] = rows.map((row) => {
    const check = String(row.check_status) as ReconCheckStatus;
    const status = reconDisplayStatus(check, String(row.supplier_action ?? ""), String(row.admin_resolution ?? ""));
    return {
      id: String(row.id),
      kind: "channel",
      name: String(row.name ?? ""),
      billDay: String(row.bill_day),
      spanLabel: String(row.label ?? ""),
      ours: num(row.ours_quota),
      logs: num(row.log_quota),
      delta: num(row.delta),
      deltaPct: num(row.delta_pct),
      status,
      reason: String(row.reason ?? ""),
      quotaPerUnit: Number(row.quota_per_unit) || policy.quotaPerUnit,
      supplierAction: String(row.supplier_action ?? ""),
      supplierNote: String(row.supplier_note ?? ""),
      adminResolution: String(row.admin_resolution ?? ""),
      adminNote: String(row.admin_note ?? ""),
      adjustments: byChannel.get(String(row.id)) ?? [],
      locked,
      children: [],
      gatewayId: String(row.gateway_id),
      gatewayName: String(row.gateway_name ?? ""),
      group: String(row.group_name ?? ""),
      supplier: String(row.supplier_name ?? ""),
    } as ReconNode & { gatewayId: string; gatewayName: string; group: string; supplier: string };
  });
  const tree = new Map<string, { name: string; groups: Map<string, ReconNode[]> }>();
  for (const row of channels as (ReconNode & { gatewayId: string; gatewayName: string; group: string })[]) {
    const bucket = tree.get(row.gatewayId) ?? { name: row.gatewayName, groups: new Map() };
    const list = bucket.groups.get(row.group) ?? [];
    list.push(row);
    bucket.groups.set(row.group, list);
    tree.set(row.gatewayId, bucket);
  }
  const gateways: ReconNode[] = [...tree.entries()].map(([gatewayId, bucket]) => {
    const groups: ReconNode[] = [...bucket.groups.entries()].map(([group, children]) => {
      const ours = sum(children.map((item) => item.ours));
      const logs = sum(children.map((item) => item.logs));
      const rolled = rollupFigures({
        ours: ours ?? 0,
        logs,
        timedOut: children.some((item) => item.status === "unsynced" && item.logs === null),
        quiet: false,
        tolerance: policy.tolerance,
      });
      return {
        id: `${gatewayId}:${group}`,
        kind: "group",
        name: group || "default",
        billDay: selected,
        spanLabel: "",
        ours,
        logs,
        delta: rolled.delta,
        deltaPct: rolled.deltaPct,
        status: children.some((item) => item.status === "pending") ? "pending" : rolled.status,
        reason: rolled.reason,
        quotaPerUnit: policy.quotaPerUnit,
        supplierAction: "",
        supplierNote: "",
        adminResolution: "",
        adminNote: "",
        adjustments: [],
        locked,
        children,
      };
    });
    const ours = sum(groups.map((item) => item.ours));
    const gatewaySlice = gatewayLogs.filter((item) => String(item.gateway_id) === gatewayId);
    const timedOut = gatewaySlice.some((item) => Number(item.timed_out) === 1);
    const fullLog = actor.role === "admin" && !timedOut ? sum(gatewaySlice.map((item) => num(item.log_quota))) : sum(groups.map((item) => item.logs));
    const quiet = actor.role === "admin" && fullLog === 0 && gatewaySlice.length > 0 && !timedOut;
    const rolled = rollupFigures({ ours: ours ?? 0, logs: fullLog, timedOut, quiet, tolerance: policy.tolerance });
    return {
      id: gatewayId,
      kind: "gateway" as const,
      name: bucket.name,
      billDay: selected,
      spanLabel: "",
      ours,
      logs: fullLog,
      delta: rolled.delta,
      deltaPct: rolled.deltaPct,
      status: groups.some((item) => item.children.some((child) => child.status === "pending")) ? "pending" : rolled.status,
      reason: rolled.reason,
      quotaPerUnit: policy.quotaPerUnit,
      supplierAction: "",
      supplierNote: "",
      adminResolution: "",
      adminNote: "",
      adjustments: [],
      locked,
      children: groups,
    };
  });
  const leaves = channels;
  const count = (status: string) => leaves.filter((item) => item.status === status).length;
  const missingScope = actor.role === "admin" ? "" : "AND c.creator_user_id = ?";
  const missingRows = (await dbAll(
    `SELECT c.id, c.name, c.upstream_id, g.name AS gateway_name, COALESCE(u.name, '') AS owner
     FROM channels c
     JOIN gateways g ON g.id = c.gateway_id
     LEFT JOIN users u ON u.id = c.creator_user_id
     WHERE c.created_here = 1 AND c.upstream_missing = 1 AND c.missing_handled = 0 ${missingScope}
     ORDER BY c.upstream_id`,
    actor.role === "admin" ? [] : [actor.id],
  )) as Row[];
  return {
    month: selected,
    months,
    locked,
    tolerancePct: policy.tolerance * 100,
    quotaPerUnit: policy.quotaPerUnit,
    counts: {
      match: count("match"),
      anomaly: count("anomaly"),
      pending: count("pending"),
      unsynced: count("unsynced"),
      missingLogs: count("missing_logs"),
    },
    gateways,
    missing: missingRows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      upstreamId: Number(row.upstream_id),
      gatewayName: String(row.gateway_name ?? ""),
      owner: String(row.owner ?? ""),
    })),
    manualTolerancePct: policy.manualTolerance * 100,
  };
}

function sum(values: (number | null)[]): number | null {
  if (values.some((item) => item === null)) return values.every((item) => item === null) ? null : values.reduce<number>((total, item) => total + (item ?? 0), 0);
  return values.reduce<number>((total, item) => total + (item ?? 0), 0);
}

export async function reconCsv(actor: SessionUser, month: string): Promise<string> {
  const page = await reconPage(actor, month);
  const header = ["month", "bill_day", "gateway", "group", "channel", "ours_quota", "log_quota", "delta", "delta_pct", "status", "reason", "supplier_action", "supplier_note", "admin_resolution", "admin_note", "adjustments"];
  const lines = [header.join(",")];
  for (const gateway of page.gateways) {
    for (const group of gateway.children) {
      for (const row of group.children) {
        const cells = [
          page.month,
          row.billDay,
          gateway.name,
          group.name,
          row.name,
          row.ours ?? "",
          row.logs ?? "",
          row.delta ?? "",
          row.deltaPct ?? "",
          row.status,
          row.reason,
          row.supplierAction,
          row.supplierNote,
          row.adminResolution,
          row.adminNote,
          row.adjustments.map((item) => `${item.amountQuota} ${item.note}`).join(" | "),
        ];
        lines.push(cells.map(csvCell).join(","));
      }
    }
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
