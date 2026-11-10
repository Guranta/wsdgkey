import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { getGateway, setGatewayDisabled, updateGateway, updateSellerGateway } from "@/lib/gateways";
import { readJson } from "@/lib/http";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.parentUserId) return apiError("forbidden", 403);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  const existing = await getGateway(id);
  if (!existing) return apiError("gatewayMissing", 404);
  if (user.role !== "admin" && (existing.kind !== "newapi_seller" || existing.ownerUserId !== user.id)) return apiError("forbidden", 403);
  try {
    if (typeof body?.disabled === "boolean" && !body.username && !body.name) {
      const toggled = await setGatewayDisabled(id, body.disabled);
      if (!toggled) return apiError("gatewayMissing", 404);
      return Response.json(toggled, { headers: { "cache-control": "no-store" } });
    }
    if (body?.kind === "newapi_seller" || (existing.kind === "newapi_seller" && body?.username)) {
      const updated = await updateSellerGateway(user, id, {
        name: String(body?.name ?? existing.name),
        baseUrl: String(body?.baseUrl ?? existing.baseUrl),
        username: String(body?.username ?? ""),
        password: String(body?.password ?? ""),
        probeId: typeof body?.probeId === "string" ? body.probeId : "",
      });
      if (!updated) return apiError("gatewayMissing", 404);
      return Response.json(updated, { headers: { "cache-control": "no-store" } });
    }
    if (user.role !== "admin") return apiError("forbidden", 403);
    const updated = await updateGateway(id, {
      name: String(body?.name ?? ""),
      baseUrl: String(body?.baseUrl ?? ""),
      adminUserId: String(body?.adminUserId ?? ""),
      token: typeof body?.token === "string" ? body.token : "",
    });
    if (!updated) return apiError("gatewayMissing", 404);
    return Response.json(updated, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "gatewaySaveFailed");
  }
}
