import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-auth-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";

test("tokens are encrypted at rest and suppliers cannot see each other", async () => {
  const { resetDatabaseForTests, dbGet, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests, decryptSecret, encryptSecret } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  const round = encryptSecret("sk-supplier-secret");
  assert.equal(round.includes("sk-supplier-secret"), false);
  assert.equal(decryptSecret(round), "sk-supplier-secret");

  await ensureReady();
  const { authenticate, createSupplier, resetPassword, setUserDisabled } = await import("./users.ts");
  const { createConnection, listConnections, revealToken } = await import("./connection-store.ts");

  const admin = await authenticate("admin", "admin-pass-123");
  assert.equal(typeof admin === "object" && admin.role, "admin");
  if (typeof admin !== "object") return;

  const supplier = await createSupplier({ username: "shop", name: "华东供应商", password: "supplier-pass" });
  const other = await createSupplier({ username: "other", name: "另一家", password: "supplier-pass" });
  assert.equal(supplier.role, "supplier");
  const created = await createConnection(supplier, {
    name: "站点 A",
    siteBase: "https://api.example.com/v1",
    token: "sk-supplier-secret",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const stored = await dbGet("SELECT token_cipher FROM connections WHERE id = ?", [created.connection.id]);
  assert.equal(String(stored?.token_cipher).includes("sk-supplier-secret"), false);

  const own = await listConnections(supplier);
  assert.equal(own.length, 1);
  assert.equal(own[0]?.tokenMasked.includes("sk-supplier-secret"), false);
  assert.equal(own[0]?.ownerUsername, "shop");
  assert.equal(await revealToken(created.connection.id, supplier), "sk-supplier-secret");

  const hidden = await listConnections(other);
  assert.equal(hidden.length, 0);
  assert.equal(await revealToken(created.connection.id, other), null);
  assert.equal(await revealToken(created.connection.id, admin), null);

  const visible = await listConnections(admin);
  assert.equal(visible.some((item) => item.id === created.connection.id), true);
  assert.equal(visible.find((item) => item.id === created.connection.id)?.owned, false);

  assert.equal(await setUserDisabled(supplier.id, true, admin), "ok");
  assert.equal(await setUserDisabled(admin.id, true, admin), "self");
  assert.equal(await resetPassword(supplier.id, "supplier-pass-2"), "ok");
  assert.equal(await authenticate("shop", "supplier-pass"), "invalid");
  assert.equal(await authenticate("shop", "supplier-pass-2"), "disabled");
  assert.equal(await authenticate("shop", "wrong-pass"), "invalid");
  await assert.rejects(() => createSupplier({ username: "shop@example.com", password: "supplier-pass" }));
});

test("legacy email admin is renamed to ADMIN_USERNAME without resetting the password", async () => {
  const { resetDatabaseForTests, ensureReady, dbGet } = await import("./db.ts");
  const { hashPassword } = await import("./password.ts");
  resetDatabaseForTests();
  const file = path.join(dir, "legacy.db");
  process.env.DATABASE_URL = `file:${file}`;
  process.env.ADMIN_USERNAME = "root";
  process.env.ADMIN_PASSWORD = "should-not-replace";
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  raw
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 'admin', 0, ?)",
    )
    .run("id-1", "admin@example.com", await hashPassword("kept-password"), "管理员", 1);
  raw.close();

  await ensureReady();
  const row = await dbGet("SELECT username, credential_version FROM users WHERE id = ?", ["id-1"]);
  assert.equal(row?.username, "root");
  assert.equal(Number(row?.credential_version), 0);
  const { authenticate } = await import("./users.ts");
  const signedIn = await authenticate("root", "kept-password");
  assert.equal(typeof signedIn, "object");
  assert.equal(await authenticate("root", "should-not-replace"), "invalid");
  assert.equal(await authenticate("admin@example.com", "kept-password"), "invalid");
});
