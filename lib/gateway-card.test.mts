import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gatewayCardCopy, settingsIntroKey } from "./gateway-card.ts";

const jwt = { kind: "newapi_supplier" as const, tokenSet: false, tokenMasked: "", demo: false };

test("a connected JWT gateway card follows authStatus, not tokenSet", () => {
  const copy = gatewayCardCopy({ ...jwt, authStatus: "ok", tokenSet: false });
  assert.equal(copy.subtitle, "connected");
  assert.equal(copy.pill, "connected");
  assert.equal(copy.reloginTip, false);
  assert.equal(copy.tone, "ok");
  assert.notEqual(copy.subtitle, "tokenMissing");
  assert.notEqual(copy.pill, "tokenInvalid");
});

test("a JWT session that is not ok asks for a password re-login even when tokenSet is true", () => {
  for (const authStatus of ["failed", ""]) {
    const copy = gatewayCardCopy({ ...jwt, authStatus, tokenSet: true, tokenMasked: "nap_****" });
    assert.equal(copy.subtitle, "needRelogin", authStatus);
    assert.equal(copy.pill, "needRelogin", authStatus);
    assert.equal(copy.reloginTip, true);
    assert.equal(copy.tone, "danger");
  }
});

test("a disabled JWT gateway does not fall back to a missing-token subtitle", () => {
  const copy = gatewayCardCopy({ ...jwt, authStatus: "ok", disabled: true, tokenSet: true });
  assert.equal(copy.pill, "deactivated");
  assert.equal(copy.subtitle, "connected");
  assert.equal(copy.reloginTip, false);
  assert.equal(copy.fetchFailed, false);
});

test("a rejected session or failed catalog pull is a fetch failure, and a disabled gateway is not", () => {
  const rejected = gatewayCardCopy({ ...jwt, authStatus: "failed", listSyncStatus: "failed" });
  assert.equal(rejected.fetchFailed, true);
  const pull = gatewayCardCopy({ ...jwt, authStatus: "ok", listSyncStatus: "failed" });
  assert.equal(pull.fetchFailed, true);
  assert.equal(pull.pill, "connected");
  const paused = gatewayCardCopy({ ...jwt, authStatus: "failed", listSyncStatus: "failed", disabled: true });
  assert.equal(paused.fetchFailed, false);
  assert.equal(paused.pill, "deactivated");
});

test("seller cards stay on the account session and do not use token wording", () => {
  const ok = gatewayCardCopy({ kind: "newapi_seller", authStatus: "ok", tokenSet: false, username: "vendor" });
  assert.equal(ok.subtitle, "account");
  assert.equal(ok.pill, "connected");
  const failed = gatewayCardCopy({ kind: "newapi_seller", authStatus: "failed", tokenSet: true, username: "vendor" });
  assert.equal(failed.subtitle, "account");
  assert.equal(failed.pill, "connectionError");
  assert.equal(failed.tone, "warn");
  const unknown = gatewayCardCopy({ kind: "newapi_seller", authStatus: "", tokenSet: true });
  assert.equal(unknown.subtitle, "needRelogin");
  assert.equal(unknown.pill, "needRelogin");
});

test("admin token cards still key off the access token", () => {
  const missing = gatewayCardCopy({ kind: "newapi_admin", authStatus: "ok", tokenSet: false });
  assert.equal(missing.subtitle, "tokenMissing");
  assert.equal(missing.pill, "tokenInvalid");
  const saved = gatewayCardCopy({ kind: "newapi_admin", tokenSet: true, tokenMasked: "nap_****99" });
  assert.equal(saved.subtitle, "token");
  assert.equal(saved.pill, "connected");
  const demo = gatewayCardCopy({ kind: "newapi_admin", demo: true, tokenSet: false });
  assert.equal(demo.subtitle, "demo");
  assert.equal(demo.pill, "connected");
});

test("settings intro is kind-aware and the password-session sentence has no access token", () => {
  assert.equal(settingsIntroKey({ admin: false, kinds: ["newapi_supplier"] }), "supplierHint");
  assert.equal(settingsIntroKey({ admin: true, kinds: [] }), "description");
  assert.equal(settingsIntroKey({ admin: true, kinds: ["newapi_admin"] }), "description");
  assert.equal(settingsIntroKey({ admin: true, kinds: ["newapi_supplier"] }), "descriptionSession");
  assert.equal(settingsIntroKey({ admin: true, kinds: ["newapi_seller"] }), "descriptionSession");
  assert.equal(settingsIntroKey({ admin: true, kinds: ["newapi_admin", "newapi_supplier"] }), "descriptionSession");
  assert.equal(settingsIntroKey({ admin: true, kinds: ["newapi_admin"], draftingPassword: true }), "descriptionSession");
  assert.equal(settingsIntroKey({ admin: true, kinds: [], draftingPassword: true }), "descriptionSession");

  const zh = JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url), "utf8")) as { settings: Record<string, string> };
  const en = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8")) as { settings: Record<string, string> };
  const forbidden = /系统访问令牌|Access Token|system access token/i;
  assert.equal(forbidden.test(zh.settings.descriptionSession), false);
  assert.equal(forbidden.test(en.settings.descriptionSession), false);
  assert.equal(forbidden.test(zh.settings.supplierSaved), false);
  assert.equal(forbidden.test(en.settings.supplierSaved), false);
  assert.match(zh.settings.description, /系统访问令牌/);
  assert.match(en.settings.description, /system access token/i);
  assert.match(zh.settings.descriptionSession, /账号和密码/);
  assert.match(en.settings.descriptionSession, /username and password/);
});
