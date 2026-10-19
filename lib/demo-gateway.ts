import { dbAll, dbGet, dbRun } from "./db";
import { UpstreamFailure } from "./upstream";
import { addDays, shanghaiClock } from "./shanghai";

const DEMO_ID = "demo";

type Row = Record<string, unknown>;

function rawChannel(row: Row) {
  const reason = String(row.auto_disable_reason ?? "");
  return {
    id: Number(row.upstream_id),
    name: row.name,
    type: row.type,
    status: row.status,
    group: row.group_name,
    used_quota: row.used_quota,
    balance: row.balance,
    base_url: row.base_url,
    models: row.models,
    model_mapping: row.model_mapping,
    test_model: row.test_model,
    remark: row.remark,
    auto_ban: row.auto_ban,
    created_time: Math.floor(Number(row.upstream_created_at ?? row.created_at) / 1000),
    priority: row.priority ?? 0,
    weight: row.weight ?? 0,
    tag: row.tag ?? "",
    other: row.other ?? "",
    status_code_mapping: row.status_code_mapping ?? "",
    param_override: row.param_override ?? "",
    header_override: row.header_override ?? "",
    setting: row.setting ?? "",
    settings: row.settings ?? "{}",
    openai_organization: row.openai_organization ?? "",
    response_time: row.response_time ?? null,
    other_info: reason
      ? JSON.stringify({
          status_reason: reason,
          ...(row.auto_disabled_at ? { status_time: Math.floor(Number(row.auto_disabled_at) / 1000) } : {}),
        })
      : "",
  };
}

const DEMO_OWNED = ["agno 主渠道", "兔子 Claude", "海狮 DeepSeek", "agno 备用", "兔子 Gemini", "海狮未同步"];

export async function ensureDemoGateway(ownerId: string): Promise<void> {
  const existing = await dbGet("SELECT id FROM gateways WHERE id = ?", [DEMO_ID]);
  const now = Date.now();
  if (!existing) {
    await dbRun(
      `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at)
       VALUES (?, ?, ?, '', '1', 1, ?, ?)`,
      [DEMO_ID, "演示网关", "https://demo.invalid", now, now],
    );
  }
  const count = await dbGet("SELECT COUNT(*) AS n FROM channels WHERE gateway_id = ?", [DEMO_ID]);
  if (Number(count?.n ?? 0) === 0) await seedDemoChannels(ownerId);
  await markDemoOwnership(ownerId);
}

async function seedDemoChannels(ownerId: string): Promise<void> {
  const { day } = shanghaiClock();
  const samples = [
    ["agno 主渠道", 1, "agno", 1, 1_200_000, 80_000, 42.5],
    ["兔子 Claude", 14, "兔子", 1, 860_000, 20_000, 18],
    ["海狮 DeepSeek", 43, "haishi", 1, 2_400_000, 150_000, 6.2],
    ["agno 备用", 3, "agno", 2, 300_000, 0, 0],
    ["兔子 Gemini", 24, "兔子", 3, 540_000, 12_000, 3.4],
    ["海狮未同步", 1, "haishi", 1, 90_000, 4_000, 1.1],
  ] as const;
  for (let index = 0; index < samples.length; index += 1) {
    const [name, type, group, status, used, today, balance] = samples[index]!;
    const id = crypto.randomUUID();
    const created = Date.now() - (samples.length - index) * 86_400_000;
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, base_url, models,
        model_mapping, test_model, remark, auto_ban, balance, used_quota, today_quota, upstream_created_at,
        created_at, updated_at, last_sync_at, sync_status, consecutive_failures, next_poll_at, demo_fail_left
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'gpt-4o-mini', '', 'gpt-4o-mini', '', 1, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, 0, ?)`,
      [id, DEMO_ID, index + 1, ownerId, name, type, group, status, balance, used, today, created, created, created, Date.now(), name === "海狮未同步" ? 1 : 0],
    );
    if (name === "海狮未同步") continue;
    const startUsed = used - today - 40_000 * 6;
    for (let back = 7; back >= 0; back -= 1) {
      const baselineDay = addDays(day, -back);
      const baseline = startUsed + (7 - back) * 40_000;
      if (name === "兔子 Gemini" && back === 0) continue;
      await dbRun(
        `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
         VALUES (?, ?, ?, ?, ?, 'exact', ?)`,
        [id, baselineDay, baseline, baseline, 0, Date.now()],
      );
    }
  }
  const billDay = addDays(day, -1);
  const baselineDay = day;
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, total_count, ok_count, failed_count)
     VALUES (?, ?, 'published', ?, ?, 6, 5, 1)
     ON CONFLICT(baseline_day) DO NOTHING`,
    [baselineDay, billDay, Date.now() - 60_000, Date.now() - 30_000],
  );
  const { publishBill } = await import("./billing-service");
  await publishBill(billDay, baselineDay);
}

