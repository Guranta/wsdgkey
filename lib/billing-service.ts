import { deriveBaseline, reconcileFinding, resolveConsumption, todayExcludingTests, type BaselinePoint } from "./billing-math";
import { channelTypeName } from "./channel-types";
import { QUOTA_PER_DOLLAR } from "./format";
import { dbAll, dbGet, dbRun } from "./db";
import { getGateway } from "./gateways";
import { syncReconChannel } from "./recon-service";
import { rebindMarkers } from "./rebind";
import { addDays, formatShanghaiTime, logWindow, shanghaiClock, shanghaiMidnight } from "./shanghai";
import type { SessionUser } from "./types";
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

export async function pullChannelBaseline(channelId: string, baselineDay: string): Promise<"ok" | "failed"> {
  const row = (await dbGet("SELECT * FROM channels WHERE id = ?", [channelId])) as Row | undefined;
  if (!row) return "failed";
  const gateway = await getGateway(String(row.gateway_id));
  if (!gateway) return "failed";
  if (Number(row.created_here) !== 1) return "failed";
  const upstreamId = Number(row.upstream_id);
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
    if (today !== null) {
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
  const channel = await dbGet("SELECT created_here, upstream_missing FROM channels WHERE id = ?", [channelId]);
  if (!channel || Number(channel.created_here) !== 1) {
    await dbRun("DELETE FROM billing_rows WHERE bill_day = ? AND channel_id = ?", [billDay, channelId]);
    await syncReconChannel(billDay, channelId);
    return;
  }
  const resolved = resolveConsumption(billDay, await baselinesFor(channelId));
  const id = `${billDay}:${channelId}`;
  if (resolved.kind === "skip") {
    await dbRun("DELETE FROM billing_rows WHERE bill_day = ? AND channel_id = ?", [billDay, channelId]);
    await syncReconChannel(billDay, channelId);
    return;
  }
  const missing = Number(channel.upstream_missing) === 1;
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

export async function publishBill(billDay: string, baselineDay: string): Promise<void> {
  const channels = (await dbAll("SELECT id FROM channels WHERE created_here = 1")) as { id: string }[];
  for (const channel of channels) await writeRow(channel.id, billDay, null);
  const counts = await countRun(baselineDay);
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, total_count, ok_count, failed_count)
     VALUES (?, ?, 'published', ?, ?, ?, ?, ?)
     ON CONFLICT(baseline_day) DO UPDATE SET status = 'published', published_at = excluded.published_at,
       total_count = excluded.total_count, ok_count = excluded.ok_count, failed_count = excluded.failed_count`,
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

export async function channelsMissingBaseline(baselineDay: string): Promise<string[]> {
  const rows = (await dbAll(
    `SELECT c.id FROM channels c
     LEFT JOIN channel_baselines b ON b.channel_id = c.id AND b.day = ?
     WHERE c.created_here = 1 AND b.channel_id IS NULL`,
    [baselineDay],
  )) as { id: string }[];
  return rows.map((row) => row.id);
}

export async function billingView(actor: SessionUser, unsyncedOnly: boolean) {
  const clock = shanghaiClock();
  const live = await dbGet("SELECT * FROM billing_runs WHERE baseline_day = ?", [clock.day]);
  const published = (await dbAll("SELECT * FROM billing_runs WHERE status = 'published' ORDER BY bill_day DESC LIMIT 1")) as Row[];
  const showing = published[0];
  const billDay = showing ? String(showing.bill_day) : null;
  const scope = actor.role === "admin" ? "" : "AND c.creator_user_id = ?";
  const scopeParams = actor.role === "admin" ? [] : [actor.id];
  const rows = billDay
    ? ((await dbAll(
        `SELECT r.*, c.name, c.group_name, c.balance, c.used_quota, c.today_quota, c.type, u.name AS creator_name
         FROM billing_rows r
         JOIN channels c ON c.id = r.channel_id
         LEFT JOIN users u ON u.id = c.creator_user_id
         WHERE r.bill_day = ? AND c.created_here = 1 ${scope}
         ORDER BY c.upstream_id`,
        [billDay, ...scopeParams],
      )) as Row[])
    : [];
  const visible = unsyncedOnly ? rows.filter((row) => row.kind !== "amount") : rows;
  const markers = billDay ? await rebindMarkers(rows.map((row) => String(row.channel_id)), billDay) : new Map();
  const counted = rows.filter((row) => row.kind === "amount" && row.consumption !== null && row.consumption !== undefined);
  const unsynced = rows.filter((row) => row.kind !== "amount");
  const by = (key: string) => {
    const map = new Map<string, number>();
    for (const row of counted) {
      const name = String(row[key] ?? "") || "unknown";
      map.set(name, (map.get(name) ?? 0) + Number(row.consumption ?? 0));
    }
    return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  };
  const trendRows = (await dbAll(
    `SELECT r.bill_day, r.label, MAX(r.span_days) AS span_days, SUM(r.consumption) AS consumption
     FROM billing_rows r JOIN channels c ON c.id = r.channel_id
     WHERE r.kind = 'amount' AND c.created_here = 1 ${scope}
     GROUP BY r.bill_day, r.label
     ORDER BY r.bill_day ASC`,
    scopeParams,
  )) as { bill_day: string; label: string | null; span_days: number; consumption: number }[];
  const counts = live
    ? await scopedCounts(String(live.baseline_day), actor)
    : { total: 0, ok: 0, failed: 0 };
  const failedIds = live
    ? ((await dbAll(
        `SELECT a.channel_id FROM billing_attempts a JOIN channels c ON c.id = a.channel_id
         WHERE a.baseline_day = ? AND a.status = 'failed' AND c.created_here = 1 ${scope}`,
        [String(live.baseline_day), ...scopeParams],
      )) as { channel_id: string }[]).map((row) => row.channel_id)
    : [];
  return {
    copy: "schedule",
    collecting: live?.status === "collecting",
    progress: counts,
    failedIds,
    publishedAt: showing?.published_at ? Number(showing.published_at) : null,
    publishedLabel: formatShanghaiTime(showing?.published_at ? Number(showing.published_at) : null),
    billDay,
    unsyncedCount: unsynced.length,
    totalConsumption: counted.reduce((sum, row) => sum + Number(row.consumption ?? 0), 0),
    totalTestQuota: rows.reduce((sum, row) => sum + Number(row.test_quota ?? 0), 0),
    remainingBalance: rows.reduce((sum, row) => sum + (row.balance === null || row.balance === undefined ? 0 : Number(row.balance)), 0),
    usedUsd: rows.reduce((sum, row) => sum + Number(row.used_quota ?? 0), 0) / QUOTA_PER_DOLLAR,
    byType: (() => {
      const map = new Map<string, number>();
      for (const row of counted) {
        const name = channelTypeName(Number(row.type ?? 0)) || "unknown";
        map.set(name, (map.get(name) ?? 0) + Number(row.consumption ?? 0));
      }
      return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    })(),
    bySupplier: by("creator_name"),
    byChannel: by("name").slice(0, 8),
    byGroup: by("group_name"),
    trend: trendRows.map((row) => ({
      day: row.bill_day,
      label: row.label ? String(row.label) : "",
      spanDays: Number(row.span_days ?? 1),
      value: Number(row.consumption ?? 0),
      span: Boolean(row.label),
    })),
    rows: visible.map((row) => ({
      id: String(row.channel_id),
      name: String(row.name ?? ""),
      group: String(row.group_name ?? ""),
      supplier: String(row.creator_name ?? "") || "unknown",
      consumption: row.consumption === null || row.consumption === undefined ? null : Number(row.consumption),
      today: row.today_quota === null || row.today_quota === undefined ? null : Number(row.today_quota),
      before:
        row.used_quota === null || row.used_quota === undefined || row.today_quota === null || row.today_quota === undefined
          ? null
          : Number(row.used_quota) - Number(row.today_quota),
      cumulative: row.used_quota === null || row.used_quota === undefined ? null : Number(row.used_quota),
      typeName: channelTypeName(Number(row.type ?? 0)),
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
  const params = actor.role === "admin" ? [] : [actor.id];
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
  const scopeParams = actor.role === "admin" ? [] : [actor.id];
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
