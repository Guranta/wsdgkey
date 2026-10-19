/**
 * Payload builder for POST/PUT /api/channel/.
 * Field set, defaults, null handling and settings JSON follow
 * QuantumNous/new-api v1.0.0-rc.45
 * web/src/features/channels/lib/channel-form.ts
 * (transformFormDataToCreatePayload / transformFormDataToUpdatePayload).
 * The reference copy lives in vendor/new-api/v1.0.0-rc.45/payload-original.mjs.
 */

export const CHANNEL_TYPE_OLLAMA = 4;
export const CHANNEL_TYPE_ADVANCED_CUSTOM = 58;
export const CHANNEL_TYPE_SUB2API = 59;
export const CHANNEL_TYPE_NEW_API = 60;
export const CHANNEL_TYPE_TASK_PLUGIN = 61;
export const CHANNEL_TYPE_VLLM = 62;
export const CHANNEL_TYPE_SGLANG = 63;
export const HTTP_PROTOCOL_AUTO = "auto";
export const HTTP_PROTOCOL_HTTP1 = "http1";
export const MAX_HTTP2_CONNECTION_SHARDS = 8;

const MODEL_FETCHABLE_TYPES = new Set([1, 4, 14, 17, 20, 23, 24, 25, 26, 27, 31, 34, 35, 40, 42, 43, 47, 48, 57, 58, 59, 60, 62, 63]);
const FIELD_PASSTHROUGH_TYPES = new Set([1, 14, 57, 58, 59, 60, 62, 63]);
const OPENAI_FIELD_PASSTHROUGH_TYPES = new Set([1, 57, 58, 59, 60, 62, 63]);
const CLAUDE_FIELD_PASSTHROUGH_TYPES = new Set([14, 58, 59, 60, 62, 63]);
const RESPONSES_WEBSOCKET_TYPES = new Set([1, 57, 58, 59, 60]);
const BASE_URL_REQUIRED = new Set([3, 8, 36, 45, 60, 61, 62, 63]);
const OTHER_REQUIRED = new Set([3, 18, 21, 39, 41, 49]);

export type ChannelFormValues = {
  name: string;
  type: number;
  base_url?: string;
  task_plugin_key?: string;
  task_extend_plugin_keys?: string[];
  key: string;
  openai_organization?: string;
  models: string;
  group: string[];
  model_mapping?: string;
  priority?: number;
  weight?: number;
  test_model?: string;
  auto_ban?: number;
  status: number;
  status_code_mapping?: string;
  tag?: string;
  remark?: string;
  setting?: string;
  param_override?: string;
  header_override?: string;
  settings?: string;
  advanced_custom?: string;
  other?: string;
  multi_key_mode?: "single" | "batch" | "multi_to_single";
  multi_key_type?: "random" | "polling";
  batch_add_set_key_prefix_2_name?: boolean;
  key_mode?: "append" | "replace";
  force_format?: boolean;
  thinking_to_content?: boolean;
  proxy?: string;
  http_protocol?: "auto" | "http1";
  http2_connection_shards?: number;
  tls_insecure_skip_verify?: boolean;
  pass_through_body_enabled?: boolean;
  responses_websocket_enabled?: boolean;
  system_prompt?: string;
  system_prompt_override?: boolean;
  is_enterprise_account?: boolean;
  vertex_key_type?: "json" | "api_key";
  vertex_project_id?: string;
  aws_key_type?: "ak_sk" | "api_key";
  aws_api_type?: "invoke_model" | "mantle";
  azure_responses_version?: string;
  allow_service_tier?: boolean;
  disable_store?: boolean;
  allow_safety_identifier?: boolean;
  allow_include_obfuscation?: boolean;
  allow_inference_geo?: boolean;
  allow_speed?: boolean;
  claude_beta_query?: boolean;
  ollama_openai_chat?: boolean;
  disable_task_polling_sleep?: boolean;
  upstream_model_update_check_enabled?: boolean;
  upstream_model_update_auto_sync_enabled?: boolean;
  upstream_model_update_ignored_models?: string;
};

