import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { logoutAllDevices } from "@/lib/users";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const { id } = await ctx.params;
  const result = await logoutAllDevices(id);
  if (result === "missing") return apiError("userMissing", 404);
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
