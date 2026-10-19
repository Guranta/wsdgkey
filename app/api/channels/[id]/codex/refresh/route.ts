import { apiError, fromError } from "@/lib/api-error";
import { refreshCodex } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const { id } = await ctx.params;
  try {
    return Response.json(await refreshCodex(user, id), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "refreshFailed");
  }
}