export const CHANNEL_FORM_DEFAULT_VALUES: ChannelFormValues = {
  name: "",
  type: 1,
  base_url: "",
  task_plugin_key: "",
  task_extend_plugin_keys: [],
  key: "",
  openai_organization: "",
  models: "",
  group: ["default"],
  model_mapping: "",
  priority: 0,
  weight: 0,
  test_model: "",
  auto_ban: 1,
  status: 1,
  status_code_mapping: "",
  tag: "",
  remark: "",
  setting: "",
  param_override: "",
  header_override: "",
  settings: "{}",
  other: "",
  multi_key_mode: "single",
  multi_key_type: "random",
  batch_add_set_key_prefix_2_name: false,
  key_mode: "append",
  force_format: false,
  thinking_to_content: false,
  proxy: "",
  http_protocol: HTTP_PROTOCOL_AUTO,
  http2_connection_shards: 1,
  tls_insecure_skip_verify: false,
  pass_through_body_enabled: false,
  responses_websocket_enabled: false,
  system_prompt: "",
  system_prompt_override: false,
  is_enterprise_account: false,
  vertex_key_type: "json",
  vertex_project_id: "",
  aws_key_type: "ak_sk",
  aws_api_type: "invoke_model",
  azure_responses_version: "",
  allow_service_tier: false,
  disable_store: false,
  allow_safety_identifier: false,
  allow_include_obfuscation: false,
  allow_inference_geo: false,
  allow_speed: false,
  claude_beta_query: false,
  ollama_openai_chat: false,
  disable_task_polling_sleep: false,
  upstream_model_update_check_enabled: false,
  upstream_model_update_auto_sync_enabled: false,
  upstream_model_update_ignored_models: "",
  advanced_custom: "",
};

export type CreateChannelPayload = {
  mode: "single" | "batch" | "multi_to_single";
  multi_key_mode?: "random" | "polling";
  batch_add_set_key_prefix_2_name?: boolean;
  channel: Record<string, unknown>;
};

function normalizeHttpProtocol(value: string | undefined | null): "auto" | "http1" {
  return String(value || "").trim().toLowerCase() === HTTP_PROTOCOL_HTTP1 ? HTTP_PROTOCOL_HTTP1 : HTTP_PROTOCOL_AUTO;
}

function normalizeHttp2ConnectionShards(value: number | undefined | null): number {
  if (value == null || Number.isNaN(value) || value === 0) return 1;
  if (value < 1) return 1;
  if (value > MAX_HTTP2_CONNECTION_SHARDS) return MAX_HTTP2_CONNECTION_SHARDS;
  return value;
}

function supportsResponsesWebSocket(type: number): boolean {
  return RESPONSES_WEBSOCKET_TYPES.has(type);
}

export function normalizeUpstreamBaseUrl(value: string | undefined): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function formatGroups(groups: string[]): string {
  return groups.join(",");
}

export function parseGroups(groups: string): string[] {
  if (!groups) return [];
  return groups.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

export function splitKeys(value: string): string[] {
  const trimmed = value.trim();
  // Vertex AI / Codex 的整份 JSON 密钥（可能多行、也可能是服务账号数组）：不按行拆
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return [trimmed];
    } catch {
      /* 不是合法 JSON 就按行走，后面的逐行校验会报具体错误 */
    }
  }
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalJson(value: string | undefined): unknown {
  if (!value?.trim()) return undefined;
  return JSON.parse(value);
}

