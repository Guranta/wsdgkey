import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { adoptLegacyDatabase, isSqliteDatabase } from "./adopt-legacy-db.ts";
import { pinSqliteToVolume, resolveSqlitePath, VOLUME_SQLITE_PATH } from "./paths.ts";

function seedSqlite(file: string, userId: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE users (id TEXT)");
  db.prepare("INSERT INTO users (id) VALUES (?)").run(userId);
  db.close();
}

function userId(file: string): string {
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT id FROM users").get() as { id: string };
  db.close();
  return row.id;
}

test("a 1.1KB stub is not a sqlite database", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "newapi-stub-"));
  const file = path.join(dir, "app.db");
  writeFileSync(file, Buffer.alloc(1100, 1));
  assert.equal(isSqliteDatabase(file), false);
  assert.equal(statSafe(file), 1100);
});

function statSafe(file: string): number {
  return readFileSync(file).length;
}

test("adopts a legacy database over a non-sqlite stub and keeps the user", () => {
  const root = mkdtempSync(path.join(tmpdir(), "newapi-adopt-"));
  const legacy = path.join(root, "app", "data", "app.db");
  seedSqlite(legacy, "kept-user");
  writeFileSync(`${legacy}-wal`, "wal-bytes");
  writeFileSync(path.join(root, "app", "data", "token.key"), "legacy-key");
  writeFileSync(path.join(root, "app", "data", "session.secret"), "legacy-secret");
  const target = path.join(root, "vol", "app.db");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.alloc(1100, 2));
  writeFileSync(path.join(root, "vol", "token.key"), "keep-me");

  const result = adoptLegacyDatabase({ target, candidates: [legacy, path.join(root, "missing.db")] });
  assert.equal(result.adoptedFrom, path.resolve(legacy));
  assert.equal(result.movedAside, true);
  assert.equal(isSqliteDatabase(target), true);
  assert.equal(readFileSync(`${target}-wal`, "utf8"), "wal-bytes");
  assert.equal(userId(target), "kept-user");
  assert.equal(existsSync(`${target}.not-sqlite`), true);
  assert.equal(readFileSync(`${target}.not-sqlite`).length, 1100);
  assert.equal(readFileSync(path.join(root, "vol", "token.key"), "utf8"), "keep-me");
  assert.equal(readFileSync(path.join(root, "vol", "session.secret"), "utf8"), "legacy-secret");
});

test("does not overwrite a valid sqlite file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "newapi-keep-"));
  const legacy = path.join(root, "legacy.db");
  const target = path.join(root, "app.db");
  seedSqlite(legacy, "old");
  seedSqlite(target, "current");
  const result = adoptLegacyDatabase({ target, candidates: [legacy, target] });
  assert.equal(result.adoptedFrom, null);
  assert.equal(userId(target), "current");
});

test("moves a stub aside when no legacy database exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "newapi-aside-"));
  const target = path.join(root, "app.db");
  writeFileSync(target, Buffer.alloc(1100, 3));
  const result = adoptLegacyDatabase({ target, candidates: [path.join(root, "nope.db")] });
  assert.equal(result.adoptedFrom, null);
  assert.equal(result.movedAside, true);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(`${target}.not-sqlite`), true);
});

test("relative container path is pinned to the named volume", () => {
  const relative = resolveSqlitePath("file:./data/app.db", "/app");
  assert.equal(relative, "/app/data/app.db");
  assert.equal(
    pinSqliteToVolume(relative, { nodeEnv: "production", docker: true }),
    VOLUME_SQLITE_PATH,
  );
  assert.equal(pinSqliteToVolume(VOLUME_SQLITE_PATH, { nodeEnv: "production", docker: true }), VOLUME_SQLITE_PATH);
  assert.equal(pinSqliteToVolume(relative, { nodeEnv: "production", docker: true, phase: "phase-production-build" }), relative);
  assert.equal(pinSqliteToVolume(relative, { nodeEnv: "development", docker: true }), relative);
  assert.equal(pinSqliteToVolume(relative, { nodeEnv: "production", docker: false }), relative);
  assert.equal(pinSqliteToVolume("/tmp/custom.db", { nodeEnv: "production", docker: true }), "/tmp/custom.db");
});
