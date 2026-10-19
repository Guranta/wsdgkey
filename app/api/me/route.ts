import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { siteName } from "@/lib/settings";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  return Response.json({ ...user, siteName: await siteName() }, { headers: { "cache-control": "no-store" } });
}