export function buildSettingJSON(formData: ChannelFormValues): string {
  const settingObj: Record<string, unknown> = {
    task_plugin_key: formData.type === CHANNEL_TYPE_TASK_PLUGIN ? formData.task_plugin_key?.trim() || "" : undefined,
    task_extend_plugin_keys:
      formData.type === CHANNEL_TYPE_NEW_API && formData.task_extend_plugin_keys?.length ? formData.task_extend_plugin_keys : undefined,
    force_format: formData.force_format || false,
    thinking_to_content: formData.thinking_to_content || false,
    proxy: formData.proxy?.trim() || "",
    pass_through_body_enabled: formData.type !== CHANNEL_TYPE_ADVANCED_CUSTOM && formData.pass_through_body_enabled === true,
    responses_websocket_enabled: supportsResponsesWebSocket(formData.type) && formData.responses_websocket_enabled === true,
    system_prompt: formData.system_prompt || "",
    system_prompt_override: formData.system_prompt_override || false,
  };
  const protocol = normalizeHttpProtocol(formData.http_protocol);
  const shards = protocol === HTTP_PROTOCOL_HTTP1 ? 1 : normalizeHttp2ConnectionShards(formData.http2_connection_shards);
  if (protocol === HTTP_PROTOCOL_HTTP1) settingObj.http_protocol = HTTP_PROTOCOL_HTTP1;
  else if (shards > 1) settingObj.http2_connection_shards = shards;
  if (formData.tls_insecure_skip_verify === true) settingObj.tls_insecure_skip_verify = true;
  return JSON.stringify(settingObj);
}

function buildSettingsJSON(formData: ChannelFormValues): string {
  let settingsObj: Record<string, unknown> = {};
  if (formData.settings && formData.settings !== "{}") {
    try {
      settingsObj = JSON.parse(formData.settings) as Record<string, unknown>;
    } catch {
      settingsObj = {};
    }
  }
  if (formData.type === 41) {
    settingsObj.vertex_key_type = formData.vertex_key_type || "json";
    const vertexProjectId = formData.vertex_project_id?.trim();
    if (settingsObj.vertex_key_type === "api_key" && vertexProjectId) settingsObj.vertex_project_id = vertexProjectId;
    else delete settingsObj.vertex_project_id;
  } else {
    delete settingsObj.vertex_key_type;
    delete settingsObj.vertex_project_id;
  }
  if (formData.type === 3 && formData.azure_responses_version) settingsObj.azure_responses_version = formData.azure_responses_version;
  else if ("azure_responses_version" in settingsObj) delete settingsObj.azure_responses_version;
  if (formData.type === 20) settingsObj.openrouter_enterprise = formData.is_enterprise_account === true;
  else if ("openrouter_enterprise" in settingsObj) delete settingsObj.openrouter_enterprise;
  if (formData.type === 33) {
    settingsObj.aws_key_type = formData.aws_key_type || "ak_sk";
    settingsObj.aws_api_type = formData.aws_api_type || "invoke_model";
  } else {
    delete settingsObj.aws_key_type;
    delete settingsObj.aws_api_type;
  }
  if (FIELD_PASSTHROUGH_TYPES.has(formData.type)) settingsObj.allow_service_tier = formData.allow_service_tier === true;
  else if ("allow_service_tier" in settingsObj) delete settingsObj.allow_service_tier;
  if (OPENAI_FIELD_PASSTHROUGH_TYPES.has(formData.type)) {
    settingsObj.disable_store = formData.disable_store === true;
    settingsObj.allow_safety_identifier = formData.allow_safety_identifier === true;
    settingsObj.allow_include_obfuscation = formData.allow_include_obfuscation === true;
  } else {
    delete settingsObj.disable_store;
    delete settingsObj.allow_safety_identifier;
    delete settingsObj.allow_include_obfuscation;
  }
  if (OPENAI_FIELD_PASSTHROUGH_TYPES.has(formData.type) || CLAUDE_FIELD_PASSTHROUGH_TYPES.has(formData.type)) {
    settingsObj.allow_inference_geo = formData.allow_inference_geo === true;
  } else if ("allow_inference_geo" in settingsObj) delete settingsObj.allow_inference_geo;
  if (CLAUDE_FIELD_PASSTHROUGH_TYPES.has(formData.type)) settingsObj.allow_speed = formData.allow_speed === true;
  else if ("allow_speed" in settingsObj) delete settingsObj.allow_speed;
  if (formData.type === 14) settingsObj.claude_beta_query = formData.claude_beta_query === true;
  else if ("claude_beta_query" in settingsObj) delete settingsObj.claude_beta_query;
  if (formData.type === CHANNEL_TYPE_OLLAMA) settingsObj.ollama_openai_chat = formData.ollama_openai_chat === true;
  else if ("ollama_openai_chat" in settingsObj) delete settingsObj.ollama_openai_chat;
  settingsObj.disable_task_polling_sleep = formData.disable_task_polling_sleep === true;
  if (MODEL_FETCHABLE_TYPES.has(formData.type)) {
    settingsObj.upstream_model_update_check_enabled = formData.upstream_model_update_check_enabled === true;
    settingsObj.upstream_model_update_auto_sync_enabled =
      settingsObj.upstream_model_update_check_enabled === true && formData.upstream_model_update_auto_sync_enabled === true;
    settingsObj.upstream_model_update_ignored_models = [
      ...new Set(String(formData.upstream_model_update_ignored_models || "").split(",").map((model) => model.trim()).filter(Boolean)),
    ];
    if (!Array.isArray(settingsObj.upstream_model_update_last_detected_models) || settingsObj.upstream_model_update_check_enabled !== true) {
      settingsObj.upstream_model_update_last_detected_models = [];
    }
    if (typeof settingsObj.upstream_model_update_last_check_time !== "number") {
      settingsObj.upstream_model_update_last_check_time = 0;
    }
  }
  if (formData.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const parsed = parseOptionalJson(formData.advanced_custom);
    if (isJsonObject(parsed)) settingsObj.advanced_custom = parsed;
  } else if ("advanced_custom" in settingsObj) delete settingsObj.advanced_custom;
  return JSON.stringify(settingsObj);
}

