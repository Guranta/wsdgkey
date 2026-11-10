import { fromError } from "@/lib/api-error";
import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { probeGatewayLogin } from "@/lib/gateways";
import { readJson } from "@/lib/http";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.parentUserId) return apiError("forbidden", 403);
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    const result = await probeGatewayLogin({
      baseUrl: String(body?.baseUrl ?? ""),
      username: String(body?.username ?? ""),
      password: String(body?.password ?? ""),
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "sellerAuthFailed");
  }
}
