import { apiError, fromError } from "@/lib/api-error";
import { queryChannels, createChannels } from "@/lib/channel-service";
import { currentUser } from "@/lib/current-user";
import { listGateways } from "@/lib/gateways";
import { readJson } from "@/lib/http";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const url = new URL(req.url);
  const result = await queryChannels(user, url.searchParams);
  const gateways = (await listGateways()).map((item) => ({ id: item.id, name: item.name, demo: item.demo, baseUrl: item.baseUrl, disabled: item.disabled }));
  return Response.json({ ...result, gateways }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    const created = await createChannels(user, body ?? {});
    return Response.json(created, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fromError(error, "createFailed");
  }
}