function blankToNull(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (record[key] === "") record[key] = null;
  }
}

export function transformFormDataToCreatePayload(formData: ChannelFormValues): CreateChannelPayload {
  const mode = formData.multi_key_mode || "single";
  const channel: Record<string, unknown> = {
    name: formData.name,
    type: formData.type,
    base_url: normalizeUpstreamBaseUrl(formData.base_url) || null,
    key: formData.key,
    openai_organization: formData.openai_organization || null,
    models: formData.models,
    group: formatGroups(formData.group),
    model_mapping: formData.model_mapping || null,
    priority: formData.priority || null,
    weight: formData.weight || null,
    test_model: formData.test_model || null,
    auto_ban: formData.auto_ban ?? 1,
    status: formData.status,
    status_code_mapping: formData.status_code_mapping || null,
    tag: formData.tag || null,
    remark: formData.remark || "",
    setting: buildSettingJSON(formData),
    param_override: formData.param_override || null,
    header_override: formData.header_override || null,
    settings: buildSettingsJSON(formData),
    other: formData.other || "",
  };
  blankToNull(channel);
  const payload: CreateChannelPayload = { mode, channel };
  if (mode === "multi_to_single") payload.multi_key_mode = formData.multi_key_type;
  if (mode === "batch") payload.batch_add_set_key_prefix_2_name = formData.batch_add_set_key_prefix_2_name;
  return payload;
}

export function transformFormDataToUpdatePayload(formData: ChannelFormValues, channelId: number): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: channelId,
    name: formData.name,
    type: formData.type,
    base_url: normalizeUpstreamBaseUrl(formData.base_url) || null,
    openai_organization: formData.openai_organization || null,
    models: formData.models,
    group: formatGroups(formData.group),
    model_mapping: formData.model_mapping || null,
    priority: formData.priority ?? 0,
    weight: formData.weight ?? 0,
    test_model: formData.test_model || null,
    auto_ban: formData.auto_ban ?? 1,
    status_code_mapping: formData.status_code_mapping || null,
    tag: formData.tag || null,
    remark: formData.remark || "",
    setting: buildSettingJSON(formData),
    param_override: formData.param_override || null,
    header_override: formData.header_override || null,
    settings: buildSettingsJSON(formData),
    other: formData.other || "",
  };
  if (formData.key && formData.key.trim()) payload.key = formData.key;
  blankToNull(payload);
  payload.base_url = normalizeUpstreamBaseUrl(formData.base_url) || "";
  payload.openai_organization = formData.openai_organization || "";
  payload.test_model = formData.test_model || "";
  payload.tag = formData.tag || "";
  payload.remark = formData.remark || "";
  payload.model_mapping = formData.model_mapping || "";
  payload.status_code_mapping = formData.status_code_mapping || "";
  payload.param_override = formData.param_override || "";
  payload.header_override = formData.header_override || "";
  return payload;
}

function jsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!isJsonObject(parsed)) throw new Error("overrideObject");
  return parsed;
}

export function validateChannelForm(formData: ChannelFormValues, editing: boolean): string | null {
  if (!formData.name.trim()) return "channelNameRequired";
  if (!Number.isFinite(formData.type)) return "channelTypeRequired";
  if (!formData.models.trim()) return "modelsRequired";
  if (!formData.group.length || formData.group.every((item) => !item.trim())) return "groupRequired";
  const base = normalizeUpstreamBaseUrl(formData.base_url);
  if (base) {
    const checked = validateBase(base);
    if (checked) return checked;
  } else if (BASE_URL_REQUIRED.has(formData.type)) {
    return "baseUrlRequired";
  }
  if (OTHER_REQUIRED.has(formData.type) && !formData.other?.trim()) return otherRequiredMessage(formData.type);
  if (formData.type === CHANNEL_TYPE_TASK_PLUGIN && !formData.task_plugin_key?.trim()) return "taskPluginRequired";
  const keys = splitKeys(formData.key);
  if (!editing && keys.length === 0 && formData.type !== 62 && formData.type !== 63) return "keyRequired";
  if (keys.length > 50) return "tooManyKeys";
  for (const key of keys) {
    const keyError = validateKey(formData, key);
    if (keyError) return keyError;
  }
  if (formData.type === 57 && formData.multi_key_mode && formData.multi_key_mode !== "single") return "codexNoBatch";
  if (formData.type === 41 && formData.vertex_key_type === "api_key" && formData.multi_key_mode && formData.multi_key_mode !== "single") {
    return "vertexNoBatch";
  }
  if (formData.model_mapping?.trim()) {
    try {
      const parsed = jsonObject(formData.model_mapping);
      if (parsed && Object.values(parsed).some((item) => typeof item !== "string")) return "modelMappingStrings";
    } catch {
      return "modelMappingObject";
    }
  }
  if (formData.status_code_mapping?.trim()) {
    try {
      const parsed = jsonObject(formData.status_code_mapping);
      if (parsed) {
        for (const [from, to] of Object.entries(parsed)) {
          const fromCode = Number(from);
          const toCode = Number(to);
          if (!Number.isInteger(fromCode) || !Number.isInteger(toCode) || fromCode < 100 || fromCode > 599 || toCode < 100 || toCode > 599) {
            return "statusCodeRange";
          }
        }
      }
    } catch {
      return "statusCodeObject";
    }
  }
  for (const field of [formData.param_override, formData.header_override] as const) {
    if (!field?.trim()) continue;
    try {
      jsonObject(field);
    } catch {
      return "overrideObject";
    }
  }
  if ((formData.remark ?? "").length > 255) return "remarkLength";
  if (formData.proxy?.trim() && !/^https?:\/\/.+/i.test(formData.proxy.trim()) && !/^socks5h?:\/\/.+/i.test(formData.proxy.trim())) {
    return "proxyInvalid";
  }
  return null;
}

function validateBase(value: string): string | null {
  if (/[\s\r\n]/.test(value)) return "baseUrlSpaces";
  let withProto = value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(withProto)) withProto = `https://${withProto}`;
  try {
    const url = new URL(withProto);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "baseUrlProtocol";
    if (url.username || url.password || url.search || url.hash) return "baseUrlExtra";
  } catch {
    return "baseUrlInvalid";
  }
  return null;
}

