import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { createSubAccount, listSubAccounts } from "@/lib/users";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const parent = new URL(req.url).searchParams.get("parent") ?? "";
  try {
    const rows = await listSubAccounts(user, parent || undefined);
    return Response.json(rows, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "forbidden");
  }
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as { username?: unknown; password?: unknown; parentId?: unknown } | null;
  try {
    const created = await createSubAccount(user, {
      username: String(body?.username ?? ""),
      password: String(body?.password ?? ""),
      parentId: typeof body?.parentId === "string" ? body.parentId : undefined,
    });
    return Response.json(created, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "userCreateFailed");
  }
}
