import { normalizeName, normalizePassword, normalizeUsername } from "./account";
import { dbAll, dbGet, dbRun } from "./db";
import { isLocale, type Locale } from "./locale";
import { hashPassword, verifyPassword } from "./password";
import { revokeUserSessions } from "./session-store";
import type { Role, SessionUser } from "./types";

export type UserRecord = SessionUser & {
  disabled: boolean;
  createdAt: number;
  credentialVersion: number;
  channelCount?: number;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  name: string;
  role: string;
  disabled: number;
  credential_version?: number;
  created_at: number;
  connection_count?: number;
  locale?: string | null;
};

function httpError(message: string, status: number): Error {
  const error = new Error(message);
  (error as Error & { status?: number }).status = status;
  return error;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role === "admin" ? "admin" : "supplier",
    disabled: Number(row.disabled) === 1,
    credentialVersion: Number(row.credential_version ?? 0),
    createdAt: Number(row.created_at),
    channelCount: row.connection_count === undefined ? undefined : Number(row.connection_count),
    locale: isLocale(row.locale) ? row.locale : null,
  };
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const row = (await dbGet("SELECT * FROM users WHERE id = ?", [id])) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export async function findUserByUsername(username: string): Promise<(UserRecord & { passwordHash: string }) | null> {
  const row = (await dbGet("SELECT * FROM users WHERE username = ?", [username])) as UserRow | undefined;
  if (!row) return null;
  return { ...mapUser(row), passwordHash: row.password_hash };
}

export async function createSupplier(input: { username: string; name?: string; password: string }): Promise<UserRecord> {
  const username = normalizeUsername(input.username);
  const name = normalizeName(input.name ?? input.username);
  const password = normalizePassword(input.password);
  if (!username) throw httpError("usernameInvalid", 400);
  if (!name) throw httpError("nameRequired", 400);
  if (!password) throw httpError("passwordInvalid", 400);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  try {
    await dbRun(
      `INSERT INTO users (id, username, password_hash, name, role, disabled, credential_version, created_at)
       VALUES (?, ?, ?, ?, 'supplier', 0, 0, ?)`,
      [id, username, await hashPassword(password), name, createdAt],
    );
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw httpError("usernameTaken", 409);
    throw error;
  }
  return { id, username, name, role: "supplier", disabled: false, credentialVersion: 0, createdAt, locale: null };
}

export async function authenticate(usernameInput: string, passwordInput: string): Promise<UserRecord | "invalid" | "disabled"> {
  const username = normalizeUsername(usernameInput);
  const password = typeof passwordInput === "string" ? passwordInput : "";
  if (!username || !password) return "invalid";
  const user = await findUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return "invalid";
  if (user.disabled) return "disabled";
  return user;
}

export async function listUsers(): Promise<UserRecord[]> {
  const rows = (await dbAll(
    `SELECT u.*, (SELECT COUNT(*) FROM channels c WHERE c.creator_user_id = u.id AND c.created_here = 1) AS connection_count
     FROM users u ORDER BY u.created_at ASC`,
  )) as UserRow[];
  return rows.map(mapUser);
}

export async function setUserDisabled(id: string, disabled: boolean, actor: SessionUser): Promise<"ok" | "self" | "missing"> {
  if (id === actor.id) return "self";
  const existing = await findUserById(id);
  if (!existing) return "missing";
  if (disabled) {
    await dbRun("UPDATE users SET disabled = 1, credential_version = credential_version + 1 WHERE id = ?", [id]);
    await revokeUserSessions(id);
    return "ok";
  }
  await dbRun("UPDATE users SET disabled = 0 WHERE id = ?", [id]);
  return "ok";
}

export async function changeOwnPassword(id: string, currentPassword: string, nextPassword: string): Promise<"ok" | "invalid" | "mismatch"> {
  const row = (await dbGet("SELECT password_hash FROM users WHERE id = ?", [id])) as { password_hash?: string } | undefined;
  if (!row?.password_hash || !(await verifyPassword(currentPassword, row.password_hash))) return "mismatch";
  const password = normalizePassword(nextPassword);
  if (!password) return "invalid";
  await dbRun("UPDATE users SET password_hash = ?, credential_version = credential_version + 1 WHERE id = ?", [await hashPassword(password), id]);
  await revokeUserSessions(id);
  return "ok";
}

export async function resetPassword(id: string, passwordInput: string): Promise<"ok" | "missing" | "invalid"> {
  const existing = await findUserById(id);
  if (!existing) return "missing";
  const password = normalizePassword(passwordInput);
  if (!password) return "invalid";
  await dbRun("UPDATE users SET password_hash = ?, credential_version = credential_version + 1 WHERE id = ?", [
    await hashPassword(password),
    id,
  ]);
  await revokeUserSessions(id);
  return "ok";
}

export async function logoutAllDevices(id: string): Promise<"ok" | "missing"> {
  const existing = await findUserById(id);
  if (!existing) return "missing";
  await dbRun("UPDATE users SET credential_version = credential_version + 1 WHERE id = ?", [id]);
  await revokeUserSessions(id);
  return "ok";
}

export async function setUserLocale(id: string, locale: Locale): Promise<void> {
  await dbRun("UPDATE users SET locale = ? WHERE id = ?", [locale, id]);
}

export function publicUser(user: UserRecord): SessionUser {
  return { id: user.id, username: user.username, name: user.name, role: user.role as Role, locale: user.locale };
}
