/**
 * Transcribed from QuantumNous/new-api v1.0.0-rc.45
 * web/src/features/channels/lib/channel-form.ts
 * buildSettingJSON, buildSettingsJSON, transformFormDataToCreatePayload,
 * transformFormDataToUpdatePayload.
 * This file is the comparison target. Do not edit it to follow app changes.
 */
const CHANNEL_TYPE_OLLAMA = 4;
const CHANNEL_TYPE_ADVANCED_CUSTOM = 58;
const CHANNEL_TYPE_NEW_API = 60;
const CHANNEL_TYPE_TASK_PLUGIN = 61;
const HTTP_PROTOCOL_HTTP1 = "http1";
const MAX_HTTP2_CONNECTION_SHARDS = 8;
const MODEL_FETCHABLE_TYPES = new Set([1, 4, 14, 17, 20, 23, 24, 25, 26, 27, 31, 34, 35, 40, 42, 43, 47, 48, 57, 58, 59, 60, 62, 63]);
const FIELD_PASSTHROUGH_TYPES = new Set([1, 14, 57, 58, 59, 60, 62, 63]);
const OPENAI_FIELD_PASSTHROUGH_TYPES = new Set([1, 57, 58, 59, 60, 62, 63]);
const CLAUDE_FIELD_PASSTHROUGH_TYPES = new Set([14, 58, 59, 60, 62, 63]);
const RESPONSES_WEBSOCKET_TYPES = new Set([1, 57, 58, 59, 60]);

function normalizeHttpProtocol(value) {
  return String(value || "").trim().toLowerCase() === HTTP_PROTOCOL_HTTP1 ? HTTP_PROTOCOL_HTTP1 : "auto";
}
function normalizeHttp2ConnectionShards(value) {
  if (value == null || Number.isNaN(value) || value === 0) return 1;
  if (value < 1) return 1;
  if (value > MAX_HTTP2_CONNECTION_SHARDS) return MAX_HTTP2_CONNECTION_SHARDS;
  return value;
}
function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}
function formatGroups(groups) {
  return groups.join(",");
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseOptionalJson(value) {
  if (!value?.trim()) return undefined;
  return JSON.parse(value);
}

export function buildSettingJSON(formData) {
  const settingObj = {
    task_plugin_key: formData.type === CHANNEL_TYPE_TASK_PLUGIN ? formData.task_plugin_key?.trim() || "" : undefined,
    task_extend_plugin_keys:
      formData.type === CHANNEL_TYPE_NEW_API && formData.task_extend_plugin_keys?.length ? formData.task_extend_plugin_keys : undefined,
    force_format: formData.force_format || false,
    thinking_to_content: formData.thinking_to_content || false,
    proxy: formData.proxy?.trim() || "",
    pass_through_body_enabled: formData.type !== CHANNEL_TYPE_ADVANCED_CUSTOM && formData.pass_through_body_enabled === true,
    responses_websocket_enabled: RESPONSES_WEBSOCKET_TYPES.has(formData.type) && formData.responses_websocket_enabled === true,
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

function buildSettingsJSON(formData) {
  let settingsObj = {};
  if (formData.settings && formData.settings !== "{}") {
    try {
      settingsObj = JSON.parse(formData.settings);
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
    if (typeof settingsObj.upstream_model_update_last_check_time !== "number") settingsObj.upstream_model_update_last_check_time = 0;
  }
  if (formData.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const parsed = parseOptionalJson(formData.advanced_custom);
    if (isJsonObject(parsed)) settingsObj.advanced_custom = parsed;
  } else if ("advanced_custom" in settingsObj) delete settingsObj.advanced_custom;
  return JSON.stringify(settingsObj);
}

function blankToNull(record) {
  for (const key of Object.keys(record)) if (record[key] === "") record[key] = null;
}

export function transformFormDataToCreatePayload(formData) {
  const mode = formData.multi_key_mode || "single";
  const channel = {
    name: formData.name,
    type: formData.type,
    base_url: normalizeBaseUrl(formData.base_url) || null,
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
  const payload = { mode, channel };
  if (mode === "multi_to_single") payload.multi_key_mode = formData.multi_key_type;
  if (mode === "batch") payload.batch_add_set_key_prefix_2_name = formData.batch_add_set_key_prefix_2_name;
  return payload;
}

export function transformFormDataToUpdatePayload(formData, channelId) {
  const payload = {
    id: channelId,
    name: formData.name,
    type: formData.type,
    base_url: normalizeBaseUrl(formData.base_url) || null,
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
  payload.base_url = normalizeBaseUrl(formData.base_url) || "";
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
