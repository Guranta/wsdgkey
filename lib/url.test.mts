import assert from "node:assert/strict";
import test from "node:test";
import { hostAllowed, joinUpstream, normalizeBaseUrl } from "./url.ts";

test("strips a trailing slash and a trailing /v1", () => {
  const result = normalizeBaseUrl("https://example.com/v1/");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.siteBase, "https://example.com");
  assert.equal(result.openaiBase, "https://example.com/v1");
});

test("keeps a subpath and adds https", () => {
  const result = normalizeBaseUrl("api.example.com/newapi/v1");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.siteBase, "https://api.example.com/newapi");
  assert.equal(result.openaiBase, "https://api.example.com/newapi/v1");
});

test("rejects credentials, queries, and non-http protocols", () => {
  assert.equal(normalizeBaseUrl("https://user:pw@example.com").ok, false);
  assert.equal(normalizeBaseUrl("https://example.com/v1?token=abc").ok, false);
  assert.equal(normalizeBaseUrl("javascript:alert(1)").ok, false);
  assert.equal(normalizeBaseUrl("http://169.254.169.254").ok, false);
});

test("joins openAI paths onto the site root and drops secret query keys", () => {
  const url = joinUpstream("https://example.com/v1/", "v1/models", "?token=sekret&limit=5");
  assert.equal(url.toString(), "https://example.com/v1/models?limit=5");
});

test("host allow-list is empty by default and exact when configured", () => {
  assert.equal(hostAllowed("api.example.com", undefined), true);
  assert.equal(hostAllowed("api.example.com", "api.example.com, other.example.com"), true);
  assert.equal(hostAllowed("evil.example.com", "api.example.com"), false);
  assert.equal(hostAllowed("169.254.169.254", undefined), false);
});

test("usage stays on /api even when the user pasted /v1", () => {
  const url = joinUpstream("https://example.com/v1", "api/usage/token");
  assert.equal(url.toString(), "https://example.com/api/usage/token");
});
