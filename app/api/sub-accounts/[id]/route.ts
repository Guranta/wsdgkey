import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { updateSubAccount } from "@/lib/users";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (body && ("parentId" in body || "parentUserId" in body)) return apiError("subAccountTransfer", 400);
  const hasDisabled = typeof body?.disabled === "boolean";
  const hasPassword = typeof body?.password === "string";
  if (!hasDisabled && !hasPassword) return apiError("specifyUpdate", 400);
  try {
    const updated = await updateSubAccount(user, id, {
      disabled: hasDisabled ? (body?.disabled as boolean) : undefined,
      password: hasPassword ? (body?.password as string) : undefined,
    });
    return Response.json(
      { id: updated.id, username: updated.username, disabled: updated.disabled, lastLoginAt: updated.lastLoginAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return fromError(error, "userUpdateFailed");
  }
}
