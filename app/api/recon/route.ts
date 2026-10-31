import { apiError, fromError } from "@/lib/api-error";
import { sellerSnapshotGrid } from "@/lib/billing-service";
import { currentUser } from "@/lib/current-user";
import { getGateway, listVisibleGateways } from "@/lib/gateways";
import { readJson } from "@/lib/http";
import { applyReconAction, reconPage } from "@/lib/recon-service";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  const gatewayId = url.searchParams.get("gateway") ?? "";
  const visible = await listVisibleGateways(user);
  const choices = visible.map((item) => ({ id: item.id, name: item.name, kind: item.kind }));
  if (gatewayId) {
    const gateway = await getGateway(gatewayId);
    const allowed = gateway && (user.role === "admin" || gateway.kind !== "newapi_seller" || gateway.ownerUserId === user.id);
    if (allowed && gateway?.kind === "newapi_seller") {
      const snapshot = await sellerSnapshotGrid(user, gatewayId);
      return Response.json({ mode: "snapshot", snapshot, gateways: [], choices }, { headers: { "cache-control": "no-store" } });
    }
  }
  const page = await reconPage(user, month);
  const gateways = gatewayId ? page.gateways.filter((item) => item.id === gatewayId) : page.gateways;
  return Response.json({ ...page, mode: "recon", gateways, choices }, { headers: { "cache-control": "no-store" } });
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
