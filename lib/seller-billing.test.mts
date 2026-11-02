import assert from "node:assert/strict";
import test from "node:test";
import { resolveSellerConsumption } from "./billing-math.ts";
import { atChannelCap, isBaseUrlDenial, sellerChannelBody, sellerCreateBodies } from "./seller-payload.ts";
import { suggestSellerGatewayName } from "./seller-name.ts";
import { classifyAuthBody, refreshCookieFromHeaders, tokenNeedsRefresh, SELLER_RENEW_WITHIN_MS } from "./seller-auth.ts";

test("seller name defaults to ainow-seller and can be derived from the host", () => {
  assert.equal(suggestSellerGatewayName(""), "ainow-seller");
  assert.equal(suggestSellerGatewayName("https://ainow-4o14n1.haoyi666.com"), "ainow-seller");
  assert.equal(suggestSellerGatewayName("https://gateway.example.com"), "gateway-seller");
});

test("access token renews only inside 60 seconds", () => {
  const now = 1_000_000;
  assert.equal(tokenNeedsRefresh(now + SELLER_RENEW_WITHIN_MS - 1, now), true);
  assert.equal(tokenNeedsRefresh(now + SELLER_RENEW_WITHIN_MS, now), false);
  assert.equal(tokenNeedsRefresh(0, now), true);
});

test("mfa and captcha are not treated as a bad password", () => {
  assert.equal(classifyAuthBody(200, { data: { mfa_setup_required: true } }), "mfa");
  assert.equal(classifyAuthBody(200, { data: { require_2fa: true } }), "mfa");
  assert.equal(classifyAuthBody(400, { message: "请完成验证码" }), "captcha");
  assert.equal(classifyAuthBody(200, { success: false, message: "用户名或密码错误" }), "credentials");
});

test("refresh cookie is read from set-cookie and not from the body", () => {
  const headers = new Headers();
  headers.append("set-cookie", "new_api_refresh=rotated-cookie; Path=/api/user/auth; HttpOnly");
  assert.equal(refreshCookieFromHeaders(headers), "rotated-cookie");
});

test("seller consumption is the snapshot delta and never guesses across a gap", () => {
  const amount = resolveSellerConsumption("2026-10-18", [
    { day: "2026-10-18", baseline: 100, source: "snapshot" },
    { day: "2026-10-19", baseline: 140, source: "snapshot" },
  ]);
  assert.equal(amount.kind, "amount");
  if (amount.kind === "amount") assert.equal(amount.consumption, 40);
  const missing = resolveSellerConsumption("2026-10-18", [{ day: "2026-10-20", baseline: 900, source: "snapshot" }]);
  assert.equal(missing.kind, "unsynced");
  assert.notEqual(missing.kind, "amount");
  const anchor = resolveSellerConsumption("2026-10-17", [
    { day: "2026-10-18", baseline: 50, source: "import-anchor" },
  ]);
  assert.equal(anchor.kind, "skip");
  const afterImport = resolveSellerConsumption("2026-10-18", [
    { day: "2026-10-18", baseline: 50, source: "import-anchor" },
    { day: "2026-10-19", baseline: 80, source: "snapshot" },
  ]);
  assert.equal(afterImport.kind, "amount");
  if (afterImport.kind === "amount") assert.equal(afterImport.consumption, 30);
});

test("seller payload drops hidden fields and sends one key at a time", () => {
  const body = sellerChannelBody(
    {
      channel: {
        name: "qa",
        type: 1,
        key: "sk-a",
        base_url: "https://up.example",
        models: "gpt",
        group: "default",
        param_override: "{}",
        header_override: "{}",
        status_code_mapping: "{}",
        tag: "t",
        auto_ban: 1,
        priority: 9,
        weight: 9,
        settings: JSON.stringify({ azure_responses_version: "v1", force_format: true }),
      },
    },
    false,
  );
  const channel = body.channel as Record<string, unknown>;
  assert.equal(body.mode, "single");
  assert.equal("param_override" in channel, false);
  assert.equal("header_override" in channel, false);
  assert.equal("status_code_mapping" in channel, false);
  assert.equal("tag" in channel, false);
  assert.equal("auto_ban" in channel, false);
  assert.equal("priority" in channel, false);
  assert.equal("weight" in channel, false);
  assert.equal(JSON.parse(String(channel.settings)).force_format, undefined);
  assert.equal(JSON.parse(String(channel.settings)).azure_responses_version, "v1");
  const split = sellerCreateBodies({ channel: { name: "qa", key: "sk-a\nsk-b" } });
  assert.equal(split.length, 2);
  assert.equal((split[0]?.channel as { key: string }).key, "sk-a");
  assert.equal((split[1]?.channel as { key: string }).key, "sk-b");
  assert.equal(isBaseUrlDenial("base_url not allowed for seller channel"), true);
  assert.equal(atChannelCap({ canWrite: true, canToggle: true, canEditRouting: false, maxChannels: 2, total: 2 }, 1), true);
  assert.equal(atChannelCap({ canWrite: true, canToggle: true, canEditRouting: false, maxChannels: 0, total: 26 }, 1), false);
});
