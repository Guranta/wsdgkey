import assert from "node:assert/strict";
import test from "node:test";
import { bindSegmentConsumption, closeOldSegment, deriveBaseline, evaluateRecon, pollDelayMs, reconDisplayStatus, reconcileFinding, resolveConsumption, retryDelayMs, rollupFigures, signedDiffRatio, takeSlot } from "./billing-math.ts";

test("a bind day bills only usage after the snapshot", () => {
  assert.equal(bindSegmentConsumption(1280, 900), 380);
  assert.equal(bindSegmentConsumption(900, 900), 0);
  assert.equal(bindSegmentConsumption(null, 900), null);
  assert.deepEqual(closeOldSegment(55), { quota: 55, status: "amount" });
  assert.deepEqual(closeOldSegment(null), { quota: null, status: "unsynced" });
  assert.notEqual(closeOldSegment(null).quota, 0);
});

test("baseline is cumulative minus today and ignores pull time", () => {
  const dayStart = Date.parse("2026-10-19T00:00:00+08:00");
  const early = deriveBaseline({ cumulative: 1000, today: 10, pulledAt: dayStart + 60_000, dayStart });
  const later = deriveBaseline({ cumulative: 1800, today: 810, pulledAt: dayStart + 5 * 60 * 60 * 1000, dayStart });
  assert.equal(early?.baseline, 990);
  assert.equal(later?.baseline, 990);
  assert.equal(early?.source, "exact");
});

test("cumulative-only samples count only near midnight", () => {
  const dayStart = Date.parse("2026-10-19T00:00:00+08:00");
  const near = deriveBaseline({ cumulative: 500, today: null, pulledAt: dayStart + 10 * 60 * 1000, dayStart });
  const late = deriveBaseline({ cumulative: 900, today: null, pulledAt: dayStart + 2 * 60 * 60 * 1000, dayStart });
  assert.equal(near?.source, "near-midnight");
  assert.equal(near?.baseline, 500);
  assert.equal(late, null);
});

test("one day is the difference of adjacent baselines", () => {
  const result = resolveConsumption("2026-10-18", [
    { day: "2026-10-18", baseline: 100 },
    { day: "2026-10-19", baseline: 140 },
  ]);
  assert.equal(result.kind, "amount");
  if (result.kind !== "amount") return;
  assert.equal(result.consumption, 40);
  assert.equal(result.days, 1);
  assert.equal(result.label, null);
});

test("a missed boundary becomes one combined row and a rerun is identical", () => {
  const baselines = [
    { day: "2026-10-17", baseline: 80 },
    { day: "2026-10-19", baseline: 150 },
  ];
  const first = resolveConsumption("2026-10-18", baselines);
  const second = resolveConsumption("2026-10-18", baselines);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "amount");
  if (first.kind !== "amount") return;
  assert.equal(first.label, "span2");
  assert.equal(first.startDay, "2026-10-17");
  assert.equal(first.endDay, "2026-10-18");
  assert.equal(first.consumption, 70);
  assert.equal(first.days, 2);
});

test("longer gaps are labeled spanN and are not split", () => {
  const result = resolveConsumption("2026-10-20", [
    { day: "2026-10-17", baseline: 10 },
    { day: "2026-10-21", baseline: 50 },
  ]);
  assert.equal(result.kind, "amount");
  if (result.kind !== "amount") return;
  assert.equal(result.days, 4);
  assert.equal(result.label, "spanN");
  assert.equal(result.consumption, 40);
});

test("missing close or missing history is not counted as zero", () => {
  assert.equal(resolveConsumption("2026-10-18", [{ day: "2026-10-18", baseline: 10 }]).kind, "unsynced");
  assert.equal(resolveConsumption("2026-10-18", [{ day: "2026-10-19", baseline: 10, source: "exact" }]).kind, "no-baseline");
});

test("first day is today's baseline minus the creation snapshot", () => {
  const result = resolveConsumption("2026-10-18", [
    { day: "2026-10-18", baseline: 0, source: "create" },
    { day: "2026-10-19", baseline: 40, source: "exact" },
  ]);
  assert.equal(result.kind, "amount");
  if (result.kind !== "amount") return;
  assert.equal(result.consumption, 40);
  assert.equal(result.days, 1);
  assert.equal(result.label, null);
});

test("a creation snapshot is not used as the previous day's close", () => {
  assert.equal(
    resolveConsumption("2026-10-18", [{ day: "2026-10-19", baseline: 0, source: "create" }]).kind,
    "skip",
  );
});

