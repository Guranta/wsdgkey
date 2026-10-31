import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-seller-import-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key-seller-import";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";

test("import copies seller channels once, keeps auto-disabled, and does not write upstream", async () => {
  const { resetDatabaseForTests, dbGet, dbAll, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { authenticate, createSupplier } = await import("./users.ts");
  const { createSellerGateway } = await import("./gateways.ts");
  const { importSellerChannels } = await import("./channel-service.ts");
  const { resetSellerAuthForTests } = await import("./seller-auth.ts");
  resetSellerAuthForTests();
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const supplierA = await createSupplier({ username: "shop-a", name: "甲", password: "supplier-pass" });
  const supplierB = await createSupplier({ username: "shop-b", name: "乙", password: "supplier-pass" });
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.url?.startsWith("/api/user/login")) {
      send(
        { success: true, data: { access_token: "access-token-value", access_expires_at: Math.floor(Date.now() / 1000) + 900, session: { sid: "sid-1" }, user: { id: 14 }, mfa_setup_required: false } },
        200,
        { "set-cookie": "new_api_refresh=cookie-1; Path=/api/user/auth; HttpOnly" },
      );
      return;
    }
    if (req.url?.startsWith("/api/seller/channel/")) {
      send({
        success: true,
        data: {
          items: [
            { id: 2896, name: "xl-1", type: 1, status: 3, group: "oai_gpt_data", used_quota: 151035941, models: "gpt", base_url: "" },
            { id: 2897, name: "xl-2", type: 1, status: 1, group: "oai_gpt_data", used_quota: 10, models: "gpt", base_url: "" },
          ],
          total: 2,
          max_channels: 40,
          can_write: true,
          can_toggle: true,
          can_edit_routing: false,
        },
      });
      return;
    }
    send({ success: false, message: "no writes" }, 500);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const gateway = await createSellerGateway(supplierA, { name: "custom-name", baseUrl: `http://127.0.0.1:${port}`, username: "vendor", password: "secret-password" });
    assert.equal(gateway.name, "custom-name");
    assert.equal(JSON.stringify(gateway).includes("secret-password"), false);
    assert.equal(JSON.stringify(gateway).includes("access-token-value"), false);
    assert.equal(JSON.stringify(gateway).includes("cookie-1"), false);
    const first = await importSellerChannels(supplierA, gateway.id);
    assert.deepEqual({ imported: first.imported, skipped: first.skipped, failed: first.failed, kept: first.keptAutoDisabled }, { imported: 2, skipped: 0, failed: 0, kept: 1 });
    const second = await importSellerChannels(supplierA, gateway.id);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 2);
    const rows = await dbAll("SELECT name, status, origin, creator_user_id, create_baseline, used_quota FROM channels WHERE gateway_id = ? ORDER BY upstream_id", [gateway.id]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, 3);
    assert.equal(rows[0]?.origin, "imported");
    assert.equal(rows[0]?.creator_user_id, supplierA.id);
    assert.equal(rows[0]?.create_baseline, null);
    assert.equal(Number(rows[0]?.used_quota), 151035941);
    await assert.rejects(() => importSellerChannels(supplierB, gateway.id), /gatewayMissing/);
    const writes = methods.filter((line) => !line.startsWith("GET ") && !line.startsWith("POST /api/user/login"));
    assert.deepEqual(writes, []);
    const stored = await dbGet("SELECT password_cipher FROM gateways WHERE username = 'vendor'");
    assert.equal(String(stored?.password_cipher).includes("secret-password"), false);
  } finally {
    server.close();
  }
});
