import { liveSession } from "./session-store";
import { findUserById, type UserRecord } from "./users";

export type SessionGate =
  | { status: 200; user: UserRecord }
  | { status: 401; reason: "loginRequired" | "accountDisabled" };

/**
 * What `/api/me` and the proxy decide from the signed cookie.
 * The cookie only carries the session id and the credential version;
 * a revoked, expired, or mismatched row is 401 even if the cookie is still presented.
 */
export async function sessionGate(sessionId: string | undefined, credentialVersion: number | undefined, now = Date.now()): Promise<SessionGate> {
  if (!sessionId) return { status: 401, reason: "loginRequired" };
  const live = await liveSession(sessionId, now);
  if (!live) return { status: 401, reason: "loginRequired" };
  const user = await findUserById(live.userId);
  if (!user) return { status: 401, reason: "loginRequired" };
  if (user.disabled) return { status: 401, reason: "accountDisabled" };
  if ((credentialVersion ?? 0) !== user.credentialVersion) return { status: 401, reason: "loginRequired" };
  return { status: 200, user };
}