async function markDemoOwnership(ownerId: string): Promise<void> {
  await dbRun("DELETE FROM channels WHERE gateway_id = ? AND name = ?", [DEMO_ID, "上游自建"]);
  const placeholders = DEMO_OWNED.map(() => "?").join(", ");
  const pending = await dbGet(
    `SELECT COUNT(*) AS n FROM channels WHERE gateway_id = ? AND name IN (${placeholders}) AND created_here = 0`,
    [DEMO_ID, ...DEMO_OWNED],
  );
  const gone = await dbGet("SELECT id FROM channels WHERE gateway_id = ? AND name = ?", [DEMO_ID, "已删除渠道"]);
  if (Number(pending?.n ?? 0) === 0 && gone) {
    await refreshDemoPresentation();
    return;
  }
  await dbRun(
    `UPDATE channels SET created_here = 1, creator_user_id = COALESCE(creator_user_id, ?) WHERE gateway_id = ? AND name IN (${placeholders})`,
    [ownerId, DEMO_ID, ...DEMO_OWNED],
  );
  await ensureDemoExtra(ownerId, "已删除渠道", 1, 1);
  await refreshDemoPresentation();
  await dbRun(
    `UPDATE channels SET create_baseline = (
       SELECT b.baseline FROM channel_baselines b WHERE b.channel_id = channels.id ORDER BY b.day ASC LIMIT 1
     ) WHERE gateway_id = ? AND created_here = 1 AND create_baseline IS NULL`,
    [DEMO_ID],
  );
  const { day } = shanghaiClock();
  const run = await dbGet("SELECT status FROM billing_runs WHERE baseline_day = ?", [day]);
  if (run?.status === "published") {
    const { publishBill } = await import("./billing-service");
    await publishBill(addDays(day, -1), day);
  }
}

async function refreshDemoPresentation(): Promise<void> {
  await dbRun("UPDATE channels SET models = 'gpt-4o-mini' WHERE gateway_id = ? AND models = ''", [DEMO_ID]);
  await dbRun(
    `UPDATE channels SET base_url = 'https://demo.invalid', other = '2025-04-01-preview'
     WHERE gateway_id = ? AND type = 3 AND (base_url = '' OR other = '')`,
    [DEMO_ID],
  );
  const stamped = new Date(Date.now() - 3_600_000).toISOString();
  await dbRun(
    `UPDATE channels SET auto_disable_reason = '上游返回 401',
       auto_disabled_at = COALESCE(auto_disabled_at, ?),
       auto_disable_history = CASE WHEN auto_disable_history IN ('', '[]') THEN ? ELSE auto_disable_history END
     WHERE gateway_id = ? AND name = '兔子 Gemini' AND status = 3 AND auto_disable_reason IN ('', 'autoDisabled')`,
    [Date.now() - 3_600_000, JSON.stringify([`${stamped} 上游返回 401`]), DEMO_ID],
  );
}

