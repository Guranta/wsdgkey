import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { applyReconAction, reconPage } from "@/lib/recon-service";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const month = new URL(req.url).searchParams.get("month");
  return Response.json(await reconPage(user, month), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    await applyReconAction(user, body ?? {});
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "reconAction");
  }
}