function otherRequiredMessage(type: number): string {
  if (type === 3) return "azureVersion";
  if (type === 39) return "cloudflareAccount";
  if (type === 41) return "vertexRegion";
  return "otherRequired";
}

function validateKey(formData: ChannelFormValues, key: string): string | null {
  if (formData.type === 33 && (formData.aws_key_type || "ak_sk") === "ak_sk" && key.split("|").map((part) => part.trim()).filter(Boolean).length < 3) {
    return "awsAkSk";
  }
  if (formData.type === 33 && formData.aws_key_type === "api_key" && key.split("|").map((part) => part.trim()).filter(Boolean).length < 2) {
    return "awsApiKey";
  }
  if (formData.type === 41 && (formData.vertex_key_type || "json") === "json") {
    try {
      const parsed = JSON.parse(key) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      if (!items.length || items.some((item) => !isJsonObject(item))) return "vertexJson";
    } catch {
      return "vertexJson";
    }
  }
  if (formData.type === 57) {
    try {
      const parsed = JSON.parse(key) as Record<string, unknown>;
      if (!isJsonObject(parsed) || typeof parsed.access_token !== "string" || !parsed.access_token.trim() || typeof parsed.account_id !== "string" || !parsed.account_id.trim()) {
        return "codexJson";
      }
    } catch {
      return "codexJson";
    }
  }
  return null;
}

export function formFromInput(input: Record<string, unknown>, fallback?: Partial<ChannelFormValues>): ChannelFormValues {
  const base = { ...CHANNEL_FORM_DEFAULT_VALUES, ...fallback };
  const groupRaw = input.group ?? base.group;
  const group = Array.isArray(groupRaw) ? groupRaw.map((item) => String(item)) : parseGroups(String(groupRaw ?? "default"));
  return {
    ...base,
    name: String(input.name ?? base.name),
    type: Number(input.type ?? base.type),
    base_url: String(input.base_url ?? input.baseUrl ?? base.base_url ?? ""),
    task_plugin_key: String(input.task_plugin_key ?? base.task_plugin_key ?? ""),
    task_extend_plugin_keys: Array.isArray(input.task_extend_plugin_keys) ? input.task_extend_plugin_keys.map((item) => String(item)) : base.task_extend_plugin_keys,
    key: String(input.key ?? ""),
    openai_organization: String(input.openai_organization ?? base.openai_organization ?? ""),
    models: String(input.models ?? base.models),
    group: group.length ? group : ["default"],
    model_mapping: String(input.model_mapping ?? input.modelMapping ?? base.model_mapping ?? ""),
    priority: Number(input.priority ?? base.priority ?? 0),
    weight: Number(input.weight ?? base.weight ?? 0),
    test_model: String(input.test_model ?? input.testModel ?? base.test_model ?? ""),
    auto_ban: input.auto_ban === undefined && input.autoBan === undefined ? base.auto_ban : input.autoBan === false || input.auto_ban === 0 ? 0 : Number(input.auto_ban ?? (input.autoBan ? 1 : 0)),
    status: Number(input.status ?? base.status ?? 1),
    status_code_mapping: String(input.status_code_mapping ?? base.status_code_mapping ?? ""),
    tag: String(input.tag ?? base.tag ?? ""),
    remark: String(input.remark ?? base.remark ?? ""),
    param_override: String(input.param_override ?? base.param_override ?? ""),
    header_override: String(input.header_override ?? base.header_override ?? ""),
    settings: String(input.settings ?? base.settings ?? "{}"),
    advanced_custom: String(input.advanced_custom ?? base.advanced_custom ?? ""),
    other: String(input.other ?? base.other ?? ""),
    multi_key_mode: (input.multi_key_mode as ChannelFormValues["multi_key_mode"]) || base.multi_key_mode,
    multi_key_type: (input.multi_key_type as ChannelFormValues["multi_key_type"]) || base.multi_key_type,
    batch_add_set_key_prefix_2_name: Boolean(input.batch_add_set_key_prefix_2_name),
    force_format: Boolean(input.force_format),
    thinking_to_content: Boolean(input.thinking_to_content),
    proxy: String(input.proxy ?? ""),
    http_protocol: input.http_protocol === "http1" ? "http1" : "auto",
    http2_connection_shards: Number(input.http2_connection_shards ?? 1),
    tls_insecure_skip_verify: Boolean(input.tls_insecure_skip_verify),
    pass_through_body_enabled: Boolean(input.pass_through_body_enabled),
    responses_websocket_enabled: Boolean(input.responses_websocket_enabled),
    system_prompt: String(input.system_prompt ?? ""),
    system_prompt_override: Boolean(input.system_prompt_override),
    is_enterprise_account: Boolean(input.is_enterprise_account),
    vertex_key_type: input.vertex_key_type === "api_key" ? "api_key" : "json",
    vertex_project_id: String(input.vertex_project_id ?? ""),
    aws_key_type: input.aws_key_type === "api_key" ? "api_key" : "ak_sk",
    aws_api_type: input.aws_api_type === "mantle" ? "mantle" : "invoke_model",
    azure_responses_version: String(input.azure_responses_version ?? ""),
    allow_service_tier: Boolean(input.allow_service_tier),
    disable_store: Boolean(input.disable_store),
    allow_safety_identifier: Boolean(input.allow_safety_identifier),
    allow_include_obfuscation: Boolean(input.allow_include_obfuscation),
    allow_inference_geo: Boolean(input.allow_inference_geo),
    allow_speed: Boolean(input.allow_speed),
    claude_beta_query: Boolean(input.claude_beta_query),
    ollama_openai_chat: Boolean(input.ollama_openai_chat),
    disable_task_polling_sleep: Boolean(input.disable_task_polling_sleep),
    upstream_model_update_check_enabled: Boolean(input.upstream_model_update_check_enabled),
    upstream_model_update_auto_sync_enabled: Boolean(input.upstream_model_update_auto_sync_enabled),
    upstream_model_update_ignored_models: String(input.upstream_model_update_ignored_models ?? ""),
  };
}