async function ensureDemoExtra(ownerId: string, name: string, createdHere: number, missing: number): Promise<void> {
  const existing = await dbGet("SELECT id FROM channels WHERE gateway_id = ? AND name = ?", [DEMO_ID, name]);
  if (existing) {
    await dbRun("UPDATE channels SET created_here = ?, upstream_missing = ?, creator_user_id = COALESCE(creator_user_id, ?) WHERE id = ?", [
      createdHere,
      missing,
      createdHere ? ownerId : null,
      existing.id,
    ]);
    return;
  }
  const max = await dbGet("SELECT COALESCE(MAX(upstream_id), 0) AS n FROM channels WHERE gateway_id = ?", [DEMO_ID]);
  const upstreamId = Number(max?.n ?? 0) + 1;
  const id = crypto.randomUUID();
  const { day } = shanghaiClock();
  const created = Date.now() - 2 * 86_400_000;
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, base_url, models,
      model_mapping, test_model, remark, auto_ban, balance, used_quota, today_quota, upstream_created_at,
      created_at, updated_at, last_sync_at, sync_status, consecutive_failures, next_poll_at, demo_fail_left,
      created_here, create_baseline, upstream_missing
    ) VALUES (?, ?, ?, ?, ?, 1, 'default', 1, '', 'gpt-4o-mini', '', '', '', 1, 1, 5000, 0, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
    [
      id,
      DEMO_ID,
      upstreamId,
      createdHere ? ownerId : null,
      name,
      created,
      created,
      created,
      Date.now(),
      missing ? "missing" : "ok",
      createdHere,
      createdHere ? 1000 : null,
      missing,
    ],
  );
  if (!createdHere) return;
  await dbRun(
    `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
     VALUES (?, ?, 1000, 1000, 0, 'create', ?), (?, ?, 5000, 5000, 0, 'exact', ?)`,
    [id, addDays(day, -1), Date.now(), id, day, Date.now()],
  );
}

export async function demoRequest(gatewayId: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const url = new URL(path, "https://demo.invalid");
  const method = (init.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/channel/" && method === "GET") return demoList(gatewayId, Number(url.searchParams.get("p") ?? 1));
  if (url.pathname === "/api/channel/" && method === "POST") return demoAdd(gatewayId, init.body);
  if (url.pathname === "/api/channel/" && method === "PUT") return demoUpdate(gatewayId, init.body);
  if (url.pathname === "/api/log/stat") {
    const channel = url.searchParams.get("channel");
    const tokenName = url.searchParams.get("token_name") ?? "";
    const start = Number(url.searchParams.get("start_timestamp") ?? 0);
    const end = Number(url.searchParams.get("end_timestamp") ?? 0);
    if (!channel) return demoGatewayStat(gatewayId, tokenName, start, end);
    return demoStat(gatewayId, Number(channel), tokenName, start, end);
  }
  const status = url.pathname.match(/^\/api\/channel\/(\d+)\/status$/);
  if (status && method === "POST") return demoStatus(gatewayId, Number(status[1]), init.body);
  if (url.pathname === "/api/channel/status/batch" && method === "POST") return demoStatusBatch(gatewayId, init.body);
  const test = url.pathname.match(/^\/api\/channel\/test\/(\d+)$/);
  if (test) return demoTest(gatewayId, Number(test[1]));
  const codex = url.pathname.match(/^\/api\/channel\/(\d+)\/codex\/refresh$/);
  if (codex && method === "POST") return demoCodexRefresh(gatewayId, Number(codex[1]));
  const one = url.pathname.match(/^\/api\/channel\/(\d+)$/);
  if (one && method === "GET") {
    const row = await dbGet("SELECT * FROM channels WHERE gateway_id = ? AND upstream_id = ?", [gatewayId, Number(one[1])]);
  if (!row || Number(row.upstream_missing) === 1) throw new UpstreamFailure("渠道不存在", false);
  return { success: true, data: rawChannel(row) };
  }
  throw new UpstreamFailure("演示网关没有这个接口", false);
}

async function demoList(gatewayId: string, page: number) {
  const rows = (await dbAll("SELECT * FROM channels WHERE gateway_id = ? AND upstream_missing = 0 ORDER BY upstream_id DESC", [gatewayId])) as Row[];
  const start = Math.max(0, (page - 1) * 20);
  return { success: true, data: { items: rows.slice(start, start + 20).map(rawChannel), total: rows.length } };
}

function channelColumns(channel: Record<string, unknown>) {
  return [
    String(channel.name ?? "未命名"),
    Number(channel.type ?? 1),
    String(channel.group ?? "default"),
    String(channel.base_url ?? ""),
    String(channel.models ?? ""),
    String(channel.model_mapping ?? ""),
    String(channel.test_model ?? ""),
    String(channel.remark ?? ""),
    Number(channel.auto_ban ?? 1) === 0 ? 0 : 1,
    Number(channel.priority ?? 0) || 0,
    Number(channel.weight ?? 0) || 0,
    String(channel.tag ?? ""),
    String(channel.other ?? ""),
    String(channel.status_code_mapping ?? ""),
    String(channel.param_override ?? ""),
    String(channel.header_override ?? ""),
    String(channel.setting ?? ""),
    String(channel.settings ?? "{}"),
    String(channel.openai_organization ?? ""),
  ];
}

async function demoAdd(gatewayId: string, body: BodyInit | null | undefined) {
  const payload = JSON.parse(String(body ?? "{}")) as { mode?: string; channel?: Record<string, unknown> };
  const channel = payload.channel ?? {};
  const keys = String(channel.key ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const mode = payload.mode ?? "single";
  const pieces = mode === "multi_to_single" ? [keys.join("\n")] : keys;
  const max = await dbGet("SELECT COALESCE(MAX(upstream_id), 0) AS n FROM channels WHERE gateway_id = ?", [gatewayId]);
  let next = Number(max?.n ?? 0);
  const now = Date.now();
  for (const key of pieces.length ? pieces : [""]) {
    if (!key) continue;
    next += 1;
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, base_url, models,
        model_mapping, test_model, remark, auto_ban, balance, used_quota, today_quota, upstream_created_at,
        created_at, updated_at, last_sync_at, sync_status, consecutive_failures, next_poll_at, demo_fail_left,
        priority, weight, tag, other, status_code_mapping, param_override, header_override, setting, settings, openai_organization
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 10, 0, 0, ?, ?, ?, ?, 'ok', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), gatewayId, next, ...channelColumns(channel), now, now, now, now],
    );
  }
  return { success: true, message: "" };
}

