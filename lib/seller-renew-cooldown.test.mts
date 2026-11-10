import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-renew-cooldown-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key-renew-cooldown";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

const TOKEN = "access-secret-token";
const PASSWORD = "secret-password";
const N = 8;

test("forced seller renewal is single-flight and then cooled down for 60s", async () => {
  const { resetDatabaseForTests, dbGet, dbRun, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests, encryptSecret } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { resetSellerAuthForTests, sellerRequest, FORCED_RENEW_COOLDOWN_MS } = await import("./seller-auth.ts");
  const { syncGatewayPage } = await import("./channel-service.ts");
  resetSellerAuthForTests();
  assert.equal(FORCED_RENEW_COOLDOWN_MS, 60_000);
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (
      id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, username, password_cipher,
      refresh_cookie_cipher, session_sid_cipher, access_token_cipher, access_expires_at, auth_status, disabled
    ) VALUES ('gw-cool', 'supplier', 'https://seller.example', '', '1', 0, ?, ?, 'newapi_supplier', 'vendor', ?, ?, ?, ?, ?, 'ok', 0)`,
    [now, now, encryptSecret(PASSWORD), encryptSecret("cookie-1"), encryptSecret("sid-1"), encryptSecret(TOKEN), now + 600_000],
  );
  await dbRun(
    `INSERT INTO channels (id, gateway_id, upstream_id, name, type, group_name, status, created_here, upstream_missing, sync_status, created_at, updated_at)
     VALUES ('ch-cool', 'gw-cool', 11, 'kept', 1, 'default', 2, 1, 0, 'ok', ?, ?)`,
    [now, now],
  );

  let refreshes = 0;
  let logins = 0;
  let denied = 0;
  let phase: "burst" | "later" = "burst";
  let laterCalls = 0;
  let releaseRefresh: () => void = () => undefined;
  const holdRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let markDenied: () => void = () => undefined;
  const allDenied = new Promise<void>((resolve) => {
    markDenied = () => {
      if (denied >= N) resolve();
    };
  });
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/user/auth/refresh")) {
      refreshes += 1;
      await holdRefresh;
      return new Response(
        JSON.stringify({ success: true, data: { access_token: "access-renewed", access_expires_at: Math.floor((now + 900_000) / 1000), session: { sid: "sid-2" }, user: { id: 9 } } }),
        { status: 200, headers: { "content-type": "application/json", "set-cookie": "new_api_refresh=cookie-2; Path=/; HttpOnly" } },
      );
    }
    if (url.endsWith("/api/user/login")) {
      logins += 1;
      return new Response(JSON.stringify({ success: false, message: "用户名或密码错误" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (phase === "later") {
      laterCalls += 1;
      if (laterCalls === 1) return new Response(JSON.stringify({ success: false, message: "Access denied" }), { status: 403, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ success: true, data: { items: [], total: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    denied += 1;
    markDenied();
    if (denied <= N) return new Response(JSON.stringify({ success: false, message: "Access denied" }), { status: 403, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ success: true, data: { items: [], total: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const lines: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => {
    lines.push(String(message ?? ""));
  };
  let serverRefreshes = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/user/auth/refresh" || url.pathname === "/api/user/login") {
      serverRefreshes += 1;
      send(200, { success: true, data: { access_token: "access-should-not-run", access_expires_at: Math.floor(Date.now() / 1000) + 900, session: { sid: "sid-x" }, user: { id: 1 } } });
      return;
    }
    send(403, { success: false, message: "Access denied" });
  });
  try {
    const pending = Promise.all(
      Array.from({ length: N }, () => sellerRequest("gw-cool", "https://seller.example", "/api/channel/?p=1&page_size=20", {}, fetcher, now)),
    );
    await allDenied;
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshes, 1);
    releaseRefresh();
    const bodies = await pending;
    assert.equal(bodies.length, N);
    assert.equal(refreshes, 1);
    assert.equal(logins, 0);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await dbRun("UPDATE gateways SET base_url = ? WHERE id = 'gw-cool'", [`http://127.0.0.1:${port}`]);
    const synced = await syncGatewayPage("gw-cool", 1);
    assert.equal(synced.aborted, true);
    assert.equal(serverRefreshes, 0);
    const row = await dbGet("SELECT status, upstream_missing, sync_status FROM channels WHERE id = 'ch-cool'");
    assert.equal(Number(row?.status), 2);
    assert.equal(Number(row?.upstream_missing), 0);
    assert.equal(row?.sync_status, "failed");
    assert.equal(lines.some((line) => line === "seller renew skipped gateway=gw-cool cooldown"), true);
    assert.equal(lines.some((line) => line.includes(TOKEN) || line.includes(PASSWORD) || line.includes("cookie-") || line.includes("access-renewed")), false);

    await dbRun("UPDATE gateways SET base_url = 'https://seller.example' WHERE id = 'gw-cool'");
    phase = "later";
    const before = refreshes;
    const again = await sellerRequest("gw-cool", "https://seller.example", "/api/channel/?p=1&page_size=20", {}, fetcher, now + FORCED_RENEW_COOLDOWN_MS);
    assert.equal((again as { success: boolean }).success, true);
    assert.equal(refreshes, before + 1);
    assert.equal(logins, 0);
  } finally {
    console.info = original;
    server.close();
  }
});
