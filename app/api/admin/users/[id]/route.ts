import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { resetPassword, setUserDisabled } from "@/lib/users";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as { disabled?: unknown; password?: unknown } | null;
  const hasDisabled = typeof body?.disabled === "boolean";
  const hasPassword = typeof body?.password === "string";
  if (!hasDisabled && !hasPassword) return apiError("specifyUpdate", 400);

  if (hasDisabled) {
    const result = await setUserDisabled(id, body.disabled as boolean, user);
    if (result === "self") return apiError("cannotDisableSelf", 400);
    if (result === "missing") return apiError("userMissing", 404);
  }
  if (hasPassword) {
    const result = await resetPassword(id, body.password as string);
    if (result === "missing") return apiError("userMissing", 404);
    if (result === "invalid") return apiError("passwordInvalid", 400);
  }
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
