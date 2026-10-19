import { sessionGate } from "./session-access";
import { getSession } from "./session";
import { publicUser } from "./users";
import type { SessionUser } from "./types";

export async function currentUser(): Promise<SessionUser | null> {
  const session = await getSession();
  const gate = await sessionGate(session.sessionId, session.credentialVersion);
  if (gate.status !== 200) {
    if (session.sessionId) session.destroy();
    return null;
  }
  return publicUser(gate.user);
}
