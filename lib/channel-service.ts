import { createHash } from "node:crypto";
import { channelOrder, parseChannelKeyword } from "./channel-query";
import { channelTypeName } from "./channel-types";
import {
  formFromInput,
  splitKeys,
  transformFormDataToCreatePayload,
  transformFormDataToUpdatePayload,
  validateChannelForm,
  type ChannelFormValues,
} from "./channel-payload";
import { dbAll, dbGet, dbRun } from "./db";
import { getGateway } from "./gateways";
import { snapshotCreateBaseline } from "./billing-service";
import { ensureBinding } from "./rebind";
import { upstreamQueue } from "./rate-queue";
import { pollDelayMs } from "./billing-math";
import { addDays, shanghaiClock, shanghaiMidnight } from "./shanghai";
import { testCooldownMs } from "./settings";
import { cheapestModel } from "./test-model";
import type { SessionUser } from "./types";
import {
  addUpstreamChannel,
  fetchUpstreamChannel,
  listUpstreamChannels,
  setUpstreamStatus,
  testLogQuota,
  refreshCodexCredential,
  testUpstreamChannel,
  updateUpstreamChannel,
  type UpstreamChannel,
} from "./upstream";

const PAGE_SIZE = 50;

type ChannelRow = Record<string, unknown>;

export type ChannelView = {
  id: string;
  gatewayId: string;
  upstreamId: number;
  name: string;
  type: number;
  typeName: string;
  group: string;
  beforeQuota: number | null;
  todayQuota: number | null;
  usedQuota: number;
  successRate: number | null;
  balance: number | null;
  status: "enabled" | "disabled";
  autoDisabled: boolean;
  creatorId: string | null;
  creatorName: string;
  createdAt: number;
  lastSyncAt: number | null;
  syncStatus: string;
  syncError: string;
  baseUrl: string;
  models: string;
  modelMapping: string;
  testModel: string;
  remark: string;
  autoBan: boolean;
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
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestError: string;
  lastTestModel: string;
  autoDisableReason: string;
  autoDisableHistory: string[];
  autoDisabledAt: number | null;
  createdHere: boolean;
  upstreamMissing: boolean;
};

function successRateOf(row: ChannelRow): number | null {
  const total = Number(row.test_total_count ?? 0);
  if (total > 0) return Number(row.test_ok_count ?? 0) / total;
  if (row.last_test_ok === null || row.last_test_ok === undefined) return null;
  return Number(row.last_test_ok) === 1 ? 1 : 0;
}

function timeFromHistory(history: string[]): number | null {
  const last = history[history.length - 1];
  if (!last) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(last);
  if (!match) return null;
  const ms = Date.parse(match[1] ?? "");
  return Number.isNaN(ms) ? null : ms;
}

function view(row: ChannelRow, baseline: number | null): ChannelView {
  const statusCode = Number(row.status ?? 0);
  const used = Number(row.used_quota ?? 0);
  const today = baseline === null ? (row.today_quota === null || row.today_quota === undefined ? null : Number(row.today_quota)) : used - baseline;
  let history: string[] = [];
  try {
    const parsed = JSON.parse(String(row.auto_disable_history ?? "[]")) as unknown;
    if (Array.isArray(parsed)) history = parsed.map((item) => String(item));
  } catch {
    history = [];
  }
  return {
    id: String(row.id),
    gatewayId: String(row.gateway_id),
    upstreamId: Number(row.upstream_id),
    name: String(row.name ?? ""),
    type: Number(row.type ?? 0),
    typeName: channelTypeName(Number(row.type ?? 0)),
    group: String(row.group_name ?? ""),
    beforeQuota: baseline,
    todayQuota: today,
    usedQuota: used,
    successRate: successRateOf(row),
    balance: row.balance === null || row.balance === undefined ? null : Number(row.balance),
    status: statusCode === 1 ? "enabled" : "disabled",
    autoDisabled: statusCode === 3,
    creatorId: row.creator_user_id ? String(row.creator_user_id) : null,
    creatorName: String(row.creator_name ?? ""),
    createdAt: Number(row.upstream_created_at ?? row.created_at ?? 0),
    lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
    syncStatus: String(row.sync_status ?? "pending"),
    syncError: String(row.sync_error ?? ""),
    baseUrl: String(row.base_url ?? ""),
    models: String(row.models ?? ""),
    modelMapping: String(row.model_mapping ?? ""),
    testModel: String(row.test_model ?? ""),
    remark: String(row.remark ?? ""),
    autoBan: Number(row.auto_ban ?? 1) !== 0,
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
    responseTime: row.response_time === null || row.response_time === undefined ? null : Number(row.response_time),
    lastTestAt: row.last_test_at ? Number(row.last_test_at) : null,
    lastTestOk: row.last_test_ok === null || row.last_test_ok === undefined ? null : Number(row.last_test_ok) === 1,
    lastTestError: String(row.last_test_error ?? ""),
    lastTestModel: String(row.last_test_model ?? ""),
    autoDisableReason: String(row.auto_disable_reason ?? ""),
    autoDisableHistory: history,
    autoDisabledAt: row.auto_disabled_at ? Number(row.auto_disabled_at) : timeFromHistory(history),
    createdHere: Number(row.created_here) === 1,
    upstreamMissing: Number(row.upstream_missing) === 1,
  };
}

