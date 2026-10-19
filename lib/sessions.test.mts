import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-sessions-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";

test("old cookie after logout, disable, and password reset is 401", async () => {
  const { resetDatabaseForTests, ensureReady } = await import("./db.ts");
  resetDatabaseForTests();
  await ensureReady();
  const { authenticate, createSupplier, logoutAllDevices, resetPassword, setUserDisabled } = await import("./users.ts");
  const { createServerSession, revokeServerSession } = await import("./session-store.ts");
  const { sessionGate } = await import("./session-access.ts");

  const admin = await authenticate("admin", "admin-pass-123");
  assert.equal(typeof admin, "object");
  if (typeof admin !== "object") return;
  const supplier = await createSupplier({ username: "shop", name: "华东供应商", password: "supplier-pass" });

  const loggedIn = await createServerSession(supplier.id);
  assert.equal((await sessionGate(loggedIn, supplier.credentialVersion)).status, 200);
  await revokeServerSession(loggedIn);
  const afterLogout = await sessionGate(loggedIn, supplier.credentialVersion);
  assert.equal(afterLogout.status, 401);
  if (afterLogout.status === 401) assert.equal(afterLogout.reason, "loginRequired");

  const beforeDisable = await createServerSession(supplier.id);
  assert.equal(await setUserDisabled(supplier.id, true, admin), "ok");
  const afterDisable = await sessionGate(beforeDisable, supplier.credentialVersion);
  assert.equal(afterDisable.status, 401);

  const beforeReset = await createServerSession(supplier.id);
  assert.equal(await resetPassword(supplier.id, "supplier-pass-2"), "ok");
  const afterReset = await sessionGate(beforeReset, supplier.credentialVersion);
  assert.equal(afterReset.status, 401);

  const beforeAll = await createServerSession(admin.id);
  assert.equal((await sessionGate(beforeAll, admin.credentialVersion)).status, 200);
  assert.equal(await logoutAllDevices(admin.id), "ok");
  assert.equal((await sessionGate(beforeAll, admin.credentialVersion)).status, 401);
  assert.equal((await sessionGate(undefined, admin.credentialVersion)).status, 401);
});
