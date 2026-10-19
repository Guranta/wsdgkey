import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { readAppSettings, saveAppSettings } from "@/lib/settings";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  return Response.json(await readAppSettings(), { headers: { "cache-control": "no-store" } });
}

export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const body = (await readJson(req)) as {
    gatewayPerMin?: number;
    channelPerMin?: number;
    concurrency?: number;
    testCooldownMin?: number;
    quotaPerUnit?: number;
    reconTolerancePct?: number;
    zeroDays?: number;
    manualTolerancePct?: number;
    siteName?: string;
  } | null;
  const saved = await saveAppSettings({
    gatewayPerMin: Number(body?.gatewayPerMin),
    channelPerMin: Number(body?.channelPerMin),
    concurrency: Number(body?.concurrency),
    testCooldownMin: Number(body?.testCooldownMin),
    quotaPerUnit: body?.quotaPerUnit,
    reconTolerancePct: body?.reconTolerancePct,
    zeroDays: body?.zeroDays,
    manualTolerancePct: body?.manualTolerancePct,
    siteName: body?.siteName,
  });
  return Response.json(saved, { headers: { "cache-control": "no-store" } });
}