function httpError(message: string, status: number, values?: Record<string, string | number>): Error {
  return Object.assign(new Error(message), { status, values });
}

function canSee(actor: SessionUser, creatorId: string | null): boolean {
  return actor.role === "admin" || creatorId === actor.id;
}

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function pushKeyword(where: string[], params: unknown[], keyword: ReturnType<typeof parseChannelKeyword>): void {
  if (keyword.text) {
    where.push("(c.name LIKE ? OR CAST(c.upstream_id AS TEXT) = ?)");
    params.push(`%${keyword.text}%`, keyword.text);
    return;
  }
  if (!keyword.ids.length && !keyword.names.length) return;
  const parts: string[] = [];
  if (keyword.ids.length) {
    parts.push(`c.upstream_id IN (${keyword.ids.map(() => "?").join(",")})`);
    params.push(...keyword.ids);
  }
  for (const name of keyword.names) {
    parts.push("c.name LIKE ?");
    params.push(`%${name}%`);
  }
  where.push(`(${parts.join(" OR ")})`);
}

function statusClause(status: string): string {
  if (status === "enabled" || status === "running") return "c.status = 1 AND c.upstream_missing = 0";
  if (status === "manual") return "c.status = 2 AND c.upstream_missing = 0";
  if (status === "auto") return "c.status = 3 AND c.upstream_missing = 0";
  if (status === "disabled") return "c.status <> 1";
  if (status === "missing") return "c.upstream_missing = 1 AND c.missing_handled = 0";
  if (status === "anomaly") return "(c.status = 3 OR c.upstream_missing = 1 OR c.sync_status NOT IN ('ok', 'pending'))";
  return "";
}

async function loadStats(scopeWhere: string, scopeParams: unknown[], day: string) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(day, index - 6));
  const rows = (await dbAll(
    `SELECT c.created_at, c.status, c.upstream_missing, c.used_quota, c.today_quota, b.baseline AS today_baseline
     FROM channels c
     LEFT JOIN channel_baselines b ON b.channel_id = c.id AND b.day = ?
     WHERE ${scopeWhere}`,
    [day, ...scopeParams],
  )) as ChannelRow[];
  const bounds = days.map((item) => shanghaiMidnight(addDays(item, 1)));
  const createdBefore = (end: number, match: (row: ChannelRow) => boolean) =>
    rows.reduce((count, row) => (Number(row.created_at ?? 0) < end && match(row) ? count + 1 : count), 0);
  const enabledRow = (row: ChannelRow) => Number(row.status) === 1 && Number(row.upstream_missing) !== 1;
  const disabledRow = (row: ChannelRow) => Number(row.status) !== 1;
  const todayOf = (row: ChannelRow) => {
    const used = Number(row.used_quota ?? 0);
    if (row.today_baseline === null || row.today_baseline === undefined) return Number(row.today_quota ?? 0);
    return used - Number(row.today_baseline);
  };
  const bills = (await dbAll(
    `SELECT r.bill_day AS day, SUM(r.consumption) AS n
     FROM billing_rows r
     JOIN channels c ON c.id = r.channel_id
     WHERE r.bill_day >= ? AND r.bill_day < ? AND ${scopeWhere}
     GROUP BY r.bill_day`,
    [days[0], day, ...scopeParams],
  )) as { day: string; n: number }[];
  const billed = new Map(bills.map((item) => [String(item.day), Number(item.n ?? 0)]));
  const todayQuota = rows.reduce((sum, row) => sum + todayOf(row), 0);
  const yesterdayRow = await dbGet(
    `SELECT COALESCE(SUM(r.consumption), 0) AS n
     FROM billing_rows r JOIN channels c ON c.id = r.channel_id
     WHERE r.bill_day = ? AND r.kind = 'amount' AND ${scopeWhere}`,
    [addDays(day, -1), ...scopeParams],
  );
  const pull = (await dbGet(
    `SELECT
       COALESCE(SUM(CASE WHEN c.sync_status = 'ok' AND c.upstream_missing = 0 THEN 1 ELSE 0 END), 0) AS ok_n,
       COALESCE(SUM(CASE WHEN c.sync_status = 'pending' THEN 1 ELSE 0 END), 0) AS queued_n,
       COALESCE(SUM(CASE WHEN c.next_poll_at > ? AND c.consecutive_failures >= 2 THEN 1 ELSE 0 END), 0) AS backoff_n,
       COALESCE(SUM(CASE WHEN c.consecutive_failures >= 3 AND c.sync_status NOT IN ('ok', 'pending') THEN 1 ELSE 0 END), 0) AS throttled_n,
       COALESCE(SUM(CASE WHEN c.sync_status NOT IN ('ok', 'pending', 'missing') THEN 1 ELSE 0 END), 0) AS failed_n,
       COALESCE(SUM(CASE WHEN c.sync_status IN ('missing', 'unsynced') OR c.upstream_missing = 1 THEN 1 ELSE 0 END), 0) AS unsynced_n,
       COALESCE(SUM(CASE WHEN c.status = 3 AND c.upstream_missing = 0 THEN 1 ELSE 0 END), 0) AS auto_n,
       COALESCE(SUM(CASE WHEN c.upstream_missing = 1 OR c.sync_status NOT IN ('ok', 'pending') THEN 1 ELSE 0 END), 0) AS pull_n
     FROM channels c WHERE ${scopeWhere}`,
    [Date.now(), ...scopeParams],
  )) as ChannelRow | undefined;
  const queue = upstreamQueue.snapshot();
  return {
    total: rows.length,
    enabled: rows.reduce((count, row) => count + (enabledRow(row) ? 1 : 0), 0),
    disabled: rows.reduce((count, row) => count + (disabledRow(row) ? 1 : 0), 0),
    running: rows.reduce((count, row) => count + (enabledRow(row) ? 1 : 0), 0),
    anomaly: rows.reduce((count, row) => count + (Number(row.status) === 3 || Number(row.upstream_missing) === 1 ? 1 : 0), 0),
    autoDisabled: Number(pull?.auto_n ?? 0),
    pullFailed: Number(pull?.pull_n ?? 0),
    todayQuota,
    yesterdayQuota: Number(yesterdayRow?.n ?? 0),
    queue: {
      hits: queue.hitsThisMinute,
      limit: queue.limits.gatewayPerMin,
      inflight: queue.inflight,
      concurrency: queue.limits.concurrency,
      channelPerMin: queue.limits.channelPerMin,
      ok: Number(pull?.ok_n ?? 0),
      queued: Number(pull?.queued_n ?? 0),
      backoff: Number(pull?.backoff_n ?? 0),
      throttled: Number(pull?.throttled_n ?? 0),
      failed: Number(pull?.failed_n ?? 0),
      unsynced: Number(pull?.unsynced_n ?? 0),
    },
    sparklines: {
      total: bounds.map((end) => createdBefore(end, () => true)),
      enabled: bounds.map((end) => createdBefore(end, enabledRow)),
      disabled: bounds.map((end) => createdBefore(end, disabledRow)),
      today: days.map((item) => (item === day ? todayQuota : (billed.get(item) ?? 0))),
    },
  };
}

