import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { createGateway, createSellerGateway, createSupplierGateway, listGateways, listOwnSellerGateways } from "@/lib/gateways";
import { readJson } from "@/lib/http";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const rows = user.role === "admin" ? await listGateways() : await listOwnSellerGateways(user);
  return Response.json(rows, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    if (body?.kind === "newapi_seller") {
      const created = await createSellerGateway(user, {
        name: String(body.name ?? ""),
        baseUrl: String(body.baseUrl ?? ""),
        username: String(body.username ?? ""),
        password: String(body.password ?? ""),
        probeId: typeof body.probeId === "string" ? body.probeId : "",
      });
      return Response.json(created, { status: 201, headers: { "cache-control": "no-store" } });
    }
    if (body?.kind === "newapi_supplier") {
      const created = await createSupplierGateway(user, {
        name: String(body.name ?? ""),
        baseUrl: String(body.baseUrl ?? ""),
        username: String(body.username ?? ""),
        password: String(body.password ?? ""),
        tlsExceptionHost: typeof body.tlsExceptionHost === "string" ? body.tlsExceptionHost : "",
      });
      return Response.json(created, { status: 201, headers: { "cache-control": "no-store" } });
    }
    if (user.role !== "admin") return apiError("forbidden", 403);
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
