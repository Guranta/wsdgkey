import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-sync-recovery-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key-sync-recovery";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

const TOKEN = "access-secret-token";
const PASSWORD = "secret-password";

test("a rejected catalog does not mark channels missing, and a verified list still does", async () => {
  const { resetDatabaseForTests, dbGet, dbRun, dbAll, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests, encryptSecret } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { resetSellerAuthForTests, sellerRequest } = await import("./seller-auth.ts");
  const { resetListSweepForTests, syncGatewayPage, queryChannels } = await import("./channel-service.ts");
  const { authenticate } = await import("./users.ts");
  const { refillSupplierSnapshots, runSupplierSnapshots } = await import("./supplier-billing.ts");
  const { billingView } = await import("./billing-service.ts");
  const { addDays, shanghaiClock, shanghaiMidnight } = await import("./shanghai.ts");
  resetSellerAuthForTests();
  resetListSweepForTests();
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  const today = shanghaiClock().day;
  const yesterday = addDays(today, -1);

  await dbRun(
    `INSERT INTO gateways (
      id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, username, password_cipher,
      refresh_cookie_cipher, session_sid_cipher, access_token_cipher, access_expires_at, auth_status, disabled
    ) VALUES ('gw-sup', 'supplier', 'https://seller.example', '', '1', 0, ?, ?, 'newapi_supplier', 'vendor', ?, ?, ?, ?, ?, 'ok', 0)`,
    [now, now, encryptSecret(PASSWORD), encryptSecret("cookie-1"), encryptSecret("sid-1"), encryptSecret(TOKEN), now + 600_000],
  );
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, disabled)
     VALUES ('gw-admin', 'admin', 'http://127.0.0.1', ?, '1', 0, ?, ?, 'newapi_admin', 0)`,
    [encryptSecret("nap-test-token"), now, now],
  );
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, disabled)
     VALUES ('gw-off', 'paused', 'https://paused.example', '', '1', 0, ?, ?, 'newapi_admin', 1)`,
    [now, now],
  );
  const insertChannel = async (id: string, gatewayId: string, upstreamId: number) => {
    await dbRun(
      `INSERT INTO channels (id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_here, upstream_missing, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'default', 1, 1, 0, 'ok', ?, ?)`,
      [id, gatewayId, upstreamId, admin.id, id, now, now],
    );
  };
  await insertChannel("ch-keep", "gw-sup", 11);
  await insertChannel("ch-late", "gw-sup", 12);
  await insertChannel("ch-gone", "gw-sup", 13);
  await insertChannel("ch-admin-live", "gw-admin", 11);
  await insertChannel("ch-admin-gone", "gw-admin", 13);
  await insertChannel("ch-off", "gw-off", 99);

  const lines: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => {
    lines.push(String(message ?? ""));
  };
  let refreshes = 0;
  let listCalls = 0;
  let denyAlways = false;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/user/auth/refresh")) {
      refreshes += 1;
      return new Response(
        JSON.stringify({ success: true, data: { access_token: TOKEN, access_expires_at: Math.floor((now + 900_000) / 1000), session: { sid: "sid-2" }, user: { id: 9 } } }),
        { status: 200, headers: { "content-type": "application/json", "set-cookie": "new_api_refresh=cookie-2; Path=/; HttpOnly" } },
      );
    }
    if (url.endsWith("/api/user/login")) {
      return new Response(JSON.stringify({ success: false, message: "用户名或密码错误" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    listCalls += 1;
    if (denyAlways || listCalls === 1) return new Response(JSON.stringify({ success: false, message: "Access denied" }), { status: 403, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ success: true, data: { items: [{ id: 11, name: "keep", type: 1, status: 1 }], total: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const body = await sellerRequest("gw-sup", "https://seller.example", "/api/channel/?p=1&page_size=20", {}, fetcher);
    assert.equal((body as { success: boolean }).success, true);
    assert.equal(refreshes, 1);
    assert.equal(listCalls, 2);
    assert.equal(lines.some((line) => line.includes(TOKEN) || line.includes(PASSWORD) || line.includes("cookie-1")), false);

    listCalls = 0;
    denyAlways = true;
    await assert.rejects(
      () => sellerRequest("gw-sup", "https://seller.example", "/api/channel/?p=1&page_size=20", {}, fetcher),
      (error: unknown) => {
        assert.equal(typeof error === "object" && error && "status" in error ? (error as { status: number }).status : 0, 403);
        return true;
      },
    );
    assert.equal(refreshes, 1);
    assert.equal(lines.some((line) => line.includes("seller renew skipped") && line.includes("gw-sup") && line.includes("cooldown")), true);
  } finally {
    console.info = original;
  }

  type Mode = "deny" | "empty" | "missing-total" | "short" | "full" | "snapshot";
  let mode: Mode = "deny";
  const billing = (id: number, amount: string) => ({
    id,
    name: `ch-${id}`,
    type: 1,
    status: 1,
    used_quota: 10,
    customer_billing: { state: "ready", amount_usd: amount, exchange_rate: "7.2", source: "dianju_call_logs" },
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/user/auth/refresh") {
      send(200, { success: true, data: { access_token: TOKEN, access_expires_at: Math.floor(Date.now() / 1000) + 900, session: { sid: "sid-2" }, user: { id: 9 } } });
      return;
    }
    if (url.pathname === "/api/user/login") {
      send(200, { success: false, message: "用户名或密码错误" });
      return;
    }
    if (url.pathname === "/api/channel/" || url.pathname === "/api/channel") {
      if (mode === "deny") {
        send(403, { success: false, message: "Access denied" });
        return;
      }
      if (mode === "empty") {
        send(200, { success: true, data: { items: [] } });
        return;
      }
      if (mode === "missing-total") {
        send(200, { success: true, data: { items: [billing(11, "1")] } });
        return;
      }
      if (mode === "short") {
        send(200, { success: true, data: { items: [billing(11, "99")], total: 40 } });
        return;
      }
      if (mode === "full") {
        send(200, { success: true, data: { items: [billing(11, "1")], total: 1 } });
        return;
      }
      send(200, { success: true, data: { items: [billing(11, "99"), billing(12, "4")], total: 2 } });
      return;
    }
    send(404, { success: false, message: "missing" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  await dbRun("UPDATE gateways SET base_url = ? WHERE id IN ('gw-sup', 'gw-admin')", [base]);

  const channel = async (id: string) =>
    (await dbGet("SELECT status, upstream_missing, sync_status FROM channels WHERE id = ?", [id])) as
      | { status: number; upstream_missing: number; sync_status: string }
      | undefined;
  const syncLines: string[] = [];
  console.info = (message?: unknown) => {
    syncLines.push(String(message ?? ""));
  };
  try {
    mode = "deny";
    const denied = await syncGatewayPage("gw-sup", 1);
    assert.equal(denied.done, true);
    assert.equal(denied.aborted, true);
    for (const id of ["ch-keep", "ch-late", "ch-gone"]) {
      const row = await channel(id);
      assert.equal(Number(row?.status), 1, id);
      assert.equal(Number(row?.upstream_missing), 0, id);
      assert.equal(row?.sync_status, "failed", id);
    }
    const gatewayRow = await dbGet("SELECT list_sync_status FROM gateways WHERE id = 'gw-sup'");
    assert.equal(gatewayRow?.list_sync_status, "failed");
    assert.equal(syncLines.some((line) => line.includes("gateway=gw-sup") && line.includes("page=1") && line.includes("status=403") && line.includes("total=missing") && line.includes("items=0")), true);
    assert.equal(syncLines.some((line) => line.includes(TOKEN) || line.includes(PASSWORD) || line.includes("cookie-")), false);

    mode = "empty";
    const empty = await syncGatewayPage("gw-admin", 1);
    assert.equal(empty.aborted, true);
    assert.equal(Number((await channel("ch-admin-gone"))?.upstream_missing), 0);
    assert.equal(Number((await channel("ch-admin-live"))?.upstream_missing), 0);

    mode = "missing-total";
    resetListSweepForTests();
    const missingTotal = await syncGatewayPage("gw-admin", 1);
    assert.equal(missingTotal.aborted, true);
    assert.equal(Number((await channel("ch-admin-gone"))?.upstream_missing), 0);
    assert.equal((await channel("ch-admin-gone"))?.sync_status, "failed");
    assert.equal(Number((await channel("ch-admin-live"))?.upstream_missing), 0);

    mode = "short";
    resetListSweepForTests();
    const short = await syncGatewayPage("gw-admin", 1);
    assert.equal(short.aborted, true);
    assert.equal(Number((await channel("ch-admin-gone"))?.upstream_missing), 0);

    mode = "full";
    resetListSweepForTests();
    const verified = await syncGatewayPage("gw-admin", 1);
    assert.equal(verified.done, true);
    assert.equal(verified.aborted, false);
    assert.equal(Number((await channel("ch-admin-live"))?.upstream_missing), 0);
    assert.equal(Number((await channel("ch-admin-gone"))?.upstream_missing), 1);
    assert.equal((await channel("ch-admin-gone"))?.sync_status, "missing");

    await dbRun("INSERT INTO app_settings (key, value) VALUES ('supplier_billing_enabled', '1')");
    await dbRun(
      `INSERT INTO billing_snapshots (channel_id, day, source_id, quality, amount, unit, pulled_at, note)
       VALUES ('ch-keep', ?, 'customer_billing', 'ok', 9, 'usd', ?, 'import-anchor')`,
      [today, now],
    );
    await runSupplierSnapshots(shanghaiMidnight(yesterday) + 60_000);
    const yesterdayRows = await dbAll("SELECT day FROM billing_snapshots WHERE day = ? AND channel_id NOT LIKE '__gw__:%'", [yesterday]);
    assert.equal(yesterdayRows.length, 0);

    mode = "empty";
    const emptySnap = await refillSupplierSnapshots(shanghaiMidnight(today) + 20 * 60_000);
    assert.equal(emptySnap.gateways[0]?.outcome, "abort");
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_snapshots WHERE note = 'gateway-done'"))?.n), 0);
    assert.equal(Number((await dbGet("SELECT amount FROM billing_snapshots WHERE channel_id = 'ch-keep' AND day = ?", [today]))?.amount), 9);

    mode = "short";
    const shortSnap = await refillSupplierSnapshots(shanghaiMidnight(today) + 20 * 60_000);
    assert.equal(shortSnap.gateways[0]?.outcome, "abort");
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_snapshots WHERE note = 'gateway-done'"))?.n), 0);
    assert.equal(Number((await dbGet("SELECT amount FROM billing_snapshots WHERE channel_id = 'ch-keep' AND day = ?", [today]))?.amount), 9);

    mode = "snapshot";
    const filled = await refillSupplierSnapshots(shanghaiMidnight(today) + 20 * 60_000);
    assert.equal(filled.day, today);
    assert.equal(filled.gateways[0]?.outcome, "complete");
    assert.equal(Number((await dbGet("SELECT amount FROM billing_snapshots WHERE channel_id = 'ch-keep' AND day = ?", [today]))?.amount), 9);
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_snapshots WHERE channel_id = 'ch-keep' AND day = ?", [today]))?.n), 1);
    const late = await dbGet("SELECT amount, note FROM billing_snapshots WHERE channel_id = 'ch-late' AND day = ?", [today]);
    assert.equal(Number(late?.amount), 4);
    assert.match(String(late?.note), /late/);
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_snapshots WHERE channel_id = 'ch-gone'"))?.n), 0);
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_snapshots WHERE note = 'gateway-done' AND day = ?", [today]))?.n), 1);
    const again = await refillSupplierSnapshots(shanghaiMidnight(today) + 20 * 60_000);
    assert.equal(again.gateways[0]?.filled, 0);
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_snapshots WHERE channel_id = 'ch-late' AND day = ?", [today]))?.n), 1);

    await dbRun(
      `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, total_count, ok_count, failed_count)
       VALUES (?, ?, 'published', ?, ?, 1, 1, 0)`,
      [today, yesterday, now, now],
    );
    const bill = await billingView(admin, { day: yesterday });
    assert.equal(bill.incomplete, true);
    const supplierRows = bill.rows.filter((row) => row.billingMode === "snapshot");
    assert.ok(supplierRows.length >= 3);
    for (const row of supplierRows) {
      assert.equal(row.consumption, null);
      assert.notEqual(row.consumption, 0);
    }

    await dbRun("UPDATE channels SET sync_status = 'ok', sync_error = NULL, upstream_missing = 0");
    await dbRun("UPDATE channels SET sync_status = 'failed', upstream_missing = 0 WHERE id = 'ch-admin-live'");
    await dbRun("UPDATE channels SET sync_status = 'failed', upstream_missing = 1, sync_error = 'Access denied' WHERE id = 'ch-off'");
    const overview = await queryChannels(admin, new URLSearchParams());
    assert.equal(overview.stats.pullFailed, 1);
    assert.equal(overview.stats.pausedGateways, 1);
    assert.equal(overview.stats.anomaly, 0);
  } finally {
    console.info = original;
    server.close();
  }
});
