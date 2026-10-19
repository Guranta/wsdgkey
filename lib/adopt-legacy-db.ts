import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { legacySqliteCandidates, sqliteFile } from "./paths";

const SQLITE_MAGIC = "SQLite format 3";
const SIDECARS = ["-wal", "-shm", "-journal"];
const SECRET_FILES = ["token.key", "session.secret"];

export function isSqliteDatabase(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(/* turbopackIgnore: true */ file, "r");
    const buf = Buffer.alloc(16);
    const read = readSync(fd, buf, 0, 16, 0);
    return read >= 15 && buf.subarray(0, 15).toString("utf8") === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function moveAside(file: string): void {
  let dest = `${file}.not-sqlite`;
  if (existsSync(/* turbopackIgnore: true */ dest)) dest = `${file}.not-sqlite.${Date.now()}`;
  const size = statSync(/* turbopackIgnore: true */ file).size;
  renameSync(/* turbopackIgnore: true */ file, dest);
  console.log(`[db] ${file} is not a sqlite database (${size} bytes); moved aside to ${dest}`);
}

export type AdoptResult = {
  adoptedFrom: string | null;
  movedAside: boolean;
};

/**
 * Copy a real SQLite file onto the configured path before DatabaseSync opens it.
 * Opening a missing path would create an empty database and hide the legacy file.
 * A target that already starts with "SQLite format 3" is left untouched.
 * A 1 KB stub is not a database (an empty SQLite file is one page, usually 4096 bytes).
 */
export function adoptLegacyDatabase(options?: { target?: string; candidates?: string[] }): AdoptResult {
  const target = options?.target ?? sqliteFile();
  const candidates = options?.candidates ?? legacySqliteCandidates();
  if (isSqliteDatabase(target)) return { adoptedFrom: null, movedAside: false };

  mkdirSync(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
  for (const candidate of candidates) {
    if (!candidate || samePath(candidate, target)) continue;
    if (!isSqliteDatabase(candidate)) continue;
    let movedAside = false;
    if (existsSync(/* turbopackIgnore: true */ target)) {
      moveAside(target);
      movedAside = true;
    }
    for (const suffix of SIDECARS) {
      const extra = `${target}${suffix}`;
      if (existsSync(/* turbopackIgnore: true */ extra)) unlinkSync(/* turbopackIgnore: true */ extra);
    }
    copyFileSync(/* turbopackIgnore: true */ candidate, target);
    chmodSync(/* turbopackIgnore: true */ target, 0o600);
    for (const suffix of SIDECARS) {
      const from = `${candidate}${suffix}`;
      if (!existsSync(/* turbopackIgnore: true */ from)) continue;
      const dest = `${target}${suffix}`;
      copyFileSync(/* turbopackIgnore: true */ from, dest);
      chmodSync(/* turbopackIgnore: true */ dest, 0o600);
    }
    const fromDir = path.dirname(candidate);
    const toDir = path.dirname(target);
    for (const name of SECRET_FILES) {
      const from = path.join(/* turbopackIgnore: true */ fromDir, name);
      const dest = path.join(/* turbopackIgnore: true */ toDir, name);
      if (!existsSync(/* turbopackIgnore: true */ from) || existsSync(/* turbopackIgnore: true */ dest)) continue;
      copyFileSync(/* turbopackIgnore: true */ from, dest);
      chmodSync(/* turbopackIgnore: true */ dest, 0o600);
    }
    console.log(`[db] adopted legacy sqlite ${candidate} -> ${target}`);
    return { adoptedFrom: path.resolve(candidate), movedAside };
  }

  if (existsSync(/* turbopackIgnore: true */ target)) {
    moveAside(target);
    return { adoptedFrom: null, movedAside: true };
  }
  return { adoptedFrom: null, movedAside: false };
}