async function demoUpdate(gatewayId: string, body: BodyInit | null | undefined) {
  const channel = JSON.parse(String(body ?? "{}")) as Record<string, unknown>;
  if ("status" in channel) throw new UpstreamFailure("Invalid parameters", false);
  const columns = channelColumns(channel);
  await dbRun(
    `UPDATE channels SET name = ?, type = ?, group_name = ?, base_url = ?, models = ?, model_mapping = ?,
      test_model = ?, remark = ?, auto_ban = ?, priority = ?, weight = ?, tag = ?, other = ?,
      status_code_mapping = ?, param_override = ?, header_override = ?, setting = ?, settings = ?,
      openai_organization = ?, updated_at = ? WHERE gateway_id = ? AND upstream_id = ?`,
    [...columns, Date.now(), gatewayId, Number(channel.id)],
  );
  return { success: true, message: "" };
}

async function demoStat(gatewayId: string, upstreamId: number, tokenName: string, start: number, end: number) {
  const row = await dbGet("SELECT id, today_quota, demo_fail_left FROM channels WHERE gateway_id = ? AND upstream_id = ?", [
    gatewayId,
    upstreamId,
  ]);
  if (!row) throw new UpstreamFailure("渠道不存在", false);
  const left = Number(row.demo_fail_left ?? 0);
  if (left > 0 && !tokenName) {
    await dbRun("UPDATE channels SET demo_fail_left = ? WHERE gateway_id = ? AND upstream_id = ?", [left - 1, gatewayId, upstreamId]);
    throw new UpstreamFailure("演示限流", true, 0);
  }
  const tests = await dbGet(
    "SELECT COALESCE(SUM(quota), 0) AS n FROM test_runs WHERE channel_id = ? AND result = 'ok' AND created_at >= ? AND created_at < ?",
    [row.id, start * 1000, end * 1000 || Date.now() + 1000],
  );
  const testQuota = Number(tests?.n ?? 0);
  if (tokenName === "Model test" || tokenName === "模型测试") return { success: true, data: { quota: testQuota } };
  const startDay = shanghaiClock(new Date(start * 1000)).day;
  const closeDay = shanghaiClock(new Date((end + 1) * 1000)).day;
  if (closeDay > startDay) {
    const open = await dbGet("SELECT baseline FROM channel_baselines WHERE channel_id = ? AND day = ?", [row.id, startDay]);
    const close = await dbGet("SELECT baseline FROM channel_baselines WHERE channel_id = ? AND day = ?", [row.id, closeDay]);
    if (open && close) return { success: true, data: { quota: Number(close.baseline) - Number(open.baseline) + testQuota } };
  }
  return { success: true, data: { quota: Number(row.today_quota ?? 0) + testQuota } };
}

