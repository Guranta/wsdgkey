import assert from "node:assert/strict";
import test from "node:test";
import { CALLS_PER_CHANNEL, LIST_SYNC_RESERVE_PER_MIN, failureBackoffMs, planBillingTick, type PlanChannel } from "./billing-plan.ts";

function channel(partial: Partial<PlanChannel> & { id: string }): PlanChannel {
  return { gatewayId: "gw", usedQuota: 0, createdAt: 0, consecutiveFailures: 0, lastFailedAt: null, ...partial };
}

test("failure backoff starts at 30s, doubles, and caps at 15 minutes", () => {
  assert.equal(failureBackoffMs(0), 30_000);
  assert.equal(failureBackoffMs(1), 30_000);
  assert.equal(failureBackoffMs(2), 60_000);
  assert.equal(failureBackoffMs(3), 120_000);
  assert.equal(failureBackoffMs(10), 15 * 60_000);
});

test("channels still inside their backoff window are skipped this tick", () => {
  const now = 1_000_000;
  const plan = planBillingTick({
    now,
    shanghaiHour: 0,
    shanghaiMinute: 5,
    gatewayPerMin: 60,
    queueHits: {},
    channels: [
      channel({ id: "fresh" }),
      channel({ id: "recent-fail", lastFailedAt: now - 10_000, consecutiveFailures: 1 }),
      channel({ id: "old-fail", lastFailedAt: now - 31_000, consecutiveFailures: 1 }),
    ],
  });
  assert.deepEqual(plan.dispatch, ["fresh", "old-fail"]);
});

test("heavy consumers are pulled first, then new channels, then the rest", () => {
  const plan = planBillingTick({
    now: 0,
    shanghaiHour: 0,
    shanghaiMinute: 1,
    gatewayPerMin: 600,
    queueHits: {},
    channels: [
      channel({ id: "idle-old", usedQuota: 0, createdAt: 1 }),
      channel({ id: "new", usedQuota: 0, createdAt: 100 }),
      channel({ id: "heavy", usedQuota: 9000 }),
      channel({ id: "light", usedQuota: 10 }),
    ],
  });
  assert.deepEqual(plan.dispatch, ["heavy", "light", "new", "idle-old"]);
});

test("a small backlog fits in one tick regardless of pacing", () => {
  const plan = planBillingTick({
    now: 0,
    shanghaiHour: 0,
    shanghaiMinute: 1,
    gatewayPerMin: 60,
    queueHits: {},
    channels: [channel({ id: "a" }), channel({ id: "b" }), channel({ id: "c" })],
  });
  assert.equal(plan.dispatch.length, 3);
  assert.equal(plan.etaMinutes, 1);
});

test("a big backlog is throttled to the per-minute capacity per tick", () => {
  // 240 个渠道 × 4 次调用 = 960 次需求；默认 60rpm 的网关每 tick 只派 ~4 个渠道
  const channels = Array.from({ length: 240 }, (_, index) => channel({ id: `c${index}` }));
  const plan = planBillingTick({
    now: 0,
    shanghaiHour: 0,
    shanghaiMinute: 2,
    gatewayPerMin: 60,
    queueHits: {},
    channels,
  });
  // ceil((60-4)/4/4) = 4 个渠道/tick，避免队列任务超过 45 秒截止雪崩
  assert.equal(plan.dispatch.length, 4);
  assert.equal(plan.etaMinutes, Math.ceil((240 * CALLS_PER_CHANNEL) / (60 - LIST_SYNC_RESERVE_PER_MIN)));
});

test("past the target hour the plan still runs at quota speed", () => {
  const channels = Array.from({ length: 30 }, (_, index) => channel({ id: `c${index}` }));
  const plan = planBillingTick({
    now: 0,
    shanghaiHour: 4,
    shanghaiMinute: 30,
    gatewayPerMin: 60,
    queueHits: {},
    channels,
  });
  assert.equal(plan.dispatch.length, 4);
});

test("a gateway whose quota is exhausted dispatches nothing this tick", () => {
  const plan = planBillingTick({
    now: 0,
    shanghaiHour: 0,
    shanghaiMinute: 3,
    gatewayPerMin: 60,
    queueHits: { gw: 58 },
    channels: [channel({ id: "a", gatewayId: "gw" }), channel({ id: "b", gatewayId: "other" })],
  });
  assert.deepEqual(plan.dispatch, ["b"]);
});
