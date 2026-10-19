import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies, headers } from "next/headers";
import { cookieSecure } from "./forwarded";
import { ensureDataDir } from "./paths";

export type SessionData = { sessionId?: string; credentialVersion?: number };

export const SESSION_COOKIE = "newapi_session";

function loadSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  const file = path.join(ensureDataDir(), "session.secret");
  if (existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored.length >= 32) return stored;
  }
  const created = randomBytes(32).toString("base64url");
  writeFileSync(file, created, { mode: 0o600 });
  return created;
}

let cachedSecret: string | null = null;

export function sessionSecret(): string {
  if (!cachedSecret) cachedSecret = loadSessionSecret();
  return cachedSecret;
}

export function sessionOptions(headerStore: { get(name: string): string | null }): SessionOptions {
  return {
    password: sessionSecret(),
    cookieName: SESSION_COOKIE,
    cookieOptions: {
      httpOnly: true,
      secure: cookieSecure(headerStore),
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 14,
    },
  };
}

export async function getSession() {
  // iron-session reads the clock while unsealing. Wait until request time so
  // that Date.now() is not observed during prerender.
  try {
    const { connection } = await import("next/server");
    await connection();
  } catch {
    // Route handlers still have a request; a missing store just continues.
  }
  return getIronSession<SessionData>(await cookies(), sessionOptions(await headers()));
}

export function resetSessionSecretForTests(): void {
  cachedSecret = null;
}
