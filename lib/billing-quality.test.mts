import assert from "node:assert/strict";
import test from "node:test";
import { dailyDiff, readCustomerBilling, type MidnightReading } from "./billing-math.ts";

function ok(amount: number, fxRate: number | null = null, pulledAt = 1_000): MidnightReading {
  return { quality: "ok", amount, unit: "usd", fxRate, upstreamSource: "dianju_call_logs", pulledAt };
}

test("ready + 可解析金额 + 汇率字符串 → ok，金额与汇率入读数", () => {
  const reading = readCustomerBilling({ state: "ready", amount_usd: "12.5", exchange_rate: "7.2", source: "dianju_call_logs" }, 5);
  assert.deepEqual({ q: reading.quality, a: reading.amount, fx: reading.fxRate }, { q: "ok", a: 12.5, fx: 7.2 });
});

test("假零防线：ready 但金额空串/非数字 → missing，绝不当 0（BILL-C-02）", () => {
  for (const bad of ["", "  ", "abc", undefined, null]) {
    const reading = readCustomerBilling({ state: "ready", amount_usd: bad }, 5);
    assert.equal(reading.quality, "missing", `amount_usd=${JSON.stringify(bad)}`);
    assert.equal(reading.amount, null);
  }
});

test("stale 与 unavailable 各自成质量，金额为空（BILL-C-03、BILL-C-04）", () => {
  assert.equal(readCustomerBilling({ state: "ready", amount_usd: 3, stale: true }, 5).quality, "stale");
  assert.equal(readCustomerBilling({ state: "unavailable", amount_usd: 3 }, 5).quality, "unavailable");
});

test("日差：两侧 ok 才有金额；真零是 0 而不是缺数据（BILL-C-01）", () => {
  assert.deepEqual({ q: dailyDiff(ok(10), ok(10)).quality, a: dailyDiff(ok(10), ok(10)).amount }, { q: "ok", a: 0 });
  assert.equal(dailyDiff(ok(10), ok(12.5)).amount, 2.5);
});

test("缺任一侧 → missing，不得把另一侧当 0 出全额（BILL-C-02）", () => {
  assert.deepEqual({ q: dailyDiff(null, ok(12)).quality, a: dailyDiff(null, ok(12)).amount }, { q: "missing", a: null });
  assert.equal(dailyDiff(ok(12), null).quality, "missing");
});

test("质量混合时按 unavailable > stale > missing 取最差（BILL-C-05）", () => {
  const stale = { ...ok(5), quality: "stale" as const };
  const unavailable = { ...ok(5), quality: "unavailable" as const };
  assert.equal(dailyDiff(stale, ok(6)).quality, "stale");
  assert.equal(dailyDiff(ok(6), unavailable).quality, "unavailable");
  assert.equal(dailyDiff(stale, unavailable).quality, "unavailable");
});

test("负差保留负数并带 anomaly，不取绝对值（BILL-C-07）", () => {
  const diff = dailyDiff(ok(20), ok(15));
  assert.equal(diff.amount, -5);
  assert.equal(diff.anomaly, "negative");
});