test("reconciliation is per channel and flags a missing upstream id", () => {
  assert.equal(reconcileFinding({ missing: true, consumption: 40, logQuota: 40 }), "missing");
  assert.equal(reconcileFinding({ missing: false, consumption: 40, logQuota: 40 }), "");
  assert.equal(reconcileFinding({ missing: false, consumption: 40, logQuota: 10 }), "anomaly");
  assert.equal(reconcileFinding({ missing: false, consumption: 40, logQuota: null }), "");
});

const baseCheck = {
  consumption: 4000,
  yesterdayBaseline: 1000,
  todayBaseline: 5000,
  logQuota: 4000,
  logTimedOut: false,
  gatewayLogsQuiet: false,
  upstreamMissing: false,
  channelStatus: 1,
  zeroStreak: 0,
  zeroDaysLimit: 3,
  tolerance: 0.01,
};

test("a matching baseline and log is consistent, including a zero over zero", () => {
  const match = evaluateRecon(baseCheck);
  assert.equal(match.status, "match");
  assert.equal(match.delta, 0);
  assert.equal(match.deltaPct, 0);
  const zeros = evaluateRecon({ ...baseCheck, consumption: 0, yesterdayBaseline: 5, todayBaseline: 5, logQuota: 0 });
  assert.equal(zeros.status, "match");
  assert.equal(zeros.deltaPct, 0);
  assert.equal(signedDiffRatio(0, 0), 0);
});

test("tolerance, a fallen baseline, and a purged log are different results", () => {
  assert.equal(evaluateRecon({ ...baseCheck, logQuota: 3000 }).status, "anomaly");
  assert.match(evaluateRecon({ ...baseCheck, todayBaseline: 500, consumption: -500 }).reason, /reset/);
  const purged = evaluateRecon({ ...baseCheck, logQuota: 0, gatewayLogsQuiet: true });
  assert.equal(purged.status, "missing_logs");
  assert.equal(evaluateRecon({ ...baseCheck, logQuota: 0, gatewayLogsQuiet: false }).status, "anomaly");
});

test("timeouts stay unsynced and a span is judged on the combined total", () => {
  assert.equal(evaluateRecon({ ...baseCheck, logTimedOut: true }).status, "unsynced");
  assert.equal(evaluateRecon({ ...baseCheck, consumption: null }).reason, "unread");
  const span = evaluateRecon({ ...baseCheck, consumption: 9000, yesterdayBaseline: 1000, todayBaseline: 10000, logQuota: 9000 });
  assert.equal(span.status, "match");
});

test("disabled growth and a long zero streak are anomalies", () => {
  assert.match(evaluateRecon({ ...baseCheck, channelStatus: 3 }).reason, /disabled_growth/);
  assert.match(evaluateRecon({ ...baseCheck, consumption: 0, yesterdayBaseline: 5, todayBaseline: 5, logQuota: 0, zeroStreak: 3 }).reason, /zero_streak/);
  assert.equal(evaluateRecon({ ...baseCheck, consumption: 0, yesterdayBaseline: 5, todayBaseline: 5, logQuota: 0, zeroStreak: 2 }).status, "match");
});

test("a dispute waits for an admin and a gateway total uses the same tolerance", () => {
  assert.equal(reconDisplayStatus("anomaly", "disputed", ""), "pending");
  assert.equal(reconDisplayStatus("anomaly", "disputed", "upheld"), "anomaly");
  assert.equal(rollupFigures({ ours: 100, logs: 100, timedOut: false, quiet: false, tolerance: 0.01 }).status, "match");
  assert.equal(rollupFigures({ ours: 100, logs: 0, timedOut: false, quiet: true, tolerance: 0.01 }).status, "missing_logs");
  assert.equal(rollupFigures({ ours: 100, logs: null, timedOut: true, quiet: false, tolerance: 0.01 }).status, "unsynced");
});

test("429 uses Retry-After and otherwise backs off", () => {
  assert.equal(retryDelayMs(3, 12), 12_000);
  assert.equal(retryDelayMs(0, null), 1000);
  assert.equal(retryDelayMs(3, null), 8000);
});

test("repeated failures lower the poll rate", () => {
  assert.equal(pollDelayMs(1), 5 * 60 * 1000);
  assert.ok(pollDelayMs(4) > pollDelayMs(2));
});

test("a rate slot is consumed once per accepted attempt", () => {
  const hits: number[] = [];
  const now = 1_000_000;
  for (let index = 0; index < 60; index += 1) assert.equal(takeSlot(hits, now, 60), true);
  assert.equal(takeSlot(hits, now, 60), false);
  assert.equal(hits.length, 60);
  assert.equal(takeSlot(hits, now + 60_000, 60), true);
});
