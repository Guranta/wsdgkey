import { apiError, fromError } from "@/lib/api-error";
import { importSellerChannels } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    const result = await importSellerChannels(user, String(body?.gatewayId ?? ""));
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "channelsSaveFailed");
  }
}
