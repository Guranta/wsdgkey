import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { setGatewayDisabled, updateGateway } from "@/lib/gateways";
import { readJson } from "@/lib/http";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    if (typeof body?.disabled === "boolean" && !body.name) {
      const toggled = await setGatewayDisabled(id, body.disabled);
      if (!toggled) return apiError("gatewayMissing", 404);
      return Response.json(toggled, { headers: { "cache-control": "no-store" } });
    }
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
