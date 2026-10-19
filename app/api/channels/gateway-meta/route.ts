import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { getGateway } from "@/lib/gateways";
import { fetchGatewayGroups, fetchGatewayModels } from "@/lib/upstream";

/** 抽屉的分组勾选和模型点选数据：rc.45 的 /api/group/ 与 /api/pricing。 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const url = new URL(req.url);
  const gateway = await getGateway(url.searchParams.get("gateway") ?? "");
  if (!gateway || gateway.disabled) return apiError("gatewayMissing", 404);
  try {
    const [groups, models] = await Promise.all([fetchGatewayGroups(gateway), fetchGatewayModels(gateway)]);
    return Response.json({ groups, models }, { headers: { "cache-control": "no-store" } });
  } catch {
    // 拉不到时抽屉退回手动输入，不挡添加渠道
    return Response.json({ groups: [], models: [], unavailable: true }, { headers: { "cache-control": "no-store" } });
  }
}
