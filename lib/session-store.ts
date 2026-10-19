import { randomBytes } from "node:crypto";
import { dbGet, dbRun } from "./db";

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const LAST_SEEN_GAP_MS = 60_000;

export async function createServerSession(userId: string, now = Date.now()): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await dbRun(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at, last_seen) VALUES (?, ?, ?, ?, NULL, ?)`,
    [id, userId, now, now + SESSION_TTL_MS, now],
  );
  return id;
}

export async function revokeServerSession(id: string, now = Date.now()): Promise<void> {
  await dbRun("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]);
}

export async function revokeUserSessions(userId: string, now = Date.now()): Promise<void> {
  await dbRun("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
}

/** A session the server still accepts. Revoked, expired, and unknown ids are rejected. */
export async function liveSession(id: string, now = Date.now()): Promise<{ userId: string } | null> {
  const row = (await dbGet("SELECT user_id, expires_at, revoked_at, last_seen FROM sessions WHERE id = ?", [id])) as
    | { user_id?: string; expires_at?: number; revoked_at?: number | null; last_seen?: number }
    | undefined;
  if (!row?.user_id) return null;
  if (row.revoked_at != null) return null;
  if (Number(row.expires_at) <= now) return null;
  if (Number(row.last_seen ?? 0) < now - LAST_SEEN_GAP_MS) {
    await dbRun("UPDATE sessions SET last_seen = ? WHERE id = ?", [now, id]);
  }
  return { userId: String(row.user_id) };
}
