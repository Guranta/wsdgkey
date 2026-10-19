import { getSession } from "@/lib/session";
import { revokeServerSession } from "@/lib/session-store";

export async function POST() {
  const session = await getSession();
  if (session.sessionId) await revokeServerSession(session.sessionId);
  session.destroy();
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
