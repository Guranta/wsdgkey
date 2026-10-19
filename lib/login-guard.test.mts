import assert from "node:assert/strict";
import test from "node:test";
import { loginFieldError } from "./account.ts";
import { canonicalLocale } from "./locale.ts";
import { clearUsernameFailures, loginRateLimited, recordLoginFailure, resetLoginRateForTests } from "./login-guard.ts";
import { applySecurityHeaders, CONTENT_SECURITY_POLICY } from "./security-headers.ts";
import { formatShanghaiMidnight, nextShanghaiMidnight } from "./shanghai.ts";

test("login fields distinguish empty, too long, and invalid characters", () => {
  assert.equal(loginFieldError("", ""), "credentialsRequired");
  assert.equal(loginFieldError("   ", "secret-pass"), "credentialsRequired");
  assert.equal(loginFieldError("a".repeat(21), ""), "usernameTooLong");
  assert.equal(loginFieldError("a".repeat(21), "secret-pass"), "usernameTooLong");
  assert.equal(loginFieldError("a@b", "secret-pass"), "loginUsernameInvalid");
  assert.equal(loginFieldError("bad name", "secret-pass"), "loginUsernameInvalid");
  assert.equal(loginFieldError("admin", "x".repeat(129)), "passwordTooLong");
  assert.equal(loginFieldError("admin", "has space"), "passwordHasSpace");
  assert.equal(loginFieldError("admin", "short"), null);
});

test("five login failures in 15 minutes are limited with Retry-After", () => {
  resetLoginRateForTests();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 4; i += 1) {
    assert.equal(recordLoginFailure("10.0.0.8", "admin", now + i).limited, false);
  }
  const fifth = recordLoginFailure("10.0.0.8", "admin", now + 4);
  assert.equal(fifth.limited, true);
  if (!fifth.limited) return;
  assert.ok(fifth.retryAfter >= 1);
  assert.ok(fifth.retryAfter <= 15 * 60);

  const still = loginRateLimited("10.0.0.8", "admin", now + 10);
  assert.equal(still.limited, true);
  if (still.limited) assert.equal(still.retryAfter, fifth.retryAfter - 0 || still.retryAfter);

  const expired = loginRateLimited("10.0.0.8", "admin", now + 4 + 15 * 60 * 1000);
  assert.equal(expired.limited, false);
});

test("username and IP limits are separate, and a successful login clears only the username", () => {
  resetLoginRateForTests();
  const now = 1_800_000_000_000;
  for (let i = 0; i < 5; i += 1) recordLoginFailure("10.1.0.1", "shop", now);
  assert.equal(loginRateLimited("10.9.9.9", "shop", now).limited, true);
  clearUsernameFailures("shop");
  assert.equal(loginRateLimited("10.9.9.9", "shop", now).limited, false);
  assert.equal(loginRateLimited("10.1.0.1", "other", now).limited, true);
});

test("locale aliases normalize and unknown tags are rejected", () => {
  assert.equal(canonicalLocale("zh"), "zh-CN");
  assert.equal(canonicalLocale("zh-CN"), "zh-CN");
  assert.equal(canonicalLocale("zh-Hans"), "zh-CN");
  assert.equal(canonicalLocale("ZH_cn"), "zh-CN");
  assert.equal(canonicalLocale("en"), "en");
  assert.equal(canonicalLocale("en-US"), "en");
  assert.equal(canonicalLocale("EN_us"), "en");
  assert.equal(canonicalLocale("fr"), null);
  assert.equal(canonicalLocale(""), null);
  assert.equal(canonicalLocale(null), null);
});

test("security headers include CSP, nosniff, referrer policy, and drop X-Powered-By", () => {
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  const headers = new Headers({ "X-Powered-By": "Next.js" });
  applySecurityHeaders(headers);
  assert.equal(headers.get("x-powered-by"), null);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(headers.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.match(headers.get("content-security-policy") ?? "", /object-src 'none'/);
});

test("billing scheduler names the next Shanghai midnight", () => {
  const afternoon = Date.parse("2026-10-19T12:00:00Z");
  const next = nextShanghaiMidnight(afternoon);
  assert.equal(next, Date.parse("2026-10-20T00:00:00+08:00"));
  assert.equal(formatShanghaiMidnight(next), "2026-10-20T00:00:00+08:00");
  assert.equal(nextShanghaiMidnight(next), next);
});
