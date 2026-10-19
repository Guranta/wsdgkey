import { apiError, fromError } from "@/lib/api-error";
import { updateChannel } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    return Response.json(await updateChannel(user, id, body ?? {}), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "saveFailed");
  }
}