/** Format hints the original form does not enforce. Shown in yellow; save still proceeds. */
export function keyLineWarnings(type: number, line: string): string[] {
  const value = line.trim();
  if (!value) return [];
  if (type === 1 && !value.startsWith("sk-")) return ["warnSk"];
  if (type === 14 && !value.startsWith("sk-ant-")) return ["warnAnt"];
  if (type === 24 && value.length < 8) return ["warnGemini"];
  return [];
}

export function baseUrlWarning(value: string | undefined): string | null {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(trimmed)) return "warnTrailingV1";
  return null;
}

export const VOLCENGINE_ENDPOINTS = ["https://ark.cn-beijing.volces.com", "https://ark.ap-southeast.bytepluses.com"] as const;
export const VOLCENGINE_UNLOCK_CLICKS = 10;

/** Tabs from new-api v1.0.0-rc.45 ChannelConfiguration: connection, routing, request, other. */
export const CHANNEL_DRAWER_TABS = [
  { id: "connection", label: "connection" },
  { id: "routing", label: "routing" },
  { id: "request", label: "request" },
  { id: "other", label: "other" },
] as const;

export function otherFieldLabel(type: number): string {
  if (type === 3) return "otherAzure";
  if (type === 39) return "otherCloudflare";
  if (type === 41) return "otherVertex";
  if (type === 49) return "otherCoze";
  if (type === 18) return "otherXunfei";
  return "otherGeneric";
}

export function otherFieldPlaceholder(type: number): string {
  if (type === 3) return "placeholderAzure";
  if (type === 39) return "placeholderCloudflare";
  if (type === 41) return '{"default":"us-central1"}';
  if (type === 49) return "placeholderCoze";
  return "";
}
