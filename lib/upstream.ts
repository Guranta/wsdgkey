import type { GatewaySecret } from "./gateways";
import type { Retryable } from "./rate-queue";
import { upstreamQueue } from "./rate-queue";

export type UpstreamChannel = {
  id: number;
  name: string;
  type: number;
  status: number;
  group: string;
  usedQuota: number;
  balance: number | null;
  baseUrl: string;
  models: string;
  modelMapping: string;
  testModel: string;
  remark: string;
  autoBan: boolean;
  createdTime: number;
  /** Present only when the payload itself carries a today field. Log stat is the usual source. */
  todayFromPayload: number | null;
  priority: number;
  weight: number;
  tag: string;
  other: string;
  statusCodeMapping: string;
  paramOverride: string;
  headerOverride: string;
  setting: string;
  settings: string;
  openaiOrganization: string;
  responseTime: number | null;
  statusReason: string;
  /** Unix ms from other_info status_time, when the gateway sends one. */
  statusTime: number | null;
};

export class UpstreamFailure extends Error {
  retryable: boolean;
  retryAfter: number | null;
  constructor(message: string, retryable: boolean, retryAfter: number | null = null) {
    super(message);
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

function authHeaders(gateway: GatewaySecret): Headers {
  const token = gateway.token.trim();
  const authorization = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  return new Headers({
    authorization,
    "new-api-user": gateway.adminUserId,
    accept: "application/json",
  });
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

async function requestJson(gateway: GatewaySecret, path: string, init: RequestInit = {}): Promise<unknown> {
  if (gateway.demo) {
    const { demoRequest } = await import("./demo-gateway");
    return demoRequest(gateway.id, path, init);
  }
  const url = new URL(path.replace(/^\//, ""), `${gateway.baseUrl}/`);
  const headers = authHeaders(gateway);
  if (init.body) headers.set("content-type", "application/json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, signal: controller.signal, cache: "no-store", redirect: "manual" });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    console.info(`upstream ${aborted ? "timeout" : "network"} ${url.pathname}`);
    throw new UpstreamFailure(aborted ? "上游超时" : "无法连接网关", true);
  } finally {
    clearTimeout(timer);
  }
  console.info(`upstream ${response.status} ${url.pathname}`);
  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamFailure("网关返回了重定向", false);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (response.status === 429 || response.status >= 500) {
    throw new UpstreamFailure("网关繁忙", true, retryAfterSeconds(response.headers.get("retry-after")));
  }
  if (!response.ok) {
    const message = messageOf(body) || "网关拒绝了请求";
    throw new UpstreamFailure(message, false);
  }
  const success = body && typeof body === "object" && "success" in body ? (body as { success?: boolean }).success : true;
  if (success === false) throw new UpstreamFailure(messageOf(body) || "网关返回失败", false);
  return body;
}

function messageOf(body: unknown): string {
  if (!body || typeof body !== "object" || !("message" in body)) return "";
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message.slice(0, 200) : "";
}

export function callGateway<T>(gateway: GatewaySecret, lane: string, path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  return upstreamQueue.enqueue({
    gatewayId: gateway.id,
    lane,
    timeoutMs,
    run: async () => {
      try {
        return (await requestJson(gateway, path, init)) as T;
      } catch (error) {
        if (error instanceof UpstreamFailure) {
          const tagged = error as UpstreamFailure & Retryable;
          tagged.retryable = error.retryable;
          tagged.retryAfter = error.retryAfter;
        }
        throw error;
      }
    },
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseChannel(raw: unknown): UpstreamChannel | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = Number(row.id);
  if (!Number.isFinite(id)) return null;
  const today =
    numberOrNull(row.today_quota) ?? numberOrNull(row.used_quota_today) ?? numberOrNull(row.today_used_quota);
  const info = otherInfoOf(row.other_info);
  return {
    id,
    name: String(row.name ?? ""),
    type: Number(row.type ?? 0),
    status: Number(row.status ?? 0),
    group: String(row.group ?? "default"),
    usedQuota: Number(row.used_quota ?? 0),
    balance: numberOrNull(row.balance),
    baseUrl: String(row.base_url ?? ""),
    models: String(row.models ?? ""),
    modelMapping: String(row.model_mapping ?? ""),
    testModel: String(row.test_model ?? ""),
    remark: String(row.remark ?? ""),
    autoBan: Number(row.auto_ban ?? 1) !== 0,
    createdTime: Number(row.created_time ?? 0),
    todayFromPayload: today,
    priority: Number(row.priority ?? 0),
    weight: Number(row.weight ?? 0),
    tag: String(row.tag ?? ""),
    other: String(row.other ?? ""),
    statusCodeMapping: String(row.status_code_mapping ?? ""),
    paramOverride: String(row.param_override ?? ""),
    headerOverride: String(row.header_override ?? ""),
    setting: String(row.setting ?? ""),
    settings: String(row.settings ?? "{}"),
    openaiOrganization: String(row.openai_organization ?? ""),
    responseTime: numberOrNull(row.response_time),
    statusReason: info.reason,
    statusTime: info.time,
  };
}

function otherInfoOf(value: unknown): { reason: string; time: number | null } {
  if (typeof value !== "string" || !value.trim()) return { reason: "", time: null };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const reason = typeof parsed.status_reason === "string" ? parsed.status_reason : "";
    const raw = parsed.status_time ?? parsed.auto_disabled_time ?? parsed.disabled_time;
    return { reason, time: epochMs(raw) };
  } catch {
    return { reason: "", time: null };
  }
}

function epochMs(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
}

type ListBody = { data?: { items?: unknown[]; total?: number } };

export async function listUpstreamChannels(gateway: GatewaySecret, page: number): Promise<{ items: UpstreamChannel[]; total: number }> {
  const body = await callGateway<ListBody>(
    gateway,
    "list",
    `/api/channel/?p=${page}&page_size=20&id_sort=true&tag_mode=false`,
  );
  const items = Array.isArray(body.data?.items) ? body.data.items.map(parseChannel).filter((item): item is UpstreamChannel => Boolean(item)) : [];
  return { items, total: Number(body.data?.total ?? items.length) };
}

export async function consumeQuota(
  gateway: GatewaySecret,
  upstreamId: number | null,
  start: number,
  end: number,
  tokenName = "",
): Promise<number | null> {
  const channel = upstreamId ? `&channel=${upstreamId}` : "";
  const token = tokenName ? `&token_name=${encodeURIComponent(tokenName)}` : "";
  const body = await callGateway<{ data?: { quota?: number } }>(
    gateway,
    upstreamId ? `channel:${upstreamId}` : "list",
    `/api/log/stat?type=2${channel}&start_timestamp=${Math.floor(start / 1000)}&end_timestamp=${Math.floor(end / 1000)}${token}`,
  );
  const quota = body.data?.quota;
  return typeof quota === "number" && Number.isFinite(quota) ? quota : null;
}

export async function todayQuota(
  gateway: GatewaySecret,
  upstreamId: number,
  start: number,
  end: number,
  tokenName = "",
): Promise<number | null> {
  return consumeQuota(gateway, upstreamId, start, end, tokenName);
}

/** Gateway-wide type=2 quota. No channel filter, so this includes every channel on the site. */
export async function gatewayConsumeQuota(gateway: GatewaySecret, start: number, end: number): Promise<number | null> {
  return consumeQuota(gateway, null, start, end);
}

/** Model-test consume logs. v1.0.0-rc.45 uses token name "Model test"; older builds used "模型测试". */
export async function testLogQuota(gateway: GatewaySecret, upstreamId: number, start: number, end: number): Promise<number | null> {
  const english = await todayQuota(gateway, upstreamId, start, end, "Model test");
  const chinese = await todayQuota(gateway, upstreamId, start, end, "模型测试");
  if (english === null && chinese === null) return null;
  return (english ?? 0) + (chinese ?? 0);
}

export async function fetchUpstreamChannel(gateway: GatewaySecret, upstreamId: number): Promise<UpstreamChannel | null> {
  const body = await callGateway<{ data?: unknown }>(gateway, `channel:${upstreamId}`, `/api/channel/${upstreamId}`);
  return parseChannel(body.data);
}

/** rc.45 GET /api/group/ 返回站点可选分组名数组。 */
export async function fetchGatewayGroups(gateway: GatewaySecret): Promise<string[]> {
  const body = await callGateway<{ data?: unknown }>(gateway, "list", "/api/group/");
  if (!Array.isArray(body.data)) return [];
  return body.data.map((item) => String(item)).filter(Boolean);
}

export type GatewayPricingModel = { name: string; groups: string[] };

/** 站点模型清单来自 GET /api/pricing；enable_groups 是该模型可用的分组。 */
export async function fetchGatewayModels(gateway: GatewaySecret): Promise<GatewayPricingModel[]> {
  const body = await callGateway<{ data?: unknown }>(gateway, "list", "/api/pricing");
  if (!Array.isArray(body.data)) return [];
  const models: GatewayPricingModel[] = [];
  for (const entry of body.data) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.model_name === "string" ? row.model_name.trim() : "";
    if (!name) continue;
    const groups = Array.isArray(row.enable_groups) ? row.enable_groups.map((item) => String(item)).filter(Boolean) : [];
    models.push({ name, groups });
  }
  return models;
}

export async function addUpstreamChannel(gateway: GatewaySecret, payload: Record<string, unknown>): Promise<void> {
  await callGateway(gateway, "mutate", "/api/channel/", { method: "POST", body: JSON.stringify(payload) }, 90_000);
}

export async function updateUpstreamChannel(gateway: GatewaySecret, payload: Record<string, unknown>): Promise<void> {
  await callGateway(gateway, "mutate", "/api/channel/", { method: "PUT", body: JSON.stringify(payload) }, 90_000);
}

export async function setUpstreamStatus(gateway: GatewaySecret, upstreamId: number, status: 1 | 2): Promise<void> {
  await callGateway(gateway, `channel:${upstreamId}`, `/api/channel/${upstreamId}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export async function setUpstreamStatusBatch(gateway: GatewaySecret, ids: number[], status: 1 | 2): Promise<void> {
  await callGateway(gateway, "mutate", "/api/channel/status/batch", {
    method: "POST",
    body: JSON.stringify({ ids, status }),
  });
}

export type ChannelTestResult = {
  success: boolean;
  message: string;
  timeSeconds: number;
};

export async function refreshCodexCredential(gateway: GatewaySecret, upstreamId: number): Promise<{ message: string; accountId: string; email: string }> {
  const body = await callGateway<{ message?: string; data?: { account_id?: string; email?: string } }>(
    gateway,
    `channel:${upstreamId}`,
    `/api/channel/${upstreamId}/codex/refresh`,
    { method: "POST", body: "{}" },
  );
  return {
    message: body.message || "refreshed",
    accountId: body.data?.account_id || "",
    email: body.data?.email || "",
  };
}

export async function testUpstreamChannel(gateway: GatewaySecret, upstreamId: number, model: string): Promise<ChannelTestResult> {
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  const body = await callGateway<{ message?: string; success?: boolean; time?: number }>(
    gateway,
    `channel:${upstreamId}`,
    `/api/channel/test/${upstreamId}${query}`,
  );
  const timeSeconds = typeof body.time === "number" && Number.isFinite(body.time) ? body.time : 0;
  return {
    success: body.success !== false,
    message: body.message || "",
    timeSeconds,
  };
}