async function demoGatewayStat(gatewayId: string, tokenName: string, start: number, end: number) {
  const rows = (await dbAll("SELECT upstream_id FROM channels WHERE gateway_id = ? AND created_here = 1 AND upstream_missing = 0", [gatewayId])) as { upstream_id: number }[];
  let quota = 0;
  for (const row of rows) {
    const stat = (await demoStat(gatewayId, Number(row.upstream_id), tokenName, start, end)) as { data?: { quota?: number } };
    quota += Number(stat.data?.quota ?? 0);
  }
  return { success: true, data: { quota } };
}

async function demoCodexRefresh(gatewayId: string, upstreamId: number) {
  const row = await dbGet("SELECT id, type, name FROM channels WHERE gateway_id = ? AND upstream_id = ?", [gatewayId, upstreamId]);
  if (!row) throw new UpstreamFailure("渠道不存在", false);
  if (Number(row.type) !== 57) throw new UpstreamFailure("只有 Codex 渠道可以刷新凭证", false);
  return {
    success: true,
    message: "refreshed",
    data: { account_id: "acct_demo", email: "codex@demo.invalid", channel_id: upstreamId, channel_name: row.name, channel_type: 57 },
  };
}

async function demoTest(gatewayId: string, upstreamId: number) {
  const row = await dbGet("SELECT id, name, auto_disable_history FROM channels WHERE gateway_id = ? AND upstream_id = ?", [gatewayId, upstreamId]);
  if (!row) throw new UpstreamFailure("渠道不存在", false);
  if (String(row.name) === "兔子 Gemini") {
    let history: string[] = [];
    try {
      const parsed = JSON.parse(String(row.auto_disable_history ?? "[]")) as unknown;
      if (Array.isArray(parsed)) history = parsed.map((item) => String(item));
    } catch {
      history = [];
    }
    history.push(`${new Date().toISOString()} 上游返回 401`);
    const at = Date.now();
    await dbRun(
      "UPDATE channels SET status = 3, auto_disable_reason = ?, auto_disable_history = ?, auto_disabled_at = ?, updated_at = ? WHERE id = ?",
      ["上游返回 401", JSON.stringify(history.slice(-20)), at, at, row.id],
    );
    return { success: false, message: "401", time: 0.32 };
  }
  return { success: true, message: "", time: 0.32 };
}

async function demoStatus(gatewayId: string, upstreamId: number, body: BodyInit | null | undefined) {
  const payload = JSON.parse(String(body ?? "{}")) as { status?: number };
  await dbRun("UPDATE channels SET status = ?, updated_at = ? WHERE gateway_id = ? AND upstream_id = ?", [
    Number(payload.status) === 1 ? 1 : 2,
    Date.now(),
    gatewayId,
    upstreamId,
  ]);
  return { success: true };
}

async function demoStatusBatch(gatewayId: string, body: BodyInit | null | undefined) {
  const payload = JSON.parse(String(body ?? "{}")) as { ids?: number[]; status?: number };
  for (const id of payload.ids ?? []) {
    await dbRun("UPDATE channels SET status = ?, updated_at = ? WHERE gateway_id = ? AND upstream_id = ?", [
      Number(payload.status) === 1 ? 1 : 2,
      Date.now(),
      gatewayId,
      id,
    ]);
  }
  return { success: true };
}
