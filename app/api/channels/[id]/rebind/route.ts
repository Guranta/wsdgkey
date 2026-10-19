import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { getGateway } from "@/lib/gateways";
import { readJson } from "@/lib/http";
import { markMissingHandled, rebindChannel } from "@/lib/rebind";
import { fetchUpstreamChannel, todayQuota } from "@/lib/upstream";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as { action?: unknown; newapiChannelId?: unknown } | null;
  try {
    if (body?.action === "mark") {
      await markMissingHandled(user, id);
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    const upstreamId = Number(body?.newapiChannelId);
    const result = await rebindChannel(user, id, upstreamId, {
      fetchChannel: async (gatewayId, channelId) => {
        const gateway = await getGateway(gatewayId);
        if (!gateway) return null;
        try {
          const item = await fetchUpstreamChannel(gateway, channelId);
          return item ? { usedQuota: item.usedQuota } : null;
        } catch {
          return null;
        }
      },
      logQuota: async (gatewayId, channelId, start, end) => {
        const gateway = await getGateway(gatewayId);
        if (!gateway) return null;
        try {
          return await todayQuota(gateway, channelId, start, end);
        } catch {
          return null;
        }
      },
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "bindingFailed");
  }
}
