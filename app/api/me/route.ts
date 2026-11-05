import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { renewalAlertsFor } from "@/lib/gateways";
import { siteName } from "@/lib/settings";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  return Response.json({ ...user, siteName: await siteName(), renewalAlerts: await renewalAlertsFor(user) }, { headers: { "cache-control": "no-store" } });
}
