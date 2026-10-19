import { addDays, daysBetween } from "./shanghai";

export type BaselinePoint = { day: string; baseline: number; source?: string };

const NEAR_MIDNIGHT_MS = 15 * 60 * 1000;

/**
 * New API stores cumulative `used_quota` on the channel.
 * Today's consumption is `GET /api/log/stat` quota since Shanghai midnight
 * (the channel payload has no today field). baseline = cumulative − today,
 * which stays equal to the cumulative at 00:00 no matter when we pull.
 * If today cannot be read, a cumulative sample is accepted only within 15
 * minutes after midnight. Later than that we refuse to guess.
 */
/**
 * v1.0.0-rc.45 channel tests write a type=2 consume log and do not update
 * channel used_quota. Subtract that test quota from the log-stat today figure
 * before deriving the midnight baseline, or the baseline drifts down by the
 * tests and the next bill no longer matches used_quota.
 */
export function todayExcludingTests(today: number, testQuota: number): number {
  if (!Number.isFinite(today)) return today;
  const tests = Number.isFinite(testQuota) ? Math.max(0, testQuota) : 0;
  return today - tests;
}

export function deriveBaseline(input: {
  cumulative: number;
  today: number | null;
  pulledAt: number;
  dayStart: number;
}): { baseline: number; source: "exact" | "near-midnight" } | null {
  if (!Number.isFinite(input.cumulative)) return null;
  if (input.today !== null && Number.isFinite(input.today)) {
    return { baseline: input.cumulative - input.today, source: "exact" };
  }
  if (input.pulledAt >= input.dayStart && input.pulledAt - input.dayStart <= NEAR_MIDNIGHT_MS) {
    return { baseline: input.cumulative, source: "near-midnight" };
  }
  return null;
}

/**
 * Consumption of a binding segment on the day it was attached.
 * Earlier usage of that new-api id belongs to whoever held it before, so the
 * bind-day amount is the next Shanghai midnight baseline minus the snapshot
 * taken at bind time. A missing reading stays unknown, never zero.
 */
export function bindSegmentConsumption(nextBaseline: number | null, bindSnapshot: number | null): number | null {
  if (nextBaseline === null || bindSnapshot === null) return null;
  if (!Number.isFinite(nextBaseline) || !Number.isFinite(bindSnapshot)) return null;
  return nextBaseline - bindSnapshot;
}

/** Final partial usage of an unbound id. Logs that cannot be read are unsynced, never a guessed 0. */
export function closeOldSegment(logQuota: number | null): { quota: number | null; status: "amount" | "unsynced" } {
  if (logQuota === null || !Number.isFinite(logQuota)) return { quota: null, status: "unsynced" };
  return { quota: logQuota, status: "amount" };
}

export function spanLabel(days: number): string | null {
  if (days <= 1) return null;
  if (days === 2) return "span2";
  return "spanN";
}

export type Consumption =
  | { kind: "unsynced" }
  | { kind: "no-baseline" }
  | { kind: "skip" }
  | {
      kind: "amount";
      startDay: string;
      endDay: string;
      days: number;
      label: string | null;
      consumption: number;
    };

/**
 * Bill `billDay` using the baseline taken at 00:00 on the next day.
 * The prior point is the previous stored baseline. For a channel created
 * through this app, that prior point on the creation day is the used_quota
 * snapshot taken at creation (normally 0), so the first day is
 * baseline(today) − creation snapshot.
 * A creation snapshot stored on the close day is not yesterday's midnight
 * reading, so that channel is left out of the previous day's bill.
 * Missing the prior baseline across more than one day becomes one combined row.
 * A close with nothing before it is 无基线, never a guessed zero and never a log-stat substitute.
 */
export function resolveConsumption(billDay: string, baselines: BaselinePoint[]): Consumption {
  const closeDay = addDays(billDay, 1);
  const close = baselines.find((item) => item.day === closeDay);
  if (!close) return { kind: "unsynced" };
  if (close.source === "create") return { kind: "skip" };
  const prior = baselines
    .filter((item) => item.day <= billDay)
    .sort((a, b) => (a.day < b.day ? 1 : -1))[0];
  if (!prior) return { kind: "no-baseline" };
  const days = daysBetween(prior.day, closeDay);
  return {
    kind: "amount",
    startDay: prior.day,
    endDay: billDay,
    days,
    label: spanLabel(days),
    consumption: close.baseline - prior.baseline,
  };
}

/**
 * Per-channel reconciliation against that channel's /api/log/stat only.
 * Gateway-wide totals are not compared: they include channels this app did not create.
 * `logQuota` is the log-stat figure with model-test consume already removed.
 */
export function reconcileFinding(input: { missing: boolean; consumption: number | null; logQuota: number | null }): string {
  if (input.missing) return "missing";
  if (input.consumption === null || input.logQuota === null) return "";
  if (Math.abs(input.consumption - input.logQuota) > 0.5) return "anomaly";
  return "";
}

export type ReconCheckStatus = "match" | "anomaly" | "unsynced" | "missing_logs";

