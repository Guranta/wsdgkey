import { apiError, fromError } from "@/lib/api-error";
import { readSellerCap } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";

/** Live max_channels from the seller list API. Nothing here is hardcoded. */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const gatewayId = new URL(req.url).searchParams.get("gateway") ?? "";
  try {
    const caps = await readSellerCap(user, gatewayId);
    return Response.json(caps, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "channelsLoadFailed");
  }
}