export async function queryChannels(actor: SessionUser, search: URLSearchParams) {
  const page = Math.max(1, Number(search.get("page") ?? 1) || 1);
  const gatewayId = search.get("gateway")?.trim() ?? "";
  const keyword = parseChannelKeyword(search.get("keyword") ?? "");
  const group = search.get("group")?.trim() ?? "";
  const creator = search.get("creator")?.trim() ?? "";
  const status = search.get("status")?.trim() ?? "";
  const type = search.get("type")?.trim() ?? "";
  const order = channelOrder(search.get("sort"), search.get("dir"));
  const where = ["c.created_here = 1"];
  const params: unknown[] = [];
  const scope = ["c.created_here = 1"];
  const scopeParams: unknown[] = [];
  if (actor.role !== "admin") {
    where.push("c.creator_user_id = ?");
    params.push(actor.id);
    scope.push("c.creator_user_id = ?");
    scopeParams.push(actor.id);
  } else if (creator) {
    where.push("c.creator_user_id = ?");
    params.push(creator);
  }
  if (gatewayId) {
    where.push("c.gateway_id = ?");
    params.push(gatewayId);
    scope.push("c.gateway_id = ?");
    scopeParams.push(gatewayId);
  }
  if (group) {
    where.push("c.group_name = ?");
    params.push(group);
  }
  if (type) {
    where.push("c.type = ?");
    params.push(Number(type));
  }
  pushKeyword(where, params, keyword);
  const day = shanghaiClock().day;
  const filtered = where.join(" AND ");
  const counted = (await dbGet(
    `SELECT COUNT(*) AS all_n,
            COALESCE(SUM(CASE WHEN c.status = 1 AND c.upstream_missing = 0 THEN 1 ELSE 0 END), 0) AS enabled_n,
            COALESCE(SUM(CASE WHEN c.status = 2 AND c.upstream_missing = 0 THEN 1 ELSE 0 END), 0) AS manual_n,
            COALESCE(SUM(CASE WHEN c.status = 3 AND c.upstream_missing = 0 THEN 1 ELSE 0 END), 0) AS auto_n,
            COALESCE(SUM(CASE WHEN c.status <> 1 THEN 1 ELSE 0 END), 0) AS disabled_n,
            COALESCE(SUM(CASE WHEN c.status = 3 OR c.upstream_missing = 1 OR c.sync_status NOT IN ('ok', 'pending') THEN 1 ELSE 0 END), 0) AS anomaly_n
     FROM channels c WHERE ${filtered}`,
    params,
  )) as ChannelRow | undefined;
  const clause = statusClause(status);
  if (clause) where.push(clause);
  const sqlWhere = where.join(" AND ");
  const totalRow = clause ? await dbGet(`SELECT COUNT(*) AS n FROM channels c WHERE ${sqlWhere}`, params) : counted;
  const rows = (await dbAll(
    `SELECT c.*, u.name AS creator_name, b.baseline AS today_baseline
     FROM channels c
     LEFT JOIN users u ON u.id = c.creator_user_id
     LEFT JOIN channel_baselines b ON b.channel_id = c.id AND b.day = ?
     WHERE ${sqlWhere}
     ${order.sql}
     LIMIT ? OFFSET ?`,
    [day, ...params, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  )) as ChannelRow[];
  const groups = (await dbAll(
    `SELECT DISTINCT group_name FROM channels c WHERE c.created_here = 1 AND ${actor.role === "admin" ? "1 = 1" : "c.creator_user_id = ?"} ORDER BY group_name`,
    actor.role === "admin" ? [] : [actor.id],
  )) as { group_name: string }[];
  const creators = (await dbAll(
    `SELECT DISTINCT u.id, u.name, u.username FROM channels c JOIN users u ON u.id = c.creator_user_id WHERE c.created_here = 1 ORDER BY u.name`,
  )) as { id: string; name: string; username: string }[];
  const types = (await dbAll(
    `SELECT DISTINCT type FROM channels c WHERE c.created_here = 1 AND ${actor.role === "admin" ? "1 = 1" : "c.creator_user_id = ?"} ORDER BY type`,
    actor.role === "admin" ? [] : [actor.id],
  )) as { type: number }[];
  const stats = await loadStats(scope.join(" AND "), scopeParams, day);
  return {
    page,
    pageSize: PAGE_SIZE,
    total: Number((clause ? totalRow?.n : counted?.all_n) ?? 0),
    sort: order.sort,
    dir: order.dir,
    recognized: keyword.recognized,
    truncated: keyword.truncated,
    counts: {
      all: Number(counted?.all_n ?? 0),
      enabled: Number(counted?.enabled_n ?? 0),
      running: Number(counted?.enabled_n ?? 0),
      manual: Number(counted?.manual_n ?? 0),
      auto: Number(counted?.auto_n ?? 0),
      disabled: Number(counted?.disabled_n ?? 0),
      anomaly: Number(counted?.anomaly_n ?? 0),
    },
    stats,
    items: rows.map((row) => view(row, row.today_baseline === null || row.today_baseline === undefined ? null : Number(row.today_baseline))),
    groups: groups.map((item) => item.group_name).filter(Boolean),
    creators: actor.role === "admin" ? creators : creators.filter((item) => item.id === actor.id),
    types: types.map((item) => ({ id: Number(item.type), name: channelTypeName(Number(item.type)) })),
  };
}

async function ownedRow(actor: SessionUser, id: string): Promise<ChannelRow> {
  const row = (await dbGet("SELECT * FROM channels WHERE id = ?", [id])) as ChannelRow | undefined;
  if (!row || Number(row.created_here) !== 1 || !canSee(actor, row.creator_user_id ? String(row.creator_user_id) : null)) throw httpError("notFound", 404);
  return row;
}

async function audit(actor: SessionUser, channelId: string | null, upstreamId: number | null, action: string, result: string, detail: string): Promise<void> {
  await dbRun(
    `INSERT INTO channel_audits (id, actor_user_id, channel_id, upstream_id, action, result, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), actor.id, channelId, upstreamId, action, result, detail.slice(0, 300), Date.now()],
  );
}

function formFromRow(row: ChannelRow): Partial<ChannelFormValues> {
  return formFromInput({
    name: row.name,
    type: row.type,
    base_url: row.base_url,
    models: row.models,
    group: row.group_name,
    model_mapping: row.model_mapping,
    priority: row.priority,
    weight: row.weight,
    test_model: row.test_model,
    auto_ban: row.auto_ban,
    status: row.status,
    status_code_mapping: row.status_code_mapping,
    tag: row.tag,
    remark: row.remark,
    param_override: row.param_override,
    header_override: row.header_override,
    settings: row.settings,
    other: row.other,
    openai_organization: row.openai_organization,
  });
}

export async function createChannels(actor: SessionUser, body: Record<string, unknown>) {
  const gateway = await getGateway(String(body.gatewayId ?? ""));
  if (!gateway) throw httpError("gatewayRequired", 400);
  const form = formFromInput(body);
  const keys = splitKeys(form.key);
  if (keys.length > 1 && (!form.multi_key_mode || form.multi_key_mode === "single")) form.multi_key_mode = "batch";
  const error = validateChannelForm(form, false);
  if (error) throw httpError(error, 400);
  const dupes = await duplicateFingerprints(gateway.id, keys);
  const payload = transformFormDataToCreatePayload(form);
  const before = new Set(
    ((await dbAll("SELECT upstream_id FROM channels WHERE gateway_id = ?", [gateway.id])) as { upstream_id: number }[]).map((item) => Number(item.upstream_id)),
  );
  try {
    await addUpstreamChannel(gateway, payload);
  } catch (cause) {
    await audit(actor, null, null, "create", "fail", cause instanceof Error ? cause.message : "createFailed");
    throw cause;
  }
  const createdIds: string[] = [];
  let claimed = 0;
  for (let page = 1; page <= 5; page += 1) {
    const listed = await listUpstreamChannels(gateway, page);
    for (const item of listed.items) {
      if (before.has(item.id) || item.name !== form.name) continue;
      const id = await rememberChannel(gateway.id, item, actor.id, fingerprint(keys[claimed] ?? keys[0] ?? ""));
      if (id) {
        const quota = Number.isFinite(item.usedQuota) ? item.usedQuota : 0;
        await dbRun("UPDATE channels SET created_here = 1, creator_user_id = ?, create_baseline = ? WHERE id = ?", [actor.id, quota, id]);
        await snapshotCreateBaseline(id, quota);
        await ensureBinding(id, gateway.id, item.id, quota);
        createdIds.push(id);
      }
      claimed += 1;
    }
    if (claimed >= Math.max(1, form.multi_key_mode === "multi_to_single" ? 1 : keys.length) || page * 20 >= listed.total) break;
  }
  await audit(actor, createdIds[0] ?? null, null, "create", "ok", `created ${claimed}`);
  const tests = [];
  for (const id of createdIds) tests.push(await testChannel(actor, id, "", { ignoreCooldown: true, origin: "auto-save" }));
  return { created: claimed, ids: createdIds, duplicateKeys: dupes, tests };
}

async function duplicateFingerprints(gatewayId: string, keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  const wanted = new Set(keys.map(fingerprint));
  const rows = (await dbAll("SELECT key_fingerprints FROM channels WHERE gateway_id = ? AND created_here = 1", [gatewayId])) as { key_fingerprints: string }[];
  let count = 0;
  for (const row of rows) {
    for (const item of String(row.key_fingerprints ?? "").split(",").filter(Boolean)) {
      if (wanted.has(item)) count += 1;
    }
  }
  return count;
}

async function rememberChannel(gatewayId: string, item: UpstreamChannel, creatorId: string | null, keyFingerprint = ""): Promise<string | null> {
  const now = Date.now();
  const existing = (await dbGet("SELECT id, creator_user_id, created_here, auto_disable_reason, auto_disable_history, auto_disabled_at, key_fingerprints FROM channels WHERE gateway_id = ? AND upstream_id = ?", [
    gatewayId,
    item.id,
  ])) as ChannelRow | undefined;
  if (existing && Number(existing.created_here) !== 1 && !creatorId) return null;
  if (!existing && !creatorId) return null;
  const history = rememberDisable(existing, item, now);
  if (existing) {
    await dbRun(
      `UPDATE channels SET name = ?, type = ?, group_name = ?, status = ?, base_url = ?, models = ?, model_mapping = ?,
        test_model = ?, remark = ?, auto_ban = ?, balance = ?, used_quota = ?, today_quota = COALESCE(?, today_quota),
        upstream_created_at = ?, updated_at = ?, last_sync_at = ?, sync_status = 'ok', sync_error = NULL, consecutive_failures = 0,
        creator_user_id = COALESCE(creator_user_id, ?),
        priority = ?, weight = ?, tag = ?, other = ?, status_code_mapping = ?, param_override = ?, header_override = ?,
        setting = ?, settings = ?, openai_organization = ?, response_time = COALESCE(?, response_time),
        auto_disable_reason = ?, auto_disable_history = ?, auto_disabled_at = ?,
        key_fingerprints = CASE WHEN ? = '' THEN key_fingerprints ELSE ? END,
        upstream_missing = 0
       WHERE id = ?`,
      [
        item.name, item.type, item.group || "default", item.status, item.baseUrl, item.models, item.modelMapping,
        item.testModel, item.remark, item.autoBan ? 1 : 0, item.balance, item.usedQuota, item.todayFromPayload,
        item.createdTime ? item.createdTime * 1000 : now, now, now, creatorId,
        item.priority, item.weight, item.tag, item.other, item.statusCodeMapping, item.paramOverride, item.headerOverride,
        item.setting, item.settings || "{}", item.openaiOrganization, item.responseTime,
        history.reason, history.history, history.at, keyFingerprint, keyFingerprint, existing.id,
      ],
    );
    return String(existing.id);
  }
  const id = crypto.randomUUID();
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, base_url, models, model_mapping,
      test_model, remark, auto_ban, balance, used_quota, today_quota, upstream_created_at, created_at, updated_at,
      last_sync_at, sync_status, consecutive_failures, next_poll_at, demo_fail_left,
      priority, weight, tag, other, status_code_mapping, param_override, header_override, setting, settings,
      openai_organization, response_time, auto_disable_reason, auto_disable_history, auto_disabled_at, key_fingerprints
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, gatewayId, item.id, creatorId, item.name, item.type, item.group || "default", item.status, item.baseUrl, item.models,
      item.modelMapping, item.testModel, item.remark, item.autoBan ? 1 : 0, item.balance, item.usedQuota, item.todayFromPayload,
      item.createdTime ? item.createdTime * 1000 : now, now, now, now,
      item.priority, item.weight, item.tag, item.other, item.statusCodeMapping, item.paramOverride, item.headerOverride,
      item.setting, item.settings || "{}", item.openaiOrganization, item.responseTime, history.reason, history.history, history.at, keyFingerprint,
    ],
  );
  return id;
}

function rememberDisable(existing: ChannelRow | undefined, item: UpstreamChannel, now: number): { reason: string; history: string; at: number | null } {
  let history: string[] = [];
  try {
    const parsed = JSON.parse(String(existing?.auto_disable_history ?? "[]")) as unknown;
    if (Array.isArray(parsed)) history = parsed.map((entry) => String(entry));
  } catch {
    history = [];
  }
  let reason = String(existing?.auto_disable_reason ?? "");
  const previousAt = existing?.auto_disabled_at ? Number(existing.auto_disabled_at) : timeFromHistory(history);
  if (item.status !== 3) return { reason, history: JSON.stringify(history.slice(-20)), at: previousAt };
  const next = item.statusReason || reason || "autoDisabled";
  const same = reason === next && history.length > 0;
  const stamp = item.statusTime ?? (same && previousAt ? previousAt : now);
  reason = next;
  const line = `${new Date(stamp).toISOString()} ${next}`;
  if (same) history[history.length - 1] = line;
  else if (history[history.length - 1] !== line) history.push(line);
  return { reason, history: JSON.stringify(history.slice(-20)), at: stamp };
}

export async function updateChannel(actor: SessionUser, id: string, body: Record<string, unknown>) {
  if (body.autoBanOnly === true) return setAutoBan(actor, id, body.auto_ban !== 0 && body.auto_ban !== false && body.autoBan !== false);
  const row = await ownedRow(actor, id);
  const gateway = await getGateway(String(row.gateway_id));
  if (!gateway) throw httpError("gatewayMissing", 404);
  const form = formFromInput(body, formFromRow(row));
  form.key = String(body.key ?? "");
  const error = validateChannelForm(form, true);
  if (error) throw httpError(error, 400);
  const payload = transformFormDataToUpdatePayload(form, Number(row.upstream_id));
  try {
    await updateUpstreamChannel(gateway, payload);
  } catch (cause) {
    await audit(actor, id, Number(row.upstream_id), "update", "fail", cause instanceof Error ? cause.message : "saveFailed");
    throw cause;
  }
  const fresh = await fetchUpstreamChannel(gateway, Number(row.upstream_id));
  if (fresh) await rememberChannel(gateway.id, fresh, row.creator_user_id ? String(row.creator_user_id) : null, form.key.trim() ? splitKeys(form.key).map(fingerprint).join(",") : "");
  await audit(actor, id, Number(row.upstream_id), "update", "ok", form.name);
  return { ok: true };
}

export async function setAutoBan(actor: SessionUser, id: string, enabled: boolean) {
  const row = await ownedRow(actor, id);
  const gateway = await getGateway(String(row.gateway_id));
  if (!gateway) throw httpError("gatewayMissing", 404);
  const form = hydrateStoredForm(row);
  form.auto_ban = enabled ? 1 : 0;
  form.key = "";
  const error = validateChannelForm(form, true);
  if (error) throw httpError(error, 400);
  try {
    await updateUpstreamChannel(gateway, transformFormDataToUpdatePayload(form, Number(row.upstream_id)));
  } catch (cause) {
    await audit(actor, id, Number(row.upstream_id), "auto-ban", "fail", cause instanceof Error ? cause.message : "saveFailed");
    throw cause;
  }
  await dbRun("UPDATE channels SET auto_ban = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, Date.now(), id]);
  await audit(actor, id, Number(row.upstream_id), "auto-ban", "ok", enabled ? "on" : "off");
  return { ok: true, autoBan: enabled };
}

function hydrateStoredForm(row: ChannelRow): ChannelFormValues {
  const form = formFromRow(row) as ChannelFormValues;
  try {
    const settings = JSON.parse(String(row.settings ?? "{}")) as Record<string, unknown>;
    form.vertex_key_type = settings.vertex_key_type === "api_key" ? "api_key" : "json";
    form.vertex_project_id = String(settings.vertex_project_id ?? "");
    form.aws_key_type = settings.aws_key_type === "api_key" ? "api_key" : "ak_sk";
    form.aws_api_type = settings.aws_api_type === "mantle" ? "mantle" : "invoke_model";
    form.azure_responses_version = String(settings.azure_responses_version ?? "");
    form.is_enterprise_account = settings.openrouter_enterprise === true;
    form.allow_service_tier = settings.allow_service_tier === true;
    form.allow_safety_identifier = settings.allow_safety_identifier === true;
    form.allow_include_obfuscation = settings.allow_include_obfuscation === true;
    form.allow_inference_geo = settings.allow_inference_geo === true;
    form.allow_speed = settings.allow_speed === true;
    form.claude_beta_query = settings.claude_beta_query === true;
    form.ollama_openai_chat = settings.ollama_openai_chat === true;
  } catch {
    /* stored settings stay at defaults */
  }
  try {
    const setting = JSON.parse(String(row.setting ?? "{}")) as Record<string, unknown>;
    form.proxy = String(setting.proxy ?? "");
    form.force_format = setting.force_format === true;
    form.thinking_to_content = setting.thinking_to_content === true;
    form.pass_through_body_enabled = setting.pass_through_body_enabled === true;
    form.system_prompt = String(setting.system_prompt ?? "");
    form.system_prompt_override = setting.system_prompt_override === true;
    form.http_protocol = setting.http_protocol === "http1" ? "http1" : "auto";
  } catch {
    /* stored setting stays at defaults */
  }
  return form;
}

export async function changeStatus(actor: SessionUser, ids: string[], enabled: boolean) {
  if (!ids.length) throw httpError("selectChannels", 400);
  const status = enabled ? 1 : 2;
  const tests = [];
  const redisabledItems: { id: string; name: string; reason: string }[] = [];
  const failedItems: { id: string; name: string; reason: string }[] = [];
  let ok = 0;
  let fail = 0;
  let lastError = "statusFailed";
  for (const id of ids) {
    let row: ChannelRow;
    try {
      row = await ownedRow(actor, id);
    } catch (cause) {
      fail += 1;
      lastError = cause instanceof Error ? cause.message : lastError;
      failedItems.push({ id, name: id, reason: lastError });
      continue;
    }
    const gateway = await getGateway(String(row.gateway_id));
    if (!gateway) {
      fail += 1;
      lastError = "gatewayMissing";
      failedItems.push({ id, name: String(row.name ?? id), reason: lastError });
      await audit(actor, id, Number(row.upstream_id), enabled ? "enable" : "disable", "fail", lastError);
      continue;
    }
    try {
      await setUpstreamStatus(gateway, Number(row.upstream_id), status);
    } catch (cause) {
      fail += 1;
      lastError = cause instanceof Error ? cause.message : "statusFailed";
      failedItems.push({ id, name: String(row.name ?? id), reason: lastError });
      await audit(actor, id, Number(row.upstream_id), enabled ? "enable" : "disable", "fail", lastError);
      continue;
    }
    await dbRun(
      "UPDATE channels SET status = ?, updated_at = ?, last_sync_at = ?, sync_status = 'ok', sync_error = NULL WHERE id = ?",
      [status, Date.now(), Date.now(), id],
    );
    await audit(actor, id, Number(row.upstream_id), enabled ? "enable" : "disable", "ok", String(row.name));
    ok += 1;
    if (!enabled) continue;
    const result = await testChannel(actor, id, "", { ignoreCooldown: true, origin: "auto-enable" });
    tests.push(result);
    const fresh = await fetchUpstreamChannel(gateway, Number(row.upstream_id));
    if (fresh) await rememberChannel(gateway.id, fresh, row.creator_user_id ? String(row.creator_user_id) : null);
    const after = await dbGet("SELECT status, auto_disable_reason, name FROM channels WHERE id = ?", [id]);
    if (Number(after?.status) === 3) redisabledItems.push({ id, name: String(after?.name ?? row.name), reason: String(after?.auto_disable_reason ?? "") });
  }
  if (ids.length === 1 && ok === 0) throw httpError(lastError, 400);
  return { ok, fail, redisabled: redisabledItems.length, redisabledItems, failedItems, tests };
}

export type TestOutcome = {
  id: string;
  name: string;
  ok: boolean;
  model: string;
  latencyMs: number;
  message: string;
};

export async function testChannel(
  actor: SessionUser,
  id: string,
  model: string,
  options: { ignoreCooldown?: boolean; origin?: string } = {},
): Promise<TestOutcome> {
  const row = await ownedRow(actor, id);
  const gateway = await getGateway(String(row.gateway_id));
  if (!gateway) throw httpError("gatewayMissing", 404);
  const cooldown = await testCooldownMs();
  const last = Number(row.last_test_at ?? 0);
  if (!options.ignoreCooldown && cooldown > 0 && last && Date.now() - last < cooldown) {
    const minutes = Math.ceil((cooldown - (Date.now() - last)) / 60_000);
    throw httpError("cooldown", 429, { minutes });
  }
  const chosen = model.trim() || String(row.test_model ?? "").trim() || cheapestModel(String(row.models ?? ""));
  const started = Date.now();
  let outcome: TestOutcome;
  try {
    const result = await testUpstreamChannel(gateway, Number(row.upstream_id), chosen);
    const latencyMs = result.timeSeconds > 0 ? Math.round(result.timeSeconds * 1000) : Date.now() - started;
    outcome = {
      id,
      name: String(row.name),
      ok: result.success,
      model: chosen,
      latencyMs,
      message: result.success ? "" : result.message || "testFailed",
    };
  } catch (cause) {
    outcome = { id, name: String(row.name), ok: false, model: chosen, latencyMs: Date.now() - started, message: cause instanceof Error ? cause.message : "testFailed" };
  }
  let quota: number | null = null;
  if (outcome.ok) {
    try {
      quota = await testLogQuota(gateway, Number(row.upstream_id), started - 5_000, Date.now() + 5_000);
    } catch {
      quota = null;
    }
    if ((quota === null || quota === 0) && gateway.demo) quota = 8;
  }
  await dbRun(
    `INSERT INTO test_runs (id, channel_id, actor_user_id, model, result, latency_ms, error, quota, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), id, actor.id, chosen, outcome.ok ? "ok" : "fail", outcome.latencyMs, outcome.message, quota, Date.now()],
  );
  await dbRun(
    `UPDATE channels SET last_test_at = ?, last_test_ok = ?, last_test_error = ?, last_test_model = ?, response_time = ?,
      test_total_count = COALESCE(test_total_count, 0) + 1, test_ok_count = COALESCE(test_ok_count, 0) + ?, updated_at = ? WHERE id = ?`,
    [Date.now(), outcome.ok ? 1 : 0, outcome.message, chosen, outcome.latencyMs, outcome.ok ? 1 : 0, Date.now(), id],
  );
  await audit(actor, id, Number(row.upstream_id), options.origin ?? "test", outcome.ok ? "ok" : "fail", `${chosen} ${outcome.latencyMs}ms ${outcome.message}`.trim());
  return outcome;
}

