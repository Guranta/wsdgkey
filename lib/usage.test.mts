import assert from "node:assert/strict";
import test from "node:test";
import { classifyModelsResponse, classifyUsageResponse, parseLogsPayload, parseUsagePayload, summarizeToday } from "./usage.ts";

const sample = {
  code: true,
  message: "ok",
  data: {
    object: "token_usage",
    name: "Default Token",
    total_granted: 1_000_000,
    total_used: 12_345,
    total_available: 987_655,
    unlimited_quota: false,
    model_limits: { "gpt-4o-mini": true, "gpt-4o": false },
    model_limits_enabled: true,
    expires_at: 0,
  },
};

test("parses the New API usage envelope and enabled model limits", () => {
  const usage = parseUsagePayload(sample);
  assert.ok(usage);
  assert.equal(usage?.name, "Default Token");
  assert.equal(usage?.total_available, 987_655);
  assert.deepEqual(usage?.model_limits, ["gpt-4o-mini"]);
  assert.equal(classifyUsageResponse(200, sample).status, "ok");
});

test("401 and a past expiry become expired", () => {
  assert.equal(classifyUsageResponse(401, { message: "No Authorization header" }).status, "expired");
  const expired = classifyUsageResponse(200, {
    ...sample,
    data: { ...sample.data, expires_at: 1_000 },
  }, 1_700_000_000_000);
  assert.equal(expired.status, "expired");
  assert.equal(expired.usage?.name, "Default Token");
});

test("token-not-found on HTTP 200 is expired, missing route falls back", () => {
  assert.equal(classifyUsageResponse(200, { success: false, message: "token not found" }).status, "expired");
  assert.equal(classifyUsageResponse(404, { message: "not found" }).fallbackToModels, true);
});

test("expiry within 72 hours is expiring", () => {
  const now = 1_700_000_000_000;
  const expiresAt = Math.floor((now + 36 * 3600 * 1000) / 1000);
  const result = classifyUsageResponse(200, {
    ...sample,
    data: { ...sample.data, expires_at: expiresAt },
  }, now);
  assert.equal(result.status, "expiring");
  assert.match(result.detail, /小时内到期/);
});

test("token logs parse paginated items and today's quota", () => {
  const now = new Date(2026, 9, 19, 15, 0, 0);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const parsed = parseLogsPayload({
    success: true,
    data: {
      total: 2,
      items: [
        { id: 7, created_at: Math.floor((start.getTime() + 1000) / 1000), model_name: "gpt-4o-mini", quota: 10, prompt_tokens: 2, completion_tokens: 3, use_time: 1, token_name: "t" },
        { id: 8, created_at: Math.floor((start.getTime() - 1000) / 1000), model_name: "gpt-4o", quota: 99, prompt_tokens: 1, completion_tokens: 1, use_time: 2, token_name: "t" },
      ],
    },
  });
  assert.equal(parsed.total, 2);
  assert.equal(parsed.items[0]?.model, "gpt-4o-mini");
  const summary = summarizeToday(parsed.items, now);
  assert.equal(summary.count, 1);
  assert.equal(summary.quota, 10);
});

test("models list classification", () => {
  const result = classifyModelsResponse(200, {
    object: "list",
    data: [{ id: "gpt-4o-mini", owned_by: "openai", created: 10 }],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.models[0]?.id, "gpt-4o-mini");
  assert.equal(classifyModelsResponse(401, { error: { message: "invalid" } }).status, "expired");
});