export type ReconEvaluation = {
  status: ReconCheckStatus;
  reason: string;
  delta: number | null;
  deltaPct: number | null;
};

const QUOTA_EPSILON = 0.5;

/** Signed (ours − logs) / max(|ours|, |logs|). Both zero is 0, never a division by zero. */
export function signedDiffRatio(ours: number, logs: number): number {
  const denom = Math.max(Math.abs(ours), Math.abs(logs));
  if (denom === 0) return 0;
  return (ours - logs) / denom;
}

/**
 * One reconciliation decision for a channel-day, or for a combined span.
 * Span rows pass the combined baseline delta and the combined log total only.
 * `gatewayLogsQuiet` is true when the gateway-wide log stat for that window was read and is 0.
 */
export function evaluateRecon(input: {
  consumption: number | null;
  yesterdayBaseline: number | null;
  todayBaseline: number | null;
  logQuota: number | null;
  logTimedOut: boolean;
  gatewayLogsQuiet: boolean;
  upstreamMissing: boolean;
  channelStatus: number;
  zeroStreak: number;
  zeroDaysLimit: number;
  tolerance: number;
}): ReconEvaluation {
  const tolerance = Number.isFinite(input.tolerance) ? Math.max(0, input.tolerance) : 0.01;
  if (input.consumption === null || input.logTimedOut) {
    return { status: "unsynced", reason: input.logTimedOut ? "timeout" : "unread", delta: null, deltaPct: null };
  }
  const ours = input.consumption;
  const reasons: string[] = [];
  const yesterday = input.yesterdayBaseline;
  const today = input.todayBaseline;
  if (yesterday !== null && today !== null && today + QUOTA_EPSILON < yesterday) reasons.push("reset");
  if (yesterday !== null && today !== null && Math.abs(yesterday + ours - today) > QUOTA_EPSILON) reasons.push("self");
  if (input.upstreamMissing && input.logQuota === null) {
    return { status: "unsynced", reason: "missing", delta: null, deltaPct: null };
  }
  if (input.logQuota === null) {
    return { status: "unsynced", reason: "unread", delta: null, deltaPct: null };
  }
  const logs = input.logQuota;
  const delta = ours - logs;
  const deltaPct = signedDiffRatio(ours, logs);
  const purged = logs === 0 && ours > QUOTA_EPSILON && input.gatewayLogsQuiet;
  if (purged) reasons.push("purged");
  else if (Math.abs(deltaPct) > tolerance + 1e-12) reasons.push("tolerance");
  if ((input.channelStatus === 2 || input.channelStatus === 3) && ours > QUOTA_EPSILON) reasons.push("disabled_growth");
  if (input.channelStatus === 1 && Math.abs(ours) <= QUOTA_EPSILON && input.zeroStreak >= input.zeroDaysLimit) reasons.push("zero_streak");
  const hard = reasons.filter((item) => item !== "purged");
  if (purged && hard.length === 0) return { status: "missing_logs", reason: "purged", delta, deltaPct };
  if (reasons.length) return { status: "anomaly", reason: reasons.join(","), delta, deltaPct };
  return { status: "match", reason: "", delta, deltaPct };
}

/** A supplier dispute waits for an admin. A resolution puts the row back on the check result. */
export function reconDisplayStatus(check: ReconCheckStatus, supplierAction: string, adminResolution: string): ReconCheckStatus | "pending" {
  if (supplierAction === "disputed" && !adminResolution) return "pending";
  return check;
}

export function rollupFigures(input: { ours: number; logs: number | null; timedOut: boolean; quiet: boolean; tolerance: number }): ReconEvaluation {
  if (input.timedOut || input.logs === null) {
    return { status: "unsynced", reason: input.timedOut ? "timeout" : "unread", delta: null, deltaPct: null };
  }
  return evaluateRecon({
    consumption: input.ours,
    yesterdayBaseline: null,
    todayBaseline: null,
    logQuota: input.logs,
    logTimedOut: false,
    gatewayLogsQuiet: input.quiet,
    upstreamMissing: false,
    channelStatus: 1,
    zeroStreak: 0,
    zeroDaysLimit: Number.POSITIVE_INFINITY,
    tolerance: input.tolerance,
  });
}

export function retryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(10 * 60 * 1000, Math.round(retryAfterSeconds * 1000));
  }
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
}

/** Channels that keep failing are polled less often. The first failure stays on the normal 5 minute cadence. */
export function pollDelayMs(consecutiveFailures: number): number {
  const base = 5 * 60 * 1000;
  if (consecutiveFailures <= 1) return base;
  return Math.min(6 * 60 * 60 * 1000, base * 2 ** (consecutiveFailures - 1));
}

/** Record one upstream attempt. Returns false when the window is already full. Does not record a rejection. */
export function takeSlot(hits: number[], now: number, limit: number, windowMs = 60_000): boolean {
  const fresh = hits.filter((stamp) => now - stamp < windowMs);
  hits.length = 0;
  hits.push(...fresh);
  if (fresh.length >= limit) return false;
  hits.push(now);
  return true;
}
