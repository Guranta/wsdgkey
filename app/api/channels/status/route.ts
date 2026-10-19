import { apiError, fromError } from "@/lib/api-error";
import { changeStatus } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as { ids?: string[]; enabled?: boolean } | null;
  try {
    return Response.json(await changeStatus(user, body?.ids ?? [], Boolean(body?.enabled)), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "statusFailed");
  }
}