export async function refreshCodex(actor: SessionUser, id: string): Promise<{ message: string; accountId: string; email: string }> {
  const row = await ownedRow(actor, id);
  if (Number(row.type) !== 57) throw httpError("codexOnly", 400);
  const gateway = await getGateway(String(row.gateway_id));
  if (!gateway) throw httpError("gatewayMissing", 404);
  try {
    const refreshed = await refreshCodexCredential(gateway, Number(row.upstream_id));
    await audit(actor, id, Number(row.upstream_id), "codex-refresh", "ok", refreshed.accountId || refreshed.message);
    return refreshed;
  } catch (cause) {
    await audit(actor, id, Number(row.upstream_id), "codex-refresh", "fail", cause instanceof Error ? cause.message : "refreshFailed");
    throw cause;
  }
}

export async function matchingFingerprints(gatewayId: string, keys: string[]): Promise<number> {
  const gateway = await getGateway(gatewayId);
  if (!gateway) throw httpError("gatewayRequired", 400);
  return duplicateFingerprints(gatewayId, keys);
}

export async function syncGatewayPage(gatewayId: string, page: number): Promise<{ done: boolean }> {
  const gateway = await getGateway(gatewayId);
  if (!gateway) return { done: true };
  try {
    if (page <= 1) await dbRun("DELETE FROM gateway_list_seen WHERE gateway_id = ?", [gatewayId]);
    const listed = await listUpstreamChannels(gateway, page);
    for (const item of listed.items) {
      await rememberChannel(gateway.id, item, null);
      await dbRun(
        "INSERT INTO gateway_list_seen (gateway_id, upstream_id) VALUES (?, ?) ON CONFLICT(gateway_id, upstream_id) DO NOTHING",
        [gatewayId, item.id],
      );
    }
    const done = page * 20 >= listed.total;
    if (done) await finishGatewayList(gatewayId);
    return { done };
  } catch (error) {
    const message = error instanceof Error ? error.message : "syncFailed";
    const rateLimited = /繁忙|限流|超时/.test(message);
    await dbRun(
      `UPDATE channels SET sync_status = ?, sync_error = ?, consecutive_failures = consecutive_failures + 1, next_poll_at = ?, last_sync_at = ?
       WHERE gateway_id = ?`,
      [rateLimited ? "rate_limited" : "failed", message, Date.now() + pollDelayMs(2), Date.now(), gatewayId],
    );
    return { done: true };
  }
}

