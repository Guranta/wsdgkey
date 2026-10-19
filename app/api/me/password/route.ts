import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { changeOwnPassword } from "@/lib/users";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as { currentPassword?: unknown; newPassword?: unknown } | null;
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  const result = await changeOwnPassword(user.id, currentPassword, newPassword);
  if (result === "mismatch") return apiError("passwordMismatch", 400);
  if (result === "invalid") return apiError("passwordInvalid", 400);
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
