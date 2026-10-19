import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_TYPE_OPTIONS } from "./channel-types.generated.ts";
import {
  CHANNEL_DRAWER_TABS,
  CHANNEL_FORM_DEFAULT_VALUES,
  VOLCENGINE_ENDPOINTS,
  VOLCENGINE_UNLOCK_CLICKS,
  keyLineWarnings,
  splitKeys,
  transformFormDataToCreatePayload,
  transformFormDataToUpdatePayload,
  validateChannelForm,
  type ChannelFormValues,
} from "./channel-payload.ts";
import { transformFormDataToCreatePayload as originalCreate, transformFormDataToUpdatePayload as originalUpdate } from "../vendor/new-api/v1.0.0-rc.45/payload-original.mjs";
import { todayExcludingTests } from "./billing-math.ts";

function form(partial: Partial<ChannelFormValues>): ChannelFormValues {
  return { ...CHANNEL_FORM_DEFAULT_VALUES, ...partial };
}

test("type list and drawer tabs match new-api v1.0.0-rc.45", () => {
  assert.equal(CHANNEL_TYPE_OPTIONS.length, 52);
  assert.deepEqual(CHANNEL_DRAWER_TABS.map((item) => item.id), ["connection", "routing", "request", "other"]);
  assert.equal(VOLCENGINE_ENDPOINTS.length, 2);
  assert.equal(VOLCENGINE_UNLOCK_CLICKS, 10);
  assert.equal(CHANNEL_TYPE_OPTIONS.some((item) => item.id === 45 && item.name === "VolcEngine"), true);
  assert.equal(CHANNEL_TYPE_OPTIONS.some((item) => item.id === 57), true);
});

test("create payload matches the original frontend builder", () => {
  const cases = [
    form({ name: "主渠道", models: "gpt-4o-mini", key: "relay-not-sk-shaped-key", type: 1 }),
    form({
      name: "azure",
      type: 3,
      models: "gpt-4o",
      key: "azure-key",
      base_url: "https://example.openai.azure.com/",
      other: "2025-04-01-preview",
      azure_responses_version: "preview",
      priority: 2,
      weight: 5,
      tag: "prod",
      test_model: "gpt-4o",
      auto_ban: 0,
      model_mapping: '{"gpt-4o":"dep"}',
      status_code_mapping: '{"429":"500"}',
      remark: "note",
    }),
    form({
      name: "batch",
      models: "deepseek-chat",
      key: "k1\nk2",
      multi_key_mode: "batch",
      batch_add_set_key_prefix_2_name: true,
    }),
    form({
      name: "vertex",
      type: 41,
      models: "gemini-2.0-flash",
      key: '{"type":"service_account"}',
      other: "us-central1",
      vertex_key_type: "json",
    }),
    form({
      name: "aws",
      type: 33,
      models: "claude",
      key: "AK|SK|us-east-1",
      aws_key_type: "ak_sk",
      multi_key_mode: "multi_to_single",
      multi_key_type: "polling",
    }),
  ];
  for (const item of cases) {
    assert.deepEqual(transformFormDataToCreatePayload(item), originalCreate(item));
  }
  const updating = form({ name: "主渠道", models: "gpt-4o-mini", key: "", priority: 0, weight: 0, base_url: "https://api.example.com/" });
  assert.deepEqual(transformFormDataToUpdatePayload(updating, 9), originalUpdate(updating, 9));
  assert.equal("status" in transformFormDataToUpdatePayload(updating, 9), false);
});

test("key shape warnings do not block save; structure still does", () => {
  const relay = form({ name: "中转", models: "gpt-4o-mini", key: "relay-key-without-prefix" });
  assert.equal(validateChannelForm(relay, false), null);
  assert.equal(keyLineWarnings(1, "relay-key-without-prefix").length, 1);
  assert.equal(keyLineWarnings(1, "sk-abcdefghijklmnopqrst").length, 0);
  const aws = form({ name: "aws", type: 33, models: "claude", key: "only-one-part" });
  assert.equal(validateChannelForm(aws, false), "awsAkSk");
  const vertex = form({ name: "vx", type: 41, models: "gemini", key: "not-json", other: "us-central1" });
  assert.equal(validateChannelForm(vertex, false), "vertexJson");
  const vertexOk = form({ name: "vx", type: 41, models: "gemini", key: '{"client_email":"a@b.c"}', other: "us-central1" });
  assert.equal(validateChannelForm(vertexOk, false), null);
});

test("a whole JSON key stays one key even when pretty-printed", () => {
  const pretty = '{\n  "type": "service_account",\n  "project_id": "p",\n  "private_key": "-----BEGIN PRIVATE KEY-----"\n}';
  assert.deepEqual(splitKeys(pretty), [pretty.trim()]);
  const array = '[{"client_email":"a@b.c"},{"client_email":"d@e.f"}]';
  assert.deepEqual(splitKeys(array), [array]);
  // 多行 sk- 密钥仍按行走
  assert.deepEqual(splitKeys("sk-1\nsk-2\n\nsk-3"), ["sk-1", "sk-2", "sk-3"]);
  // 不合法的多行 JSON 不吞错，交给逐行/结构校验
  assert.equal(splitKeys("{\nbroken")[0], "{");
  // 校验走整份 JSON，不因换行被拆
  const prettyForm = form({ name: "vx", type: 41, models: "gemini", key: pretty, other: "us-central1" });
  assert.equal(validateChannelForm(prettyForm, false), null);
});

test("test consume is removed from today's log stat before the baseline", () => {
  assert.equal(todayExcludingTests(1000, 40), 960);
  assert.equal(todayExcludingTests(1000, 0), 1000);
});
