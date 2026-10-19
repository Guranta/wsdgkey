import type { ConnectionStatus, ModelInfo, RequestLog, TokenUsage } from "./types";

/** A token inside this window, and not yet past, is shown as 即将失效. */
export const EXPIRING_SOON_MS = 72 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function errorMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  if (!record) return fallback;
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  const nested = asRecord(record.error);
  if (nested && typeof nested.message === "string" && nested.message.trim()) return nested.message.trim();
  return fallback;
}

export function normalizeModelLimits(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .filter(([, allowed]) => allowed !== false)
    .map(([name]) => name);
}

export function parseUsagePayload(payload: unknown): TokenUsage | null {
  const root = asRecord(payload);
  if (!root) return null;
  const data = asRecord(root.data) ?? root;
  const hasQuota = typeof data.total_granted === "number" || typeof data.total_used === "number" || typeof data.total_available === "number";
  if (!hasQuota) return null;
  return {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "未命名令牌",
    total_granted: asNumber(data.total_granted),
    total_used: asNumber(data.total_used),
    total_available: asNumber(data.total_available),
    unlimited_quota: Boolean(data.unlimited_quota),
    expires_at: asNumber(data.expires_at),
    model_limits: normalizeModelLimits(data.model_limits),
    model_limits_enabled: Boolean(data.model_limits_enabled),
  };
}

export function parseModelsPayload(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.data)) return [];
  const models: ModelInfo[] = [];
  for (const item of root.data) {
    const record = asRecord(item);
    if (!record || typeof record.id !== "string" || !record.id) continue;
    models.push({
      id: record.id,
      owned_by: typeof record.owned_by === "string" ? record.owned_by : undefined,
      created: typeof record.created === "number" ? record.created : undefined,
    });
  }
  return models;
}

export function expiryMillis(expiresAt: number): number | null {
  if (!expiresAt || expiresAt <= 0) return null;
  return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
}

export function isPastExpiry(expiresAt: number, now = Date.now()): boolean {
  const ms = expiryMillis(expiresAt);
  return ms !== null && ms < now;
}

export function isExpiringSoon(expiresAt: number, now = Date.now()): boolean {
  const ms = expiryMillis(expiresAt);
  if (ms === null) return false;
  const delta = ms - now;
  return delta >= 0 && delta <= EXPIRING_SOON_MS;
}

function looksUnauthorized(message: string): boolean {
  return /expired|过期|token not found|无效|unauthorized|invalid bearer|no authorization|access token/i.test(message);
}

export function classifyUsageResponse(
  status: number,
  payload: unknown,
  now = Date.now(),
): { status: ConnectionStatus; detail: string; usage: TokenUsage | null; fallbackToModels: boolean } {
  const message = errorMessage(payload, "");
  const unauthorized = looksUnauthorized(message);
  if (status === 401 || status === 403 || (status >= 400 && unauthorized)) {
    return { status: "expired", detail: message || "令牌无效或已过期", usage: null, fallbackToModels: false };
  }
  if (status === 404) {
    return { status: "failing", detail: "用量接口不存在", usage: null, fallbackToModels: true };
  }
  if (status < 200 || status >= 300) {
    return { status: "failing", detail: message || `上游返回 ${status}`, usage: null, fallbackToModels: false };
  }

  const root = asRecord(payload);
  const failed = Boolean(root && root.success === false && !asRecord(root.data));
  if (failed) {
    return {
      status: unauthorized ? "expired" : "failing",
      detail: message || "用量查询失败",
      usage: null,
      fallbackToModels: false,
    };
  }

  const usage = parseUsagePayload(payload);
  if (!usage) {
    return { status: "failing", detail: "用量响应无法解析", usage: null, fallbackToModels: false };
  }
  if (isPastExpiry(usage.expires_at, now)) {
    return { status: "expired", detail: "令牌已到期", usage, fallbackToModels: false };
  }
  if (isExpiringSoon(usage.expires_at, now)) {
    const ms = expiryMillis(usage.expires_at) ?? now;
    const hours = Math.max(1, Math.ceil((ms - now) / 3_600_000));
    return {
      status: "expiring",
      detail: `令牌「${usage.name}」将在 ${hours} 小时内到期`,
      usage,
      fallbackToModels: false,
    };
  }
  return {
    status: "ok",
    detail: `令牌「${usage.name}」可用`,
    usage,
    fallbackToModels: false,
  };
}

export function classifyModelsResponse(status: number, payload: unknown): {
  status: ConnectionStatus;
  detail: string;
  models: ModelInfo[];
} {
  const message = errorMessage(payload, "");
  if (status === 401 || status === 403 || (status >= 400 && looksUnauthorized(message))) {
    return { status: "expired", detail: message || "令牌无效或已过期", models: [] };
  }
  if (status < 200 || status >= 300) {
    return { status: "failing", detail: message || `上游返回 ${status}`, models: [] };
  }
  const models = parseModelsPayload(payload);
  return { status: "ok", detail: `已连通，模型 ${models.length} 个`, models };
}

function toMillis(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

function logItems(payload: unknown): { raw: unknown[]; total: number } {
  if (Array.isArray(payload)) return { raw: payload, total: payload.length };
  const root = asRecord(payload);
  if (!root) return { raw: [], total: 0 };
  const data = root.data;
  if (Array.isArray(data)) return { raw: data, total: data.length };
  const box = asRecord(data);
  if (!box) return { raw: [], total: 0 };
  const list = Array.isArray(box.items) ? box.items : Array.isArray(box.logs) ? box.logs : null;
  if (!list) return { raw: [], total: 0 };
  const total = typeof box.total === "number" && Number.isFinite(box.total) ? box.total : list.length;
  return { raw: list, total };
}

export function parseLogsPayload(payload: unknown): { items: RequestLog[]; total: number } {
  const { raw, total } = logItems(payload);
  const items: RequestLog[] = [];
  raw.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) return;
    const model =
      typeof record.model_name === "string"
        ? record.model_name
        : typeof record.model === "string"
          ? record.model
          : "";
    const createdAt = toMillis(record.created_at ?? record.createdAt);
    items.push({
      id: typeof record.id === "number" || typeof record.id === "string" ? String(record.id) : `log-${index}`,
      createdAt,
      model: model || "—",
      quota: asNumber(record.quota),
      promptTokens: asNumber(record.prompt_tokens ?? record.promptTokens),
      completionTokens: asNumber(record.completion_tokens ?? record.completionTokens),
      useTime: asNumber(record.use_time ?? record.useTime),
      tokenName: typeof record.token_name === "string" ? record.token_name : "",
    });
  });
  return { items, total };
}

export function summarizeToday(items: RequestLog[], now = new Date()): { quota: number; count: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  const until = now.getTime();
  let quota = 0;
  let count = 0;
  for (const item of items) {
    if (item.createdAt < from || item.createdAt > until) continue;
    quota += item.quota;
    count += 1;
  }
  return { quota, count };
}
