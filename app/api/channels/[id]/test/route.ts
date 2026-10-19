import { apiError, fromError } from "@/lib/api-error";
import { testChannel } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as { model?: string } | null;
  try {
    return Response.json(await testChannel(user, id, String(body?.model ?? "")), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "testIncomplete");
  }
}