/** A full upstream list finished. Missing ids stay as local rows when we created them; a new id is never attached to an old row. */
async function finishGatewayList(gatewayId: string): Promise<void> {
  await dbRun(
    `UPDATE channels SET upstream_missing = 0
     WHERE gateway_id = ? AND created_here = 1
       AND upstream_id IN (SELECT upstream_id FROM gateway_list_seen WHERE gateway_id = ?)`,
    [gatewayId, gatewayId],
  );
  await dbRun(
    `UPDATE channels SET upstream_missing = 1, sync_status = 'missing', sync_error = 'missing'
     WHERE gateway_id = ? AND created_here = 1
       AND upstream_id NOT IN (SELECT upstream_id FROM gateway_list_seen WHERE gateway_id = ?)`,
    [gatewayId, gatewayId],
  );
  await dbRun("DELETE FROM channels WHERE gateway_id = ? AND created_here = 0", [gatewayId]);
  await dbRun("DELETE FROM gateway_list_seen WHERE gateway_id = ?", [gatewayId]);
}

export async function gatewayIds(): Promise<string[]> {
  const rows = (await dbAll("SELECT id FROM gateways WHERE disabled = 0")) as { id: string }[];
  return rows.map((row) => row.id);
}

export async function channelsDue(now = Date.now()): Promise<{ gatewayId: string; upstreamId: number; failures: number }[]> {
  const rows = (await dbAll(
    "SELECT gateway_id, upstream_id, consecutive_failures FROM channels WHERE created_here = 1 AND next_poll_at <= ? ORDER BY next_poll_at ASC LIMIT 20",
    [now],
  )) as { gateway_id: string; upstream_id: number; consecutive_failures: number }[];
  return rows.map((row) => ({ gatewayId: row.gateway_id, upstreamId: Number(row.upstream_id), failures: Number(row.consecutive_failures ?? 0) }));
}
