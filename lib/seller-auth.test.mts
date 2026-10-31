import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-seller-auth-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key-seller-auth";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";

test("refresh rotates the cookie, a 401 retries once, and password login is capped", async () => {
  const { resetDatabaseForTests, dbRun, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests, encryptSecret, decryptSecret } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { resetSellerAuthForTests, sellerRequest, passwordLogin, SELLER_LOGIN_LIMIT } = await import("./seller-auth.ts");
  resetSellerAuthForTests();
  const id = "gw-seller";
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (
      id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, username, password_cipher,
      refresh_cookie_cipher, session_sid_cipher, access_token_cipher, access_expires_at, auth_status
    ) VALUES (?, 'ainow-seller', 'https://seller.example', '', '', 0, ?, ?, 'newapi_seller', 'vendor', ?, ?, ?, ?, ?, 'ok')`,
    [id, now, now, encryptSecret("secret-password"), encryptSecret("cookie-1"), encryptSecret("sid-1"), encryptSecret("access-old"), now + 10_000],
  );
  const lines: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => {
    lines.push(String(message ?? ""));
  };
  let refreshes = 0;
  let logins = 0;
  let calls = 0;
  let cookie = "cookie-1";
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/api/user/auth/refresh")) {
      refreshes += 1;
      assert.equal(headers.get("cookie"), `new_api_refresh=${cookie}`);
      cookie = `cookie-${refreshes + 1}`;
      return new Response(JSON.stringify({ success: true, data: { access_token: "access-new", access_expires_at: Math.floor((now + 15 * 60_000) / 1000), session: { sid: "sid-2" }, user: { id: 14 } } }), {
        status: 200,
        headers: { "set-cookie": `new_api_refresh=${cookie}; Path=/api/user/auth; HttpOnly`, "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/user/login")) {
      logins += 1;
      return new Response(JSON.stringify({ success: false, message: "用户名或密码错误" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls += 1;
    const token = headers.get("authorization");
    if (calls === 1) return new Response(JSON.stringify({ success: false, message: "unauthorized" }), { status: 401 });
    assert.equal(token, "Bearer access-new");
    return new Response(JSON.stringify({ success: true, data: { items: [], total: 0, max_channels: 30, can_write: true, can_toggle: true, can_edit_routing: false } }), { status: 200 });
  };
  try {
    const body = await sellerRequest(id, "https://seller.example", "/api/seller/channel/?p=1&page_size=20", {}, fetcher);
    assert.equal((body as { success: boolean }).success, true);
    assert.equal(refreshes, 2);
    assert.equal(logins, 0);
    assert.equal(calls, 2);
    const { dbGet } = await import("./db.ts");
    const row = await dbGet("SELECT refresh_cookie_cipher, access_token_cipher, session_sid_cipher FROM gateways WHERE id = ?", [id]);
    assert.equal(decryptSecret(String(row?.refresh_cookie_cipher)), cookie);
    assert.equal(decryptSecret(String(row?.access_token_cipher)), "access-new");
    assert.equal(decryptSecret(String(row?.session_sid_cipher)), "sid-2");
    assert.equal(lines.some((line) => line.includes("secret-password") || line.includes("access-new") || line.includes("cookie-")), false);
    await assert.rejects(() => passwordLogin("https://seller.example", "vendor", "secret-password", fetcher, now), /sellerCredentials/);
    assert.equal(logins, 1);
    for (let i = 1; i < SELLER_LOGIN_LIMIT; i += 1) {
      await assert.rejects(() => passwordLogin("https://seller.example", "vendor", "secret-password", fetcher, now), /sellerCredentials/);
    }
    const before = logins;
    await assert.rejects(() => passwordLogin("https://seller.example", "vendor", "secret-password", fetcher, now), /sellerLoginCapped/);
    assert.equal(logins, before);
  } finally {
    console.info = original;
  }
});
