import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-recon-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

test("a locked month keeps the check and still accepts an adjustment", async () => {
  const { resetDatabaseForTests, dbGet, dbRun, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { authenticate } = await import("./users.ts");
  const { syncReconChannel, applyReconAction } = await import("./recon-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  assert.equal(typeof admin === "object" && admin.role, "admin");
  if (typeof admin !== "object") return;

  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at)
     VALUES ('demo', '演示', 'https://demo.invalid', '', '1', 1, ?, ?)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_here, upstream_missing, created_at, updated_at)
     VALUES ('ch1', 'demo', 7, ?, '主渠道', 1, 'default', 1, 1, 0, ?, ?)`,
    [admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
     VALUES ('ch1', '2026-10-17', 1000, 1000, 0, 'exact', ?), ('ch1', '2026-10-18', 5000, 5000, 0, 'exact', ?)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, label, consumption, kind, test_quota, finding, log_quota)
     VALUES ('2026-10-17:ch1', '2026-10-17', 'ch1', '2026-10-17', '2026-10-17', 1, NULL, 4000, 'amount', 0, '', 4000)`,
  );
  await syncReconChannel("2026-10-17", "ch1");
  const first = await dbGet("SELECT check_status, ours_quota FROM recon_rows WHERE id = '2026-10-17:ch1'");
  assert.equal(first?.check_status, "match");
  assert.equal(Number(first?.ours_quota), 4000);

  await applyReconAction(admin, { action: "lock", month: "2026-10" });
  await dbRun("UPDATE billing_rows SET consumption = 100 WHERE id = '2026-10-17:ch1'");
  await syncReconChannel("2026-10-17", "ch1");
  const locked = await dbGet("SELECT check_status, ours_quota FROM recon_rows WHERE id = '2026-10-17:ch1'");
  assert.equal(Number(locked?.ours_quota), 4000);
  assert.equal(locked?.check_status, "match");

  await applyReconAction(admin, { action: "adjust", id: "2026-10-17:ch1", amountQuota: -50, note: "手工冲减" });
  const adjustment = await dbGet("SELECT amount_quota, note FROM recon_adjustments WHERE channel_id = 'ch1'");
  assert.equal(Number(adjustment?.amount_quota), -50);
  assert.equal(adjustment?.note, "手工冲减");
  await assert.rejects(() => applyReconAction(admin, { action: "resolve", id: "2026-10-17:ch1", note: "no" }), /periodLocked|reconNothing/);
});
