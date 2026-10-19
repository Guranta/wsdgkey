import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-rebind-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

test("rebind rejects a second holder, fills the old segment, and keeps history", async () => {
  const { resetDatabaseForTests, dbAll, dbGet, dbRun, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { authenticate, createSupplier } = await import("./users.ts");
  const { rebindChannel } = await import("./rebind.ts");
  const { bindSegmentConsumption } = await import("./billing-math.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  assert.equal(typeof admin === "object" && admin.role, "admin");
  if (typeof admin !== "object") return;
  const supplier = await createSupplier({ username: "north", name: "north_lab", password: "supplier-pass" });
  const now = Date.parse("2026-10-19T10:00:00+08:00");
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at)
     VALUES ('gw', '演示', 'https://demo.invalid', '', '1', 1, ?, ?)`,
    [now, now],
  );
  async function seed(id: string, upstream: number, owner: string) {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, used_quota, created_here, upstream_missing
      ) VALUES (?, 'gw', ?, ?, ?, 1, 'default', 1, ?, ?, 400, 1, 1)`,
      [id, upstream, owner, id, now - 86_400_000, now],
    );
    await dbRun(
      `INSERT INTO channel_bindings (id, record_id, gateway_id, newapi_channel_id, bound_at, reason, bind_snapshot)
       VALUES (?, ?, 'gw', ?, ?, 'seed', 100)`,
      [`bind-${id}`, id, upstream, now - 86_400_000],
    );
  }
  await seed("rec-a", 10, supplier.id);
  await seed("rec-b", 11, admin.id);
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, consumption, kind)
     VALUES ('2026-10-18:rec-a', '2026-10-18', 'rec-a', '2026-10-18', '2026-10-18', 1, 40, 'amount')`,
  );

  const held = await rebindChannel(admin, "rec-b", 10, {
    fetchChannel: async () => ({ usedQuota: 900 }),
    logQuota: async () => 0,
    now: () => now,
  }).catch((error: unknown) => error);
  assert.equal(held instanceof Error && held.message, "bindingHeld");
  const values = (held as { values?: { record?: string; owner?: string } }).values;
  assert.equal(values?.record, "rec-a");
  assert.equal(values?.owner, "north_lab");
  assert.equal(bindSegmentConsumption(1280, 900), 380);
  assert.equal(bindSegmentConsumption(null, 900), null);

  const filled = await rebindChannel(admin, "rec-a", 73, {
    fetchChannel: async (_gateway, id) => (id === 73 ? { usedQuota: 900 } : null),
    logQuota: async (_gateway, id) => (id === 10 ? 55 : null),
    now: () => now,
  });
  assert.equal(filled.from, 10);
  assert.equal(filled.to, 73);
  assert.equal(filled.snapshot, 900);
  assert.equal(filled.closeStatus, "amount");
  assert.equal(filled.closeQuota, 55);

  const unread = await rebindChannel(admin, "rec-b", 74, {
    fetchChannel: async () => ({ usedQuota: 10 }),
    logQuota: async () => null,
    now: () => now + 1000,
  });
  assert.equal(unread.closeStatus, "unsynced");
  assert.equal(unread.closeQuota, null);

  const channel = await dbGet("SELECT id, upstream_id, creator_user_id FROM channels WHERE id = 'rec-a'");
  assert.equal(channel?.id, "rec-a");
  assert.equal(Number(channel?.upstream_id), 73);
  assert.equal(channel?.creator_user_id, supplier.id);
  const history = await dbAll("SELECT newapi_channel_id, unbound_at, close_quota, close_status FROM channel_bindings WHERE record_id = 'rec-a' ORDER BY bound_at");
  assert.equal(history.length, 2);
  assert.equal(Number(history[0]?.newapi_channel_id), 10);
  assert.ok(history[0]?.unbound_at);
  assert.equal(Number(history[0]?.close_quota), 55);
  assert.equal(history[1]?.unbound_at ?? null, null);
  const bill = await dbGet("SELECT channel_id, consumption FROM billing_rows WHERE id = '2026-10-18:rec-a'");
  assert.equal(bill?.channel_id, "rec-a");
  assert.equal(Number(bill?.consumption), 40);
  const audits = await dbAll("SELECT action FROM channel_audits WHERE channel_id = 'rec-a' ORDER BY created_at");
  assert.deepEqual(audits.map((item) => item.action), ["unbind", "bind"]);
  const missing = await rebindChannel(admin, "rec-a", 404, {
    fetchChannel: async () => null,
    logQuota: async () => 1,
    now: () => now,
  }).catch((error: unknown) => error);
  assert.equal(missing instanceof Error && missing.message, "bindingTargetMissing");
});
