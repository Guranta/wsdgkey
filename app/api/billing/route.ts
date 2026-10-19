import { apiError } from "@/lib/api-error";
import { billingView } from "@/lib/billing-service";
import { currentUser } from "@/lib/current-user";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const url = new URL(req.url);
  const view = await billingView(user, url.searchParams.get("unsynced") === "1");
  return Response.json(view, { headers: { "cache-control": "no-store" } });
}
