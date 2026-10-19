import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { createGateway, listGateways } from "@/lib/gateways";
import { readJson } from "@/lib/http";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  return Response.json(await listGateways(), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    const created = await createGateway({
      name: String(body?.name ?? ""),
      baseUrl: String(body?.baseUrl ?? ""),
      adminUserId: String(body?.adminUserId ?? ""),
      token: String(body?.token ?? ""),
    });
    return Response.json(created, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "gatewaySaveFailed");
  }
}
