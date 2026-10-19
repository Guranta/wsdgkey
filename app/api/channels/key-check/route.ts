import { apiError, fromError } from "@/lib/api-error";
import { matchingFingerprints } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as { gatewayId?: string; keys?: string[] } | null;
  try {
    const duplicates = await matchingFingerprints(String(body?.gatewayId ?? ""), body?.keys ?? []);
    return Response.json({ duplicates }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "generic");
  }
}
