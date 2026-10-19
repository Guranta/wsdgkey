import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { ensureDemoGateway } from "@/lib/demo-gateway";

export async function POST() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  await ensureDemoGateway(user.id);
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
