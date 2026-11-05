/** Fields a seller account is allowed to send. Everything else is dropped, not disabled. */
const CHANNEL_KEYS = [
  "id",
  "name",
  "type",
  "key",
  "key_mode",
  "base_url",
  "openai_organization",
  "other",
  "models",
  "model_mapping",
  "test_model",
  "group",
  "remark",
  "status",
  "proxy",
  "settings",
] as const;

const SETTINGS_KEYS = ["azure_responses_version", "vertex_key_type", "aws_key_type", "openrouter_enterprise"] as const;

export type SellerCapabilities = {
  canWrite: boolean;
  canToggle: boolean;
  canEditRouting: boolean;
  /** 0 means the site did not set a cap. */
  maxChannels: number;
  total: number;
};

export function isBaseUrlDenial(message: string): boolean {
  return /base[\s_-]*url|baseurl|地址/i.test(message);
}

function slimSettings(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "{}";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
    const source = parsed as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of SETTINGS_KEYS) {
      if (key in source) next[key] = source[key];
    }
    return JSON.stringify(next);
  } catch {
    return "{}";
  }
}

/** One seller create/update body. Batch mode is never sent. */
export function sellerChannelBody(payload: Record<string, unknown>, includeId: boolean): Record<string, unknown> {
  const source = (payload.channel && typeof payload.channel === "object" ? payload.channel : payload) as Record<string, unknown>;
  const channel: Record<string, unknown> = {};
  for (const key of CHANNEL_KEYS) {
    if (!includeId && key === "id") continue;
    if (key in source && source[key] !== undefined) channel[key] = source[key];
  }
  if ("settings" in channel) channel.settings = slimSettings(channel.settings);
  if (!includeId) delete channel.id;
  return { mode: "single", channel };
}

/** Split a multi-key paste into one single-channel body per key. */
export function sellerCreateBodies(payload: Record<string, unknown>): Record<string, unknown>[] {
  const source = (payload.channel && typeof payload.channel === "object" ? payload.channel : payload) as Record<string, unknown>;
  const raw = String(source.key ?? "");
  const keys = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const list = keys.length ? keys : [raw];
  return list.map((key) => sellerChannelBody({ ...payload, channel: { ...source, key } }, false));
}

export function readSellerCapabilities(data: unknown): SellerCapabilities | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const max = Number(row.max_channels ?? 0);
  const total = Number(row.total ?? 0);
  return {
    canWrite: row.can_write !== false,
    canToggle: row.can_toggle !== false,
    canEditRouting: row.can_edit_routing === true,
    maxChannels: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0,
    total: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
  };
}

/** True when another channel would pass the live site cap. 0 is unlimited. */
export function atChannelCap(caps: SellerCapabilities | null, adding: number): boolean {
  if (!caps || caps.maxChannels <= 0) return false;
  return caps.total + Math.max(0, adding) > caps.maxChannels;
}
