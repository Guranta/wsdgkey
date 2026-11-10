import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { billingPickerDay, billingRequestQuery, columnSummary, columnTotalText, disabledGatewayAmountText, grandTotalLabel, groupSubtotalText, readingAmountText, rollupReadingValues, trendHoverTitle, trendWindowAllZero } from "./billing-query.ts";
import { formatUsd } from "./format.ts";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-console-billing-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

test("a picked bill day is sent, and the picker shows the loaded day", () => {
  assert.equal(billingRequestQuery({ day: "2026-11-08" }), "?day=2026-11-08");
  assert.equal(billingRequestQuery({ day: " 2026-11-07 ", unsynced: true, supplier: "sup" }), "?day=2026-11-07&unsynced=1&supplier=sup");
  assert.equal(billingRequestQuery({ day: "" }), "");
  assert.equal(billingRequestQuery({ day: null }), "");
  assert.equal(billingPickerDay(null, { billDay: "2026-11-08", requestedDay: null }), "2026-11-08");
  assert.notEqual(billingPickerDay(null, { billDay: "2026-11-08", requestedDay: null }), "2026-11-10");
  assert.equal(billingPickerDay("2026-11-01", { billDay: "2026-11-08", requestedDay: null }), "2026-11-01");
  assert.equal(billingPickerDay(null, { billDay: null, requestedDay: "2026-11-09" }), "2026-11-09");
  const money = (value: number) => `$${value}`;
  assert.equal(disabledGatewayAmountText({ channels: 2, consumption: null, complete: false }, money, "缺数据", "不完整"), "缺数据");
  assert.equal(disabledGatewayAmountText({ channels: 2, consumption: 40, complete: false }, money, "缺数据", "不完整"), "$40 · 不完整");
  assert.equal(disabledGatewayAmountText({ channels: 2, consumption: 30, complete: true }, money, "缺数据", "不完整"), "$30");
  assert.notEqual(disabledGatewayAmountText({ channels: 1, consumption: null, complete: false }, () => "$0.00", "缺数据", "不完整"), "$0.00");
  const zhNote = (readings: number, channels: number) => `不完整（${readings}/${channels} 有读数）`;
  const enNote = (readings: number, channels: number) => `incomplete (${readings}/${channels} with readings)`;
  const zeros = [
    { kind: "amount", consumption: 0 },
    { kind: "amount", consumption: 0 },
    { kind: "amount", consumption: 0 },
    { kind: "amount", consumption: 0 },
  ];
  const missing = Array.from({ length: 631 }, () => ({ kind: "unsynced", consumption: null }));
  const partialZero = rollupReadingValues([...zeros, ...missing]);
  assert.equal(partialZero.readings, 4);
  assert.equal(partialZero.channels, 635);
  assert.equal(partialZero.consumption, 0);
  assert.equal(partialZero.complete, false);
  assert.equal(groupSubtotalText([...zeros, ...missing], () => "$0.00", "缺数据", zhNote), "$0.00 · 不完整（4/635 有读数）");
  assert.equal(readingAmountText(partialZero, () => "$0.00", "缺数据", zhNote), "$0.00 · 不完整（4/635 有读数）");
  assert.equal(readingAmountText(partialZero, (value) => formatUsd(value, "zh-CN"), "缺数据", zhNote), `${formatUsd(0, "zh-CN")} · 不完整（4/635 有读数）`);
  assert.equal(groupSubtotalText([...zeros, ...missing], () => "$0.00", "Missing data", enNote), "$0.00 · incomplete (4/635 with readings)");
  const onlyMissing = rollupReadingValues([
    { kind: "unsynced", consumption: null },
    { kind: "unsynced", consumption: 0 },
    { kind: "no-baseline", consumption: null },
  ]);
  assert.equal(onlyMissing.readings, 0);
  assert.equal(onlyMissing.consumption, null);
  assert.equal(readingAmountText(onlyMissing, () => "$0.00", "缺数据", zhNote), "缺数据");
  assert.notEqual(readingAmountText(onlyMissing, () => "$0.00", "缺数据", zhNote), "$0.00");
  assert.equal(rollupReadingValues([{ kind: "amount", consumption: Number.NaN }]).readings, 0);
  const zh = JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url), "utf8")) as {
    channels: { confirmedAt: string; pendingConfirm: string };
    billing: { incompleteReadings: string; unpublishedHint: string; disabledGatewayExcludedCount: string; trendAllZero: string; unpublishedTrend: string };
  };
  const en = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8")) as {
    channels: { confirmedAt: string; pendingConfirm: string };
    billing: { incompleteReadings: string; unpublishedHint: string; disabledGatewayExcludedCount: string; trendAllZero: string; unpublishedTrend: string };
  };
  assert.equal(zh.billing.incompleteReadings, "不完整（{readings}/{channels} 有读数）");
  assert.equal(en.billing.incompleteReadings, "incomplete ({readings}/{channels} with readings)");
  assert.equal(zh.billing.unpublishedHint, "{day} 尚未发布，下面的数字还会变，06:00 发布后固定");
  assert.equal(en.billing.unpublishedHint, "The {day} bill is not published yet. Figures may still change and are fixed at 06:00.");
  assert.equal(grandTotalLabel("dedup", true, "合计", "不完整"), "合计");
  assert.equal(grandTotalLabel("dedup", true, "Total", "Incomplete"), "Total");
  assert.equal(grandTotalLabel("legacy", true, "合计", "不完整"), "合计 · 不完整");
  assert.equal(grandTotalLabel("legacy", false, "合计", "不完整"), "合计");
  assert.equal(grandTotalLabel(undefined, true, "合计", "不完整"), "合计 · 不完整");
  assert.equal(trendWindowAllZero([{ value: 0 }, { value: 0, missing: false }]), true);
  assert.equal(trendWindowAllZero([{ value: 0 }, { value: null, missing: true }]), false);
  assert.equal(trendWindowAllZero([{ value: null, missing: true }]), false);
  assert.equal(trendWindowAllZero([{ value: 0, partial: true }]), false);
  assert.equal(trendWindowAllZero([]), false);
  const legacyPartial = columnSummary([0, null]);
  assert.equal(columnTotalText(legacyPartial, (value) => formatUsd(value, "zh-CN"), "缺数据", "不完整"), "$0.00 · 不完整");
  assert.equal(columnTotalText(columnSummary([34_860_000, 0]), (value) => formatUsd(value, "zh-CN"), "缺数据", "不完整"), "$69.72");
  assert.equal(columnTotalText(columnSummary([null, null]), () => "$0.00", "缺数据", "不完整"), "缺数据");
  assert.equal(
    trendHoverTitle({ day: "2026-11-09", legacy: true, value: 0, missing: false, partial: true }, (value) => formatUsd(value, "zh-CN"), "缺数据", "不完整", zhNote),
    "11-09 · $0.00 · 不完整",
  );
  assert.equal(
    trendHoverTitle({ day: "2026-11-10", value: 0, missing: false, channels: 635, readings: 4, complete: false }, (value) => formatUsd(value, "zh-CN"), "缺数据", "不完整", zhNote),
    "11-10 · $0.00 · 不完整（4/635 有读数）",
  );
  assert.equal(
    trendHoverTitle({ day: "2026-11-08", legacy: true, value: null, missing: true }, (value) => formatUsd(value, "zh-CN"), "缺数据", "不完整", zhNote),
    "11-08 · 缺数据",
  );
  assert.equal(
    trendHoverTitle(
      { day: "2026-11-07", label: "11-05–11-07", span: true, legacy: true, value: 500, missing: false, partial: false },
      (value) => `$${value}`,
      "缺数据",
      "不完整",
      zhNote,
    ),
    "11-05–11-07 · $500",
  );
  assert.equal(zh.billing.disabledGatewayExcludedCount, "已停用网关（不计入合计）· {count} 个渠道");
  assert.equal(en.billing.disabledGatewayExcludedCount, "Disabled gateways (excluded from total) · {count} channels");
  assert.equal(zh.billing.trendAllZero, "这段时间每天都是 $0");
  assert.equal(en.billing.trendAllZero, "Every day in this period is $0");
  assert.equal(zh.billing.unpublishedTrend, "未发布");
  assert.equal(en.billing.unpublishedTrend, "Unpublished");
  assert.equal(zh.channels.confirmedAt, "最近确认于 {when}");
  assert.equal(zh.channels.pendingConfirm, "待确认");
  assert.equal(en.channels.confirmedAt, "Last confirmed {when}");
  assert.equal(en.channels.pendingConfirm, "Pending confirmation");
});

async function freshDb() {
  const { resetDatabaseForTests, dbGet, dbRun, dbAll, dbTransaction, ensureReady } = await import("./db.ts");
  const { clearPublishedDayCache } = await import("./billing-service.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  clearPublishedDayCache();
  resetDatabaseForTests();
  await ensureReady();
  for (const table of ["billing_membership", "billing_rows", "billing_runs", "billing_attempts", "channel_bindings", "channels", "gateways", "recon_periods"]) {
    await dbRun(`DELETE FROM ${table}`);
  }
  return { dbGet, dbRun, dbAll, dbTransaction };
}

test("overview counts do not let a missing row count as pull, throttle, or unsynced", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { queryChannels } = await import("./channel-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('gw-on', 'on', 'https://on.example', '', '1', 0, ?, ?, 0),
            ('gw-off', 'off', 'https://off.example', '', '1', 0, ?, ?, 1)`,
    [now, now, now, now],
  );
  const insert = async (id: string, gatewayId: string, upstream: number, status: number, missing: number, sync: string, failures: number) => {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at,
        created_here, upstream_missing, sync_status, consecutive_failures
      ) VALUES (?, ?, ?, ?, ?, 1, 'pool', ?, ?, ?, 1, ?, ?, ?)`,
      [id, gatewayId, upstream, admin.id, id, status, now, now, missing, sync, failures],
    );
  };
  await insert("miss-auto", "gw-on", 1, 3, 1, "missing", 5);
  await insert("miss-live", "gw-on", 2, 1, 1, "failed", 5);
  await insert("auto", "gw-on", 3, 3, 0, "ok", 0);
  await insert("pull", "gw-on", 4, 1, 0, "failed", 4);
  await insert("ok", "gw-on", 5, 1, 0, "ok", 0);
  await insert("paused", "gw-off", 6, 3, 1, "failed", 5);

  const listed = await queryChannels(admin, new URLSearchParams());
  assert.equal(listed.stats.upstreamMissing, 2);
  assert.equal(listed.stats.autoDisabled, 1);
  assert.equal(listed.stats.pullFailed, 1);
  assert.equal(listed.stats.anomaly, listed.stats.autoDisabled + listed.stats.pullFailed + listed.stats.upstreamMissing);
  assert.equal(listed.stats.queue.throttled, 1);
  assert.equal(listed.stats.queue.unsynced, 0);
  assert.equal(listed.stats.pausedGateways, 1);
});

test("a channel that is missing and auto-disabled counts only as missing", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { queryChannels } = await import("./channel-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('gw-on', 'on', 'https://on.example', '', '1', 0, ?, ?, 0),
            ('gw-off', 'off', 'https://off.example', '', '1', 0, ?, ?, 1)`,
    [now, now, now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at,
      created_here, upstream_missing, sync_status
    ) VALUES ('both', 'gw-on', 1, ?, 'both', 1, 'pool', 3, ?, ?, 1, 1, 'failed'),
             ('paused', 'gw-off', 2, ?, 'paused', 1, 'pool', 3, ?, ?, 1, 1, 'failed')`,
    [admin.id, now, now, admin.id, now, now],
  );
  const listed = await queryChannels(admin, new URLSearchParams());
  assert.equal(listed.stats.upstreamMissing, 1);
  assert.equal(listed.stats.autoDisabled, 0);
  assert.equal(listed.stats.pullFailed, 0);
  assert.equal(listed.stats.anomaly, 1);
  assert.equal(listed.stats.pausedGateways, 1);
});

test("an unpublished day does not fall back, and the default view is the latest published day", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('gw', 'on', 'https://on.example', '', '1', 0, ?, ?, 0)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, used_quota)
     VALUES ('ch', 'gw', 1, ?, 'ch', 1, 'pool', 1, ?, ?, 1, 0)`,
    [admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-08', '2026-11-07', 'published', ?, ?),
            ('2026-11-09', '2026-11-08', 'published', ?, ?),
            ('2026-11-10', '2026-11-09', 'collecting', ?, NULL)`,
    [now, now, now, now, now],
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
     VALUES ('old', '2026-11-07', 'ch', '2026-11-07', '2026-11-07', 1, 'amount', 10),
            ('latest', '2026-11-08', 'ch', '2026-11-08', '2026-11-08', 1, 'amount', 20),
            ('open', '2026-11-09', 'ch', '2026-11-09', '2026-11-09', 1, 'amount', 999)`,
  );

  const opened = await billingView(admin);
  assert.equal(opened.publication, "latest");
  assert.equal(opened.billDay, "2026-11-08");
  assert.equal(opened.requestedDay, null);
  assert.equal(opened.totalConsumption, 20);

  const collecting = await billingView(admin, { day: "2026-11-09" });
  assert.equal(collecting.publication, "unpublished");
  assert.equal(collecting.aggregation, "dedup");
  assert.equal(collecting.billDay, "2026-11-09");
  assert.equal(collecting.requestedDay, "2026-11-09");
  assert.equal(collecting.totalConsumption, 999);
  assert.equal(collecting.rows.length, 1);
  assert.equal(collecting.rows[0]?.id, "ch");
  assert.notEqual(collecting.billDay, "2026-11-08");
  assert.notEqual(collecting.totalConsumption, 20);

  const missing = await billingView(admin, { day: "2026-11-01" });
  assert.equal(missing.publication, "unpublished");
  assert.equal(missing.billDay, null);
  assert.equal(missing.rows.length, 0);
  assert.equal(missing.totalConsumption, 0);

  const older = await billingView(admin, { day: "2026-11-07" });
  assert.equal(older.publication, "published");
  assert.equal(older.billDay, "2026-11-07");
  assert.equal(older.totalConsumption, 10);
});

test("disabled gateways are left out of totals and the same upstream id is counted once", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  const gateways: [string, string, number][] = [
    ["gw-on", "https://same.example", 0],
    ["gw-on-2", "https://same.example/", 0],
    ["gw-off", "https://same.example/v1", 1],
    ["gw-other", "https://other.example", 0],
  ];
  for (const [id, base, disabled] of gateways) {
    await dbRun(
      `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
       VALUES (?, ?, ?, '', '1', 0, ?, ?, ?)`,
      [id, id, base, now, now, disabled],
    );
  }
  const channel = async (
    id: string,
    gatewayId: string,
    upstream: number,
    group: string,
    type: number,
    used: number,
  ) => {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, used_quota
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`,
      [id, gatewayId, upstream, admin.id, id, type, group, now, now, used],
    );
  };
  await channel("ch-on", "gw-on", 10, "alpha", 1, 500_000);
  await channel("ch-off-dup", "gw-off", 10, "beta", 14, 200_000);
  await channel("ch-off-only", "gw-off", 11, "gamma", 1, 100_000);
  await channel("ch-other", "gw-other", 10, "alpha", 1, 0);
  await channel("dup-a", "gw-on", 77, "alpha", 1, 0);
  await channel("dup-b", "gw-on-2", 77, "zeta", 1, 0);
  const amounts: [string, string, number][] = [
    ["ch-on", "ch-on", 100],
    ["ch-off-dup", "ch-off-dup", 40],
    ["ch-off-only", "ch-off-only", 70],
    ["ch-other", "ch-other", 25],
    ["dup-a", "dup-a", 80],
    ["dup-b", "dup-b", 15],
  ];
  for (const [id, channelId, consumption] of amounts) {
    await dbRun(
      `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
       VALUES (?, '2026-11-08', ?, '2026-11-08', '2026-11-08', 1, 'amount', ?)`,
      [id, channelId, consumption],
    );
  }
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, aggregation)
     VALUES ('2026-11-09', '2026-11-08', 'published', ?, ?, 'dedup')`,
    [now, now],
  );

  const bill = await billingView(admin);
  assert.equal(bill.totalConsumption, 205);
  assert.equal(bill.disabledGateway.consumption, 70);
  assert.equal(bill.disabledGateway.channels, 1);
  assert.equal(bill.disabledGateway.complete, true);
  assert.equal(bill.usedUsd, 1);
  assert.deepEqual(
    bill.rows.map((row) => row.id).sort(),
    ["ch-on", "ch-other", "dup-a"],
  );
  assert.equal(bill.byGroup.find((item) => item.name === "alpha")?.value, 205);
  assert.equal(bill.byGroup.some((item) => item.name === "beta" || item.name === "gamma" || item.name === "zeta"), false);
  assert.equal(bill.byType.find((item) => item.name === "OpenAI")?.value, 205);
  assert.equal(bill.byType.some((item) => item.name === "Anthropic"), false);
  assert.equal(bill.bySupplier.reduce((sum, item) => sum + item.value, 0), 205);
  assert.equal(bill.byGroup.reduce((sum, item) => sum + item.value, 0), 205);
  assert.equal(bill.byType.reduce((sum, item) => sum + item.value, 0), 205);
});

test("a disabled gateway row is missing, incomplete, or a full amount", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('gw-off', 'off', 'https://paused.example', '', '1', 0, ?, ?, 1)`,
    [now, now],
  );
  const channel = async (id: string, upstream: number) => {
    await dbRun(
      `INSERT INTO channels (id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here)
       VALUES (?, 'gw-off', ?, ?, ?, 1, 'pool', 1, ?, ?, 1)`,
      [id, upstream, admin.id, id, now, now],
    );
  };
  for (const [id, upstream] of [
    ["none-a", 1],
    ["none-b", 2],
    ["part-a", 3],
    ["part-b", 4],
    ["all-a", 5],
    ["all-b", 6],
  ] as const) {
    await channel(id, upstream);
  }
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
     VALUES ('n1', '2026-11-05', 'none-a', '2026-11-05', '2026-11-05', 1, 'unsynced', NULL),
            ('n2', '2026-11-05', 'none-b', '2026-11-05', '2026-11-05', 1, 'unsynced', NULL),
            ('p1', '2026-11-06', 'part-a', '2026-11-06', '2026-11-06', 1, 'amount', 40),
            ('p2', '2026-11-06', 'part-b', '2026-11-06', '2026-11-06', 1, 'unsynced', NULL),
            ('a1', '2026-11-07', 'all-a', '2026-11-07', '2026-11-07', 1, 'amount', 10),
            ('a2', '2026-11-07', 'all-b', '2026-11-07', '2026-11-07', 1, 'amount', 20)`,
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, aggregation)
     VALUES ('2026-11-06', '2026-11-05', 'published', ?, ?, 'dedup'),
            ('2026-11-07', '2026-11-06', 'published', ?, ?, 'dedup'),
            ('2026-11-08', '2026-11-07', 'published', ?, ?, 'dedup')`,
    [now, now, now, now, now, now],
  );

  const zhNote = (readings: number, channels: number) => `不完整（${readings}/${channels} 有读数）`;
  const none = await billingView(admin, { day: "2026-11-05" });
  assert.equal(none.disabledGateway.channels, 2);
  assert.equal(none.disabledGateway.readings, 0);
  assert.equal(none.disabledGateway.consumption, null);
  assert.equal(none.disabledGateway.complete, false);
  assert.equal(none.totalConsumption, 0);
  assert.equal(disabledGatewayAmountText(none.disabledGateway, () => "$0.00", "缺数据", "不完整"), "缺数据");
  assert.equal(readingAmountText(none.disabledGateway, () => "$0.00", "缺数据", zhNote), "缺数据");

  const partial = await billingView(admin, { day: "2026-11-06" });
  assert.equal(partial.disabledGateway.channels, 2);
  assert.equal(partial.disabledGateway.readings, 1);
  assert.equal(partial.disabledGateway.consumption, 40);
  assert.equal(partial.disabledGateway.complete, false);
  assert.equal(disabledGatewayAmountText(partial.disabledGateway, (value) => String(value), "缺数据", "不完整"), "40 · 不完整");
  assert.equal(readingAmountText(partial.disabledGateway, (value) => String(value), "缺数据", zhNote), "40 · 不完整（1/2 有读数）");

  const all = await billingView(admin, { day: "2026-11-07" });
  assert.equal(all.disabledGateway.channels, 2);
  assert.equal(all.disabledGateway.readings, 2);
  assert.equal(all.disabledGateway.consumption, 30);
  assert.equal(all.disabledGateway.complete, true);
  assert.equal(disabledGatewayAmountText(all.disabledGateway, (value) => String(value), "缺数据", "不完整"), "30");
  assert.equal(readingAmountText(all.disabledGateway, (value) => String(value), "缺数据", zhNote), "30");
});

test("确认于 is written only when a complete list sweep confirms the channel is absent", async () => {
  const { dbGet, dbRun } = await freshDb();
  const { resetListSweepForTests, syncGatewayPage } = await import("./channel-service.ts");
  const { createGateway } = await import("./gateways.ts");
  let mode: "bare" | "short" | "full" | "error" = "bare";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    if (url.pathname === "/api/channel/" && req.method === "GET") {
      if (mode === "error") {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: "rejected" }));
        return;
      }
      const item = { id: 1, name: "live", type: 1, status: 1 };
      const data = mode === "bare" ? { items: [item] } : mode === "short" ? { items: [item], total: 5 } : { items: [item], total: 1 };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, message: "missing" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const gateway = await createGateway({
      name: "sweep",
      baseUrl: `http://127.0.0.1:${port}`,
      adminUserId: "1",
      token: "nap-local-test",
    });
    const now = Date.now();
    await dbRun(
      `INSERT INTO channels (id, gateway_id, upstream_id, name, type, group_name, status, created_at, updated_at, created_here, upstream_missing, sync_status)
       VALUES ('gone', ?, 9, 'gone', 1, 'pool', 2, ?, ?, 1, 0, 'ok'),
              ('live', ?, 1, 'live', 1, 'pool', 1, ?, ?, 1, 0, 'ok')`,
      [gateway.id, now, now, gateway.id, now, now],
    );
    const gone = async () =>
      (await dbGet("SELECT status, upstream_missing, missing_confirmed_at FROM channels WHERE id = 'gone'")) as
        | { status: number; upstream_missing: number; missing_confirmed_at: number | null }
        | undefined;

    resetListSweepForTests();
    mode = "bare";
    const bare = await syncGatewayPage(gateway.id, 1);
    assert.equal(bare.aborted, true);
    assert.equal((await gone())?.missing_confirmed_at ?? null, null);
    assert.equal(Number((await gone())?.upstream_missing), 0);
    assert.equal(Number((await gone())?.status), 2);

    resetListSweepForTests();
    mode = "short";
    const short = await syncGatewayPage(gateway.id, 1);
    assert.equal(short.aborted, true);
    assert.equal((await gone())?.missing_confirmed_at ?? null, null);
    assert.equal(Number((await gone())?.status), 2);

    resetListSweepForTests();
    mode = "full";
    const full = await syncGatewayPage(gateway.id, 1);
    assert.equal(full.aborted, false);
    const confirmed = await gone();
    assert.ok(confirmed);
    assert.equal(Number(confirmed.upstream_missing), 1);
    assert.equal(Number(confirmed.status), 2);
    assert.ok(Number(confirmed.missing_confirmed_at) > 0);
    const live = await dbGet("SELECT upstream_missing, missing_confirmed_at FROM channels WHERE id = 'live'");
    assert.equal(Number(live?.upstream_missing), 0);
    assert.equal(live?.missing_confirmed_at ?? null, null);
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM channels WHERE gateway_id = ?", [gateway.id]))?.n), 2);

    await dbRun("UPDATE channels SET missing_confirmed_at = 111 WHERE id = 'gone'");
    resetListSweepForTests();
    mode = "error";
    const failed = await syncGatewayPage(gateway.id, 1);
    assert.equal(failed.aborted, true);
    assert.equal(Number((await gone())?.missing_confirmed_at), 111);
    assert.equal(Number((await gone())?.status), 2);
    assert.equal(Number((await gone())?.upstream_missing), 1);

    resetListSweepForTests();
    mode = "short";
    await syncGatewayPage(gateway.id, 1);
    assert.equal(Number((await gone())?.missing_confirmed_at), 111);

    resetListSweepForTests();
    mode = "full";
    await syncGatewayPage(gateway.id, 1);
    const again = Number((await gone())?.missing_confirmed_at);
    assert.ok(again > 111);
    assert.equal(Number((await gone())?.status), 2);
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM channels WHERE id = 'gone'"))?.n), 1);
  } finally {
    server.close();
  }
});

type FixtureRow = {
  id: string;
  gateway: string;
  upstream: number;
  type: number;
  group: string;
  typeName: string;
  consumption: number;
  used: number;
};

/** Stored rows, merged the way commit 5721e72 did: every row, no dedup, no disabled split. */
function legacyPublished(rows: FixtureRow[]) {
  const counted = rows.filter((row) => row.consumption !== null && row.consumption !== undefined);
  const total = counted.reduce((sum, row) => sum + row.consumption, 0);
  const channelCount = (key: "group" | "typeName") => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + 1);
    return map;
  };
  const sums = (key: "group" | "typeName") => {
    const map = new Map<string, number>();
    for (const row of counted) map.set(row[key], (map.get(row[key]) ?? 0) + row.consumption);
    return map;
  };
  return {
    ids: rows.map((row) => row.id).sort(),
    total,
    used: rows.reduce((sum, row) => sum + row.used, 0),
    groups: channelCount("group"),
    groupSums: sums("group"),
    types: channelCount("typeName"),
    typeSums: sums("typeName"),
  };
}

const DUPLICATE_BILL: FixtureRow[] = [
  { id: "v-on", gateway: "gw-on", upstream: 10, type: 41, group: "vertex", typeName: "Vertex AI", consumption: 100, used: 500_000 },
  { id: "v-off-dup", gateway: "gw-off", upstream: 10, type: 1, group: "openai", typeName: "OpenAI", consumption: 40, used: 200_000 },
  { id: "a-off", gateway: "gw-paused", upstream: 11, type: 14, group: "anthropic", typeName: "Anthropic", consumption: 70, used: 100_000 },
  { id: "aws-on", gateway: "gw-on", upstream: 12, type: 33, group: "aws", typeName: "AWS", consumption: 15, used: 0 },
  { id: "g-other", gateway: "gw-other", upstream: 10, type: 24, group: "gemini", typeName: "Gemini", consumption: 25, used: 0 },
  { id: "g-dup-a", gateway: "gw-on-2", upstream: 77, type: 24, group: "gemini", typeName: "Gemini", consumption: 80, used: 0 },
  { id: "g-dup-b", gateway: "gw-on", upstream: 77, type: 1, group: "openai", typeName: "OpenAI", consumption: 15, used: 0 },
];

async function seedDuplicateGateways(
  dbRun: (sql: string, params?: unknown[]) => Promise<void>,
  now: number,
) {
  const gateways: [string, string, number][] = [
    ["gw-on", "https://same.example", 0],
    ["gw-on-2", "https://same.example/", 0],
    ["gw-off", "https://same.example/v1", 1],
    ["gw-paused", "https://paused.example", 1],
    ["gw-other", "https://other.example", 0],
  ];
  for (const [id, base, disabled] of gateways) {
    await dbRun(
      `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
       VALUES (?, ?, ?, '', '1', 0, ?, ?, ?)`,
      [id, id, base, now, now, disabled],
    );
  }
}

async function seedDuplicateChannels(
  dbRun: (sql: string, params?: unknown[]) => Promise<void>,
  adminId: string,
  now: number,
  billDay: string,
) {
  for (const row of DUPLICATE_BILL) {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, used_quota
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`,
      [row.id, row.gateway, row.upstream, adminId, row.id, row.type, row.group, now, now, row.used],
    );
    await dbRun(
      `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
       VALUES (?, ?, ?, ?, ?, 1, 'amount', ?)`,
      [`${billDay}:${row.id}`, billDay, row.id, billDay, billDay, row.consumption],
    );
  }
}

test("a published bill day renders the stored rows with no dedup and no disabled split", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await seedDuplicateGateways(dbRun, now);
  await seedDuplicateChannels(dbRun, admin.id, now, "2026-11-09");
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-10', '2026-11-09', 'published', ?, ?)`,
    [now, now],
  );
  const expected = legacyPublished(DUPLICATE_BILL);
  const bill = await billingView(admin, { day: "2026-11-09" });
  assert.notEqual(bill.publication, "unpublished");
  assert.equal(bill.aggregation, "legacy");
  assert.ok(bill.publishedAt);
  assert.equal(bill.disabledGateway.channels, 0);
  assert.deepEqual(bill.rows.map((row) => row.id).sort(), expected.ids);
  assert.deepEqual(
    bill.rows.map((row) => [row.id, row.consumption, row.group, row.typeName]).sort(),
    DUPLICATE_BILL.map((row) => [row.id, row.consumption, row.group, row.typeName]).sort(),
  );
  assert.equal(bill.totalConsumption, expected.total);
  assert.equal(bill.totalConsumption, 345);
  assert.equal(bill.usedUsd, expected.used / 500_000);
  const rowGroups = new Map<string, number>();
  const rowTypes = new Map<string, number>();
  for (const row of bill.rows) {
    rowGroups.set(row.group, (rowGroups.get(row.group) ?? 0) + 1);
    rowTypes.set(row.typeName, (rowTypes.get(row.typeName) ?? 0) + 1);
  }
  for (const [name, count] of expected.groups) {
    assert.equal(rowGroups.get(name), count);
    const slice = bill.byGroup.find((item) => item.name === name);
    assert.equal(slice?.channels, count);
    assert.equal(slice?.readings, count);
    assert.equal(slice?.value, expected.groupSums.get(name));
  }
  for (const [name, count] of expected.types) {
    assert.equal(rowTypes.get(name), count);
    const slice = bill.byType.find((item) => item.name === name);
    assert.equal(slice?.channels, count);
    assert.equal(slice?.value, expected.typeSums.get(name));
  }
  assert.equal(bill.byGroup.reduce((sum, item) => sum + item.value, 0), expected.total);
  assert.equal(bill.byType.reduce((sum, item) => sum + item.value, 0), expected.total);
  assert.equal(bill.byType.find((item) => item.name === "Vertex AI")?.channels, 1);
  assert.equal(bill.byType.find((item) => item.name === "OpenAI")?.channels, 2);
  assert.ok(bill.byType.some((item) => item.name === "Anthropic"));
  assert.ok(bill.byType.some((item) => item.name === "AWS"));
  assert.ok(bill.byType.some((item) => item.name === "Gemini"));
});

test("an unpublished bill day still dedups and splits disabled gateways", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await seedDuplicateGateways(dbRun, now);
  await seedDuplicateChannels(dbRun, admin.id, now, "2026-11-10");
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-11', '2026-11-10', 'collecting', ?, NULL)`,
    [now],
  );
  const bill = await billingView(admin, { day: "2026-11-10" });
  assert.equal(bill.publication, "unpublished");
  assert.equal(bill.aggregation, "dedup");
  assert.deepEqual(bill.rows.map((row) => row.id).sort(), ["aws-on", "g-dup-a", "g-other", "v-on"]);
  assert.equal(bill.rows.some((row) => row.id === "v-off-dup" || row.id === "a-off" || row.id === "g-dup-b"), false);
  assert.equal(bill.totalConsumption, 220);
  assert.equal(bill.disabledGateway.channels, 1);
  assert.equal(bill.disabledGateway.readings, 1);
  assert.equal(bill.disabledGateway.consumption, 70);
  assert.equal(bill.disabledGateway.complete, true);
  assert.equal(bill.byGroup.find((item) => item.name === "vertex")?.value, 100);
  assert.equal(bill.byGroup.find((item) => item.name === "gemini")?.value, 105);
  assert.equal(bill.byGroup.find((item) => item.name === "gemini")?.channels, 2);
  assert.equal(bill.byGroup.some((item) => item.name === "openai" || item.name === "anthropic"), false);
  assert.equal(bill.byType.find((item) => item.name === "Vertex AI")?.channels, 1);
  assert.equal(bill.byType.find((item) => item.name === "Vertex AI")?.value, 100);
  assert.equal(bill.byType.some((item) => item.name === "OpenAI" || item.name === "Anthropic"), false);
  assert.equal(bill.byGroup.reduce((sum, item) => sum + item.value, 0), 220);
  assert.equal(bill.byType.reduce((sum, item) => sum + item.value, 0), 220);
  assert.notEqual(bill.totalConsumption, legacyPublished(DUPLICATE_BILL).total);
});

test("partial readings count a real zero and missing rows stay missing", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('gw-on', 'on', 'https://on.example', '', '1', 0, ?, ?, 0),
            ('gw-off', 'off', 'https://off.example', '', '1', 0, ?, ?, 1)`,
    [now, now, now, now],
  );
  const insert = async (id: string, gatewayId: string, upstream: number, type: number, group: string, kind: string, consumption: number | null) => {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
      [id, gatewayId, upstream, admin.id, id, type, group, now, now],
    );
    await dbRun(
      `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
       VALUES (?, '2026-11-10', ?, '2026-11-10', '2026-11-10', 1, ?, ?)`,
      [id, id, kind, consumption],
    );
  };
  for (let index = 0; index < 635; index += 1) {
    const read = index < 4;
    await insert(`v-${index}`, "gw-on", index + 1, 41, "vertex", read ? "amount" : "unsynced", read ? 0 : null);
  }
  for (let index = 0; index < 3; index += 1) {
    await insert(`miss-${index}`, "gw-on", 1000 + index, 1, "openai", "unsynced", null);
  }
  for (let index = 0; index < 2; index += 1) {
    await insert(`off-${index}`, "gw-off", 2000 + index, 14, "paused", "unsynced", null);
  }
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-11', '2026-11-10', 'collecting', ?, NULL)`,
    [now],
  );
  const bill = await billingView(admin, { day: "2026-11-10" });
  const zhNote = (readings: number, channels: number) => `不完整（${readings}/${channels} 有读数）`;
  const vertex = bill.byType.find((item) => item.name === "Vertex AI");
  assert.ok(vertex);
  assert.equal(vertex.channels, 635);
  assert.equal(vertex.readings, 4);
  assert.equal(vertex.consumption, 0);
  assert.equal(vertex.complete, false);
  assert.equal(readingAmountText(vertex, () => "$0.00", "缺数据", zhNote), "$0.00 · 不完整（4/635 有读数）");
  assert.equal(
    groupSubtotalText(
      bill.rows.filter((row) => row.typeName === "Vertex AI"),
      () => "$0.00",
      "缺数据",
      zhNote,
    ),
    "$0.00 · 不完整（4/635 有读数）",
  );
  assert.equal(bill.rows.filter((row) => row.typeName === "Vertex AI" && row.kind === "amount" && row.consumption === 0).length, 4);
  const openai = bill.byType.find((item) => item.name === "OpenAI");
  assert.ok(openai);
  assert.equal(openai.readings, 0);
  assert.equal(openai.consumption, null);
  assert.equal(readingAmountText(openai, () => "$0.00", "缺数据", zhNote), "缺数据");
  assert.equal(bill.disabledGateway.channels, 2);
  assert.equal(bill.disabledGateway.readings, 0);
  assert.equal(bill.disabledGateway.consumption, null);
  assert.equal(readingAmountText(bill.disabledGateway, () => "$0.00", "缺数据", zhNote), "缺数据");
  assert.equal(bill.reading.readings, 4);
  assert.equal(bill.reading.channels, 638);
  assert.equal(bill.reading.consumption, 0);
});

test("publishBill freezes the new rules for an unpublished day and leaves an already published day alone", async () => {
  const { dbAll, dbGet, dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView, ensureBillingRun, publishBill } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  const gateways: [string, string, number][] = [
    ["gw-keep", "https://freeze.example", 0],
    ["gw-copy", "https://freeze.example/v1", 1],
    ["gw-only", "https://only.example", 1],
  ];
  for (const [id, base, disabled] of gateways) {
    await dbRun(
      `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
       VALUES (?, ?, ?, '', '1', 1, ?, ?, ?)`,
      [id, id, base, now, now, disabled],
    );
  }
  const channels: [string, string, number][] = [
    ["keep", "gw-keep", 1],
    ["copy", "gw-copy", 1],
    ["only", "gw-only", 2],
  ];
  for (const [id, gatewayId, upstream] of channels) {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
      ) VALUES (?, ?, ?, ?, ?, 41, 'vertex', 1, ?, ?, 1)`,
      [id, gatewayId, upstream, admin.id, id, now, now],
    );
  }
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-09', '2026-11-08', 'published', ?, ?),
            ('2026-11-11', '2026-11-10', 'collecting', ?, NULL)`,
    [now, now, now],
  );
  await dbRun("INSERT INTO recon_periods (month, locked, locked_at) VALUES ('2026-11', 1, ?)", [now]);
  await publishBill("2026-11-08", "2026-11-09");
  const legacyRun = await dbGet("SELECT status, aggregation FROM billing_runs WHERE baseline_day = '2026-11-09'");
  assert.equal(String(legacyRun?.status), "published");
  assert.equal(legacyRun?.aggregation ?? null, null);
  assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_membership WHERE bill_day = '2026-11-08'"))?.n), 0);

  await publishBill("2026-11-10", "2026-11-11");
  const freshRun = await dbGet("SELECT status, aggregation FROM billing_runs WHERE baseline_day = '2026-11-11'");
  assert.equal(String(freshRun?.status), "published");
  assert.equal(String(freshRun?.aggregation), "dedup");
  const membership = await dbAll("SELECT channel_id, role FROM billing_membership WHERE bill_day = '2026-11-10' ORDER BY channel_id");
  assert.deepEqual(
    membership.map((row) => [String(row.channel_id), String(row.role)]),
    [
      ["copy", "duplicate"],
      ["keep", "counted"],
      ["only", "excluded"],
    ],
  );

  const published = await billingView(admin, { day: "2026-11-10" });
  assert.equal(published.aggregation, "dedup");
  assert.deepEqual(published.rows.map((row) => row.id), ["keep"]);
  assert.equal(published.disabledGateway.channels, 1);
  assert.equal(published.disabledGateway.readings, 0);
  assert.equal(published.disabledGateway.consumption, null);
  assert.equal(published.byType.find((item) => item.name === "Vertex AI")?.channels, 1);

  await dbRun("UPDATE gateways SET disabled = 1 WHERE id = 'gw-keep'");
  await dbRun("UPDATE gateways SET disabled = 0 WHERE id IN ('gw-copy', 'gw-only')");
  const frozen = await billingView(admin, { day: "2026-11-10" });
  assert.deepEqual(frozen.rows.map((row) => row.id), ["keep"]);
  assert.equal(frozen.disabledGateway.channels, 1);
  assert.equal(frozen.disabledGateway.consumption, null);

  const scheduled = await ensureBillingRun(new Date("2026-11-11T22:00:00.000Z"));
  assert.equal(scheduled?.billDay, "2026-11-11");
  assert.equal(scheduled?.baselineDay, "2026-11-12");
  assert.equal(scheduled?.status, "published");
  assert.equal(String((await dbGet("SELECT aggregation FROM billing_runs WHERE baseline_day = '2026-11-12'"))?.aggregation), "dedup");
});

function trendTotal(bill: { trend: { day: string; value: number | null; missing?: boolean }[] }, day: string) {
  return bill.trend.filter((item) => item.day === day && !item.missing).reduce((sum, item) => sum + (item.value ?? 0), 0);
}

test("the trend uses the same per-day rule as the bill", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('tr-on', 'on', 'https://trend.example', '', '1', 0, ?, ?, 0),
            ('tr-off', 'off', 'https://trend.example/v1', '', '1', 0, ?, ?, 1)`,
    [now, now, now, now],
  );
  const channels: [string, string, number][] = [
    ["tr-keep", "tr-on", 10],
    ["tr-copy", "tr-off", 10],
    ["tr-only", "tr-off", 11],
  ];
  const amounts: [string, number][] = [
    ["tr-keep", 100],
    ["tr-copy", 40],
    ["tr-only", 70],
  ];
  for (const [id, gatewayId, upstream] of channels) {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, today_quota
      ) VALUES (?, ?, ?, ?, ?, 41, 'vertex', 1, ?, ?, 1, ?)`,
      [id, gatewayId, upstream, admin.id, id, now, now, amounts.find((item) => item[0] === id)?.[1] ?? 0],
    );
  }
  for (const day of ["2026-11-08", "2026-11-09"]) {
    for (const [id, consumption] of amounts) {
      await dbRun(
        `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
         VALUES (?, ?, ?, ?, ?, 1, 'amount', ?)`,
        [`${day}:${id}`, day, id, day, day, consumption],
      );
    }
  }
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, aggregation)
     VALUES ('2026-11-09', '2026-11-08', 'published', ?, ?, NULL),
            ('2026-11-10', '2026-11-09', 'published', ?, ?, 'dedup')`,
    [now, now, now, now],
  );
  for (const [id, role] of [
    ["tr-keep", "counted"],
    ["tr-copy", "duplicate"],
    ["tr-only", "excluded"],
  ] as const) {
    await dbRun("INSERT INTO billing_membership (bill_day, channel_id, role) VALUES ('2026-11-09', ?, ?)", [id, role]);
  }

  const legacy = await billingView(admin, { day: "2026-11-08" });
  const dedup = await billingView(admin, { day: "2026-11-09" });
  assert.equal(legacy.aggregation, "legacy");
  assert.equal(legacy.totalConsumption, 210);
  assert.equal(legacy.disabledGateway.channels, 0);
  assert.equal(trendTotal(legacy, "2026-11-08"), 210);
  assert.equal(trendTotal(legacy, "2026-11-09"), 100);
  assert.equal(dedup.aggregation, "dedup");
  assert.equal(dedup.totalConsumption, 100);
  assert.equal(dedup.disabledGateway.consumption, 70);
  assert.equal(trendTotal(dedup, "2026-11-08"), 210);
  assert.equal(trendTotal(dedup, "2026-11-09"), 100);

  await dbRun("UPDATE gateways SET disabled = 1 WHERE id = 'tr-on'");
  await dbRun("UPDATE gateways SET disabled = 0 WHERE id = 'tr-off'");
  const legacyAfter = await billingView(admin, { day: "2026-11-08" });
  const dedupAfter = await billingView(admin, { day: "2026-11-09" });
  assert.equal(legacyAfter.totalConsumption, 210);
  assert.equal(trendTotal(legacyAfter, "2026-11-08"), 210);
  assert.equal(dedupAfter.totalConsumption, 100);
  assert.equal(dedupAfter.disabledGateway.consumption, 70);
  assert.equal(trendTotal(dedupAfter, "2026-11-09"), 100);
  assert.equal(trendTotal(dedupAfter, "2026-11-08"), 210);
});

test("publishBill keeps the unpublished dedup in the bill and the trend", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView, publishBill } = await import("./billing-service.ts");
  const { upstreamQueue } = await import("./rate-queue.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const previous = { ...upstreamQueue.limits };
  upstreamQueue.setLimits({ gatewayPerMin: 10_000, channelPerMin: 10_000, concurrency: 20 });
  try {
    const now = Date.now();
    await dbRun(
      `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
       VALUES ('pb-on', 'on', 'https://publish.example', '', '1', 1, ?, ?, 0),
              ('pb-off', 'off', 'https://publish.example/v1', '', '1', 1, ?, ?, 1)`,
      [now, now, now, now],
    );
    const channels: [string, string, number, number][] = [
      ["pb-keep", "pb-on", 10, 100],
      ["pb-copy", "pb-off", 10, 40],
      ["pb-only", "pb-off", 11, 70],
    ];
    for (const [id, gatewayId, upstream, amount] of channels) {
      await dbRun(
        `INSERT INTO channels (
          id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
        ) VALUES (?, ?, ?, ?, ?, 1, 'pool', 1, ?, ?, 1)`,
        [id, gatewayId, upstream, admin.id, id, now, now],
      );
      await dbRun(
        `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
         VALUES (?, '2026-11-10', 0, 0, 0, 'snapshot', ?),
                (?, '2026-11-11', ?, ?, 0, 'snapshot', ?)`,
        [id, now, id, amount, amount, now],
      );
      await dbRun(
        `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
         VALUES (?, '2026-11-10', ?, '2026-11-10', '2026-11-10', 1, 'amount', ?)`,
        [id, id, amount],
      );
    }
    await dbRun(
      `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
       VALUES ('2026-11-11', '2026-11-10', 'collecting', ?, NULL)`,
      [now],
    );
    await dbRun("INSERT INTO recon_periods (month, locked, locked_at) VALUES ('2026-11', 1, ?)", [now]);

    const before = await billingView(admin, { day: "2026-11-10" });
    assert.equal(before.publication, "unpublished");
    assert.equal(before.aggregation, "dedup");
    assert.deepEqual(before.rows.map((row) => row.id).sort(), ["pb-keep"]);
    assert.equal(before.totalConsumption, 100);
    assert.equal(before.disabledGateway.consumption, 70);
    assert.equal(before.disabledGateway.channels, 1);
    assert.equal(trendTotal(before, "2026-11-10"), 100);

    await publishBill("2026-11-10", "2026-11-11");
    const after = await billingView(admin, { day: "2026-11-10" });
    assert.notEqual(after.publication, "unpublished");
    assert.equal(after.aggregation, "dedup");
    assert.deepEqual(after.rows.map((row) => row.id).sort(), before.rows.map((row) => row.id).sort());
    assert.equal(after.totalConsumption, before.totalConsumption);
    assert.equal(after.disabledGateway.consumption, before.disabledGateway.consumption);
    assert.equal(after.disabledGateway.channels, before.disabledGateway.channels);
    assert.equal(trendTotal(after, "2026-11-10"), trendTotal(before, "2026-11-10"));

    await dbRun("UPDATE gateways SET disabled = 1 WHERE id = 'pb-on'");
    await dbRun("UPDATE gateways SET disabled = 0 WHERE id = 'pb-off'");
    const flipped = await billingView(admin, { day: "2026-11-10" });
    assert.deepEqual(flipped.rows.map((row) => row.id).sort(), ["pb-keep"]);
    assert.equal(flipped.totalConsumption, 100);
    assert.equal(flipped.disabledGateway.consumption, 70);
    assert.equal(flipped.disabledGateway.channels, 1);
    assert.equal(trendTotal(flipped, "2026-11-10"), 100);
  } finally {
    upstreamQueue.setLimits(previous);
  }
});

async function seedCutoffChannels(
  dbRun: (sql: string, params?: unknown[]) => Promise<void>,
  adminId: string,
  now: number,
  days: string[],
) {
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('cut-on', 'on', 'https://cutoff.example', '', '1', 0, ?, ?, 0),
            ('cut-off', 'off', 'https://cutoff.example/v1', '', '1', 0, ?, ?, 1)`,
    [now, now, now, now],
  );
  const channels: [string, string, number, number][] = [
    ["cut-keep", "cut-on", 10, 100],
    ["cut-copy", "cut-off", 10, 40],
    ["cut-only", "cut-off", 11, 70],
  ];
  for (const [id, gatewayId, upstream, amount] of channels) {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, today_quota
      ) VALUES (?, ?, ?, ?, ?, 41, 'vertex', 1, ?, ?, 1, ?)`,
      [id, gatewayId, upstream, adminId, id, now, now, amount],
    );
  }
  for (const day of days) {
    for (const [id, , , amount] of channels) {
      await dbRun(
        `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
         VALUES (?, ?, ?, ?, ?, 1, 'amount', ?)`,
        [`${day}:${id}`, day, id, day, day, amount],
      );
    }
  }
}

test("a published null run on 2026-11-10 is stamped dedup on the first read", async () => {
  const { dbAll, dbGet, dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await seedCutoffChannels(dbRun, admin.id, now, ["2026-11-10"]);
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-11', '2026-11-10', 'published', ?, ?)`,
    [now, now],
  );

  const [first, second] = await Promise.all([
    billingView(admin, { day: "2026-11-10" }),
    billingView(admin, { day: "2026-11-10" }),
  ]);
  for (const bill of [first, second]) {
    assert.equal(bill.aggregation, "dedup");
    assert.deepEqual(bill.rows.map((row) => row.id), ["cut-keep"]);
    assert.equal(bill.totalConsumption, 100);
    assert.equal(bill.disabledGateway.channels, 1);
    assert.equal(bill.disabledGateway.consumption, 70);
    assert.equal(trendTotal(bill, "2026-11-10"), 100);
  }
  assert.equal(String((await dbGet("SELECT aggregation FROM billing_runs WHERE bill_day = '2026-11-10'"))?.aggregation), "dedup");
  const membership = await dbAll("SELECT channel_id, role FROM billing_membership WHERE bill_day = '2026-11-10' ORDER BY channel_id");
  assert.deepEqual(
    membership.map((row) => [String(row.channel_id), String(row.role)]),
    [
      ["cut-copy", "duplicate"],
      ["cut-keep", "counted"],
      ["cut-only", "excluded"],
    ],
  );

  await dbRun("UPDATE gateways SET disabled = 1 WHERE id = 'cut-on'");
  await dbRun("UPDATE gateways SET disabled = 0 WHERE id = 'cut-off'");
  const again = await billingView(admin, { day: "2026-11-10" });
  assert.deepEqual(again.rows.map((row) => row.id), first.rows.map((row) => row.id));
  assert.equal(again.totalConsumption, first.totalConsumption);
  assert.equal(again.disabledGateway.consumption, first.disabledGateway.consumption);
  assert.equal(again.disabledGateway.channels, first.disabledGateway.channels);
  assert.equal(trendTotal(again, "2026-11-10"), trendTotal(first, "2026-11-10"));
  const membershipAgain = await dbAll("SELECT channel_id, role FROM billing_membership WHERE bill_day = '2026-11-10' ORDER BY channel_id");
  assert.deepEqual(membershipAgain, membership);
});

test("a published null run on 2026-11-09 stays legacy and unstamped", async () => {
  const { dbGet, dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await seedCutoffChannels(dbRun, admin.id, now, ["2026-11-09"]);
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-10', '2026-11-09', 'published', ?, ?)`,
    [now, now],
  );
  const first = await billingView(admin, { day: "2026-11-09" });
  const second = await billingView(admin);
  assert.equal(first.aggregation, "legacy");
  assert.equal(second.aggregation, "legacy");
  assert.equal(first.totalConsumption, 210);
  assert.equal(first.disabledGateway.channels, 0);
  assert.deepEqual(first.rows.map((row) => row.id).sort(), ["cut-copy", "cut-keep", "cut-only"]);
  assert.equal(trendTotal(first, "2026-11-09"), 210);
  assert.equal(trendTotal(second, "2026-11-09"), 210);
  assert.equal((await dbGet("SELECT aggregation FROM billing_runs WHERE bill_day = '2026-11-09'"))?.aggregation ?? null, null);
  assert.equal(Number((await dbGet("SELECT COUNT(*) AS n FROM billing_membership WHERE bill_day = '2026-11-09'"))?.n), 0);
});

test("the trend stamps 2026-11-10 and leaves 2026-11-09 on the stored rows", async () => {
  const { dbGet, dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await seedCutoffChannels(dbRun, admin.id, now, ["2026-11-09", "2026-11-10"]);
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-10', '2026-11-09', 'published', ?, ?),
            ('2026-11-11', '2026-11-10', 'published', ?, ?)`,
    [now, now, now, now],
  );
  const opened = await billingView(admin, { day: "2026-11-09" });
  assert.equal(opened.aggregation, "legacy");
  assert.equal(opened.totalConsumption, 210);
  assert.equal(trendTotal(opened, "2026-11-09"), 210);
  assert.equal(trendTotal(opened, "2026-11-10"), 100);
  assert.equal((await dbGet("SELECT aggregation FROM billing_runs WHERE bill_day = '2026-11-09'"))?.aggregation ?? null, null);
  assert.equal(String((await dbGet("SELECT aggregation FROM billing_runs WHERE bill_day = '2026-11-10'"))?.aggregation), "dedup");

  await dbRun("UPDATE gateways SET disabled = 1 WHERE id = 'cut-on'");
  await dbRun("UPDATE gateways SET disabled = 0 WHERE id = 'cut-off'");
  const again = await billingView(admin);
  assert.equal(again.billDay, "2026-11-10");
  assert.equal(again.aggregation, "dedup");
  assert.equal(again.totalConsumption, 100);
  assert.equal(again.disabledGateway.consumption, 70);
  assert.equal(trendTotal(again, "2026-11-09"), 210);
  assert.equal(trendTotal(again, "2026-11-10"), 100);
  assert.equal((await dbGet("SELECT aggregation FROM billing_runs WHERE bill_day = '2026-11-09'"))?.aggregation ?? null, null);
});

test("a rolled-back transaction does not undo a write made outside it", async () => {
  const { dbGet, dbRun, dbTransaction } = await freshDb();
  await dbRun("CREATE TABLE IF NOT EXISTS tx_probe (id TEXT PRIMARY KEY)");
  let opened!: () => void;
  const inside = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const txn = dbTransaction(async (tx) => {
    await tx.run("INSERT INTO tx_probe (id) VALUES ('inside')");
    opened();
    await new Promise((resolve) => setTimeout(resolve, 40));
    throw new Error("boom");
  });
  await inside;
  await Promise.race([
    dbRun("INSERT INTO tx_probe (id) VALUES ('outside')"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("outside write blocked")), 2000)),
  ]);
  await assert.rejects(txn, /boom/);
  assert.equal(String((await dbGet("SELECT id FROM tx_probe WHERE id = 'outside'"))?.id), "outside");
  assert.equal((await dbGet("SELECT id FROM tx_probe WHERE id = 'inside'")) ?? null, null);
});

test("a trend day with no reading is missing, and an all-zero window is flagged", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('tr0', 'on', 'https://zero.example', '', '1', 0, ?, ?, 0)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, today_quota
    ) VALUES ('z0', 'tr0', 1, ?, 'z0', 1, 'pool', 1, ?, ?, 1, 0),
             ('zmiss', 'tr0', 2, ?, 'zmiss', 1, 'pool', 1, ?, ?, 1, NULL)`,
    [admin.id, now, now, admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
     VALUES ('a', '2026-11-07', 'z0', '2026-11-07', '2026-11-07', 1, 'amount', 0),
            ('b', '2026-11-08', 'z0', '2026-11-08', '2026-11-08', 1, 'amount', 0),
            ('c', '2026-11-06', 'zmiss', '2026-11-06', '2026-11-06', 1, 'amount', NULL)`,
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-08', '2026-11-07', 'published', ?, ?),
            ('2026-11-09', '2026-11-08', 'published', ?, ?),
            ('2026-11-07', '2026-11-06', 'published', ?, ?)`,
    [now, now, now, now, now, now],
  );
  const bill = await billingView(admin, { day: "2026-11-08" });
  const zeros = bill.trend.filter((item) => item.day === "2026-11-07" || item.day === "2026-11-08");
  const missing = bill.trend.find((item) => item.day === "2026-11-06");
  assert.equal(zeros.length, 2);
  assert.ok(zeros.every((item) => item.missing === false && item.value === 0));
  assert.equal(trendWindowAllZero(zeros), true);
  assert.ok(missing);
  assert.equal(missing.missing, true);
  assert.equal(missing.value, null);
  assert.notEqual(missing.value, 0);
  assert.equal(trendWindowAllZero(bill.trend), false);
});

test("each trend day matches that day's bill total, including supplier snapshots", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled, kind)
     VALUES ('ad-on', 'on', 'https://admin.example', '', '1', 0, ?, ?, 0, 'newapi_admin'),
            ('ad-off', 'off', 'https://admin.example/v1', '', '1', 0, ?, ?, 1, 'newapi_admin'),
            ('sup-gw', 'supplier', 'https://supplier.example', '', '1', 0, ?, ?, 0, 'newapi_supplier')`,
    [now, now, now, now, now, now],
  );
  const admins: [string, string, number, number][] = [
    ["ad-keep", "ad-on", 10, 100],
    ["ad-copy", "ad-off", 10, 40],
    ["ad-only", "ad-off", 11, 70],
  ];
  for (const [id, gatewayId, upstream] of admins) {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
      ) VALUES (?, ?, ?, ?, ?, 1, 'pool', 1, ?, ?, 1)`,
      [id, gatewayId, upstream, admin.id, id, now, now],
    );
  }
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
    ) VALUES ('sup', 'sup-gw', 1, ?, 'sup', 1, 'pool', 1, ?, ?, 1)`,
    [admin.id, now, now],
  );
  for (const day of ["2026-11-09", "2026-11-10"]) {
    for (const [id, , , amount] of admins) {
      await dbRun(
        `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
         VALUES (?, ?, ?, ?, ?, 1, 'amount', ?)`,
        [`${day}:${id}`, day, id, day, day, amount],
      );
    }
  }
  for (const [day, amount] of [
    ["2026-11-09", 0],
    ["2026-11-10", 2],
    ["2026-11-11", 4],
    ["2026-11-12", 6],
  ] as const) {
    await dbRun(
      `INSERT INTO billing_snapshots (channel_id, day, source_id, quality, amount, unit, pulled_at)
       VALUES ('sup', ?, 'customer_billing', 'ok', ?, 'usd', ?)`,
      [day, amount, now],
    );
  }
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-09', '2026-11-08', 'published', ?, ?),
            ('2026-11-10', '2026-11-09', 'published', ?, ?),
            ('2026-11-11', '2026-11-10', 'published', ?, ?),
            ('2026-11-12', '2026-11-11', 'collecting', ?, NULL)`,
    [now, now, now, now, now, now, now],
  );

  const window = await billingView(admin, { day: "2026-11-09" });
  const supplierQuota = 2 * 500_000;
  const money = (value: number) => formatUsd(value, "zh-CN");
  const note = (readings: number, channels: number) => `不完整（${readings}/${channels} 有读数）`;
  for (const day of ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"]) {
    const one = await billingView(admin, { day });
    const point = window.trend.find((item) => item.day === day);
    assert.ok(point);
    if (one.aggregation === "legacy") {
      const summary = columnSummary(one.rows.map((row) => row.today));
      assert.equal(point.legacy, true);
      assert.equal(point.missing, summary.missing);
      assert.equal(point.partial, summary.partial);
      assert.equal(point.value, summary.value);
      assert.equal(trendHoverTitle(point, money, "缺数据", "不完整", note), `${day.slice(5)} · ${columnTotalText(summary, money, "缺数据", "不完整")}`);
    } else {
      assert.equal(point.legacy, false);
      assert.equal(point.missing, one.reading.readings === 0);
      assert.equal(point.value, one.reading.readings === 0 ? null : one.totalConsumption);
      assert.equal(trendHoverTitle(point, money, "缺数据", "不完整", note), `${day.slice(5)} · ${readingAmountText(one.reading, money, "缺数据", note)}`);
    }
  }
  const legacy = await billingView(admin, { day: "2026-11-09" });
  const dedup = await billingView(admin, { day: "2026-11-10" });
  const open = await billingView(admin, { day: "2026-11-11" });
  assert.equal(legacy.aggregation, "legacy");
  assert.equal(legacy.totalConsumption, 210 + supplierQuota);
  assert.equal(dedup.aggregation, "dedup");
  assert.equal(dedup.totalConsumption, 100 + supplierQuota);
  assert.equal(dedup.disabledGateway.consumption, 70);
  assert.equal(open.publication, "unpublished");
  assert.equal(open.totalConsumption, supplierQuota);
  assert.equal(window.trend.find((item) => item.day === "2026-11-11")?.unpublished, true);
  assert.equal(window.trend.find((item) => item.day === "2026-11-09")?.unpublished, false);
  assert.equal(window.trend.find((item) => item.day === "2026-11-08")?.missing, true);
  const legacyPoint = window.trend.find((item) => item.day === "2026-11-09");
  assert.equal(legacyPoint?.value, supplierQuota);
  assert.notEqual(legacyPoint?.value, legacy.totalConsumption);
  assert.equal(trendHoverTitle(legacyPoint!, money, "缺数据", "不完整", note).includes("有读数"), false);
});

test("a legacy published day keeps the old daily total text", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('leg', 'on', 'https://legacy.example', '', '1', 0, ?, ?, 0)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, today_quota, used_quota
    ) VALUES ('spent', 'leg', 1, ?, 'spent', 1, 'pool', 1, ?, ?, 1, NULL, 34860000),
             ('zero', 'leg', 2, ?, 'zero', 1, 'pool', 1, ?, ?, 1, 0, 0)`,
    [admin.id, now, now, admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
     VALUES ('spent', '2026-11-09', 'spent', '2026-11-09', '2026-11-09', 1, 'amount', 1000),
            ('zero', '2026-11-09', 'zero', '2026-11-09', '2026-11-09', 1, 'amount', 0)`,
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-10', '2026-11-09', 'published', ?, ?)`,
    [now, now],
  );
  const bill = await billingView(admin, { day: "2026-11-09" });
  const money = (value: number) => formatUsd(value, "zh-CN");
  const daily = columnTotalText(columnSummary(bill.rows.map((row) => row.today)), money, "缺数据", "不完整");
  const cumulative = columnTotalText(columnSummary(bill.rows.map((row) => row.cumulative)), money, "缺数据", "不完整");
  assert.equal(bill.aggregation, "legacy");
  assert.equal(bill.totalConsumption, 1000);
  assert.equal(daily, "$0.00 · 不完整");
  assert.equal(cumulative, "$69.72");
  const point = bill.trend.find((item) => item.day === "2026-11-09");
  assert.ok(point);
  assert.equal(point.legacy, true);
  assert.equal(point.value, 0);
  assert.equal(point.partial, true);
  assert.equal(point.missing, false);
  assert.equal(trendHoverTitle(point, money, "缺数据", "不完整", (readings, channels) => `不完整（${readings}/${channels} 有读数）`), "11-09 · $0.00 · 不完整");
  assert.equal(
    trendHoverTitle(point, (value) => formatUsd(value, "en"), "Missing data", "Incomplete", (readings, channels) => `incomplete (${readings}/${channels} with readings)`),
    "11-09 · $0.00 · Incomplete",
  );
});

test("a multi-day bill is one blue-range bar and matches that day's total", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('span', 'on', 'https://span.example', '', '1', 0, ?, ?, 0)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, today_quota
    ) VALUES ('span-ch', 'span', 1, ?, 'span', 1, 'pool', 1, ?, ?, 1, 500)`,
    [admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, label, kind, consumption)
     VALUES ('span-row', '2026-11-07', 'span-ch', '2026-11-05', '2026-11-07', 3, 'spanN', 'amount', 500)`,
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-08', '2026-11-07', 'published', ?, ?)`,
    [now, now],
  );
  const bill = await billingView(admin, { day: "2026-11-07" });
  assert.equal(bill.trend.length, 1);
  const point = bill.trend[0];
  assert.ok(point);
  assert.equal(point.span, true);
  assert.equal(point.spanDays, 3);
  assert.equal(point.label, "11-05–11-07");
  assert.equal(point.value, columnSummary(bill.rows.map((row) => row.today)).value);
  assert.equal(point.value, 500);
  const money = (value: number) => formatUsd(value, "zh-CN");
  assert.equal(
    trendHoverTitle(point, money, "缺数据", "不完整", (readings, channels) => `不完整（${readings}/${channels} 有读数）`),
    `11-05–11-07 · ${columnTotalText(columnSummary(bill.rows.map((row) => row.today)), money, "缺数据", "不完整")}`,
  );
});

test("the chart computes at most 30 days", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('win', 'on', 'https://window.example', '', '1', 0, ?, ?, 0)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here, today_quota
    ) VALUES ('win-ch', 'win', 1, ?, 'win', 1, 'pool', 1, ?, ?, 1, 1)`,
    [admin.id, now, now],
  );
  const days: string[] = [];
  for (let index = 0; index < 35; index += 1) {
    const date = new Date(Date.UTC(2026, 8, 1 + index));
    days.push(date.toISOString().slice(0, 10));
  }
  for (const day of days) {
    await dbRun(
      `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
       VALUES (?, ?, 'win-ch', ?, ?, 1, 'amount', 1)`,
      [`row-${day}`, day, day, day],
    );
    await dbRun(
      `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
       VALUES (?, ?, 'published', ?, ?)`,
      [`base-${day}`, day, now, now],
    );
  }
  const newest = await billingView(admin, { day: days[days.length - 1] });
  assert.equal(newest.trend.length, 30);
  assert.equal(newest.trend.some((item) => item.day === days[0]), false);
  assert.equal(newest.trend.some((item) => item.day === days[days.length - 1]), true);
  assert.equal(newest.trend[0]?.day, days[5]);
  const oldest = await billingView(admin, { day: days[0] });
  assert.equal(oldest.billDay, days[0]);
  assert.equal(oldest.rows.length, 1);
  assert.equal(oldest.trend.length, 30);
  assert.equal(oldest.trend.some((item) => item.day === days[0]), false);
});

test("a later snapshot for d+1 changes the cached trend and the bill total together", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled, kind)
     VALUES ('snap-gw', 'supplier', 'https://snap-cache.example', '', '1', 0, ?, ?, 0, 'newapi_supplier')`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
    ) VALUES ('snap-ch', 'snap-gw', 1, ?, 'snap', 1, 'pool', 1, ?, ?, 1)`,
    [admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_snapshots (channel_id, day, source_id, quality, amount, unit, pulled_at)
     VALUES ('snap-ch', '2026-11-08', 'customer_billing', 'ok', 0, 'usd', ?)`,
    [now],
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-09', '2026-11-08', 'published', ?, ?),
            ('2026-11-10', '2026-11-09', 'published', ?, ?)`,
    [now, now, now, now],
  );
  const cached = await billingView(admin, { day: "2026-11-09" });
  const before = cached.trend.find((item) => item.day === "2026-11-08");
  assert.ok(before);
  assert.equal(before.missing, true);
  assert.equal(before.value, null);
  await dbRun(
    `INSERT INTO billing_snapshots (channel_id, day, source_id, quality, amount, unit, pulled_at)
     VALUES ('snap-ch', '2026-11-09', 'customer_billing', 'ok', 2, 'usd', ?)`,
    [now + 1],
  );
  const again = await billingView(admin, { day: "2026-11-09" });
  const point = again.trend.find((item) => item.day === "2026-11-08");
  const opened = await billingView(admin, { day: "2026-11-08" });
  const table = columnSummary(opened.rows.map((row) => row.today));
  assert.ok(point);
  assert.equal(point.missing, false);
  assert.equal(point.value, 2 * 500_000);
  assert.notEqual(point.value, before.value);
  assert.equal(table.value, point.value);
  assert.equal(table.missing, point.missing);
  assert.equal(opened.trend.find((item) => item.day === "2026-11-08")?.value, table.value);
});

test("a billing_rows rewrite for a published day changes the cached trend and the bill total together", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('row-gw', 'admin', 'https://row-cache.example', '', '1', 0, ?, ?, 0)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
    ) VALUES ('row-ch', 'row-gw', 1, ?, 'row', 1, 'pool', 1, ?, ?, 1)`,
    [admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
     VALUES ('2026-11-10:row-ch', '2026-11-10', 'row-ch', '2026-11-10', '2026-11-10', 1, 'amount', 100),
            ('2026-11-11:row-ch', '2026-11-11', 'row-ch', '2026-11-11', '2026-11-11', 1, 'amount', 5)`,
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, aggregation)
     VALUES ('2026-11-11', '2026-11-10', 'published', ?, ?, 'dedup'),
            ('2026-11-12', '2026-11-11', 'published', ?, ?, 'dedup')`,
    [now, now, now, now],
  );
  await dbRun("INSERT INTO billing_membership (bill_day, channel_id, role) VALUES ('2026-11-10', 'row-ch', 'counted'), ('2026-11-11', 'row-ch', 'counted')");
  const cached = await billingView(admin, { day: "2026-11-11" });
  const before = cached.trend.find((item) => item.day === "2026-11-10");
  assert.ok(before);
  assert.equal(before.value, 100);
  await dbRun("UPDATE billing_rows SET consumption = 250 WHERE bill_day = '2026-11-10' AND channel_id = 'row-ch'");
  const again = await billingView(admin, { day: "2026-11-11" });
  const point = again.trend.find((item) => item.day === "2026-11-10");
  const opened = await billingView(admin, { day: "2026-11-10" });
  assert.ok(point);
  assert.equal(point.value, 250);
  assert.notEqual(point.value, before.value);
  assert.equal(opened.totalConsumption, 250);
  assert.equal(opened.trend.find((item) => item.day === "2026-11-10")?.value, opened.totalConsumption);
  assert.equal(point.value, opened.totalConsumption);
});

test("a null consumption becoming 0 changes the cached trend from missing to zero", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled)
     VALUES ('null-gw', 'admin', 'https://null-cache.example', '', '1', 0, ?, ?, 0)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
    ) VALUES ('null-ch', 'null-gw', 1, ?, 'null', 1, 'pool', 1, ?, ?, 1),
             ('null-other', 'null-gw', 2, ?, 'other', 1, 'pool', 1, ?, ?, 1)`,
    [admin.id, now, now, admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
     VALUES ('2026-11-10:null-ch', '2026-11-10', 'null-ch', '2026-11-10', '2026-11-10', 1, 'amount', NULL),
            ('2026-11-11:null-other', '2026-11-11', 'null-other', '2026-11-11', '2026-11-11', 1, 'amount', 5)`,
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at, aggregation)
     VALUES ('2026-11-11', '2026-11-10', 'published', ?, ?, 'dedup'),
            ('2026-11-12', '2026-11-11', 'published', ?, ?, 'dedup')`,
    [now, now, now, now],
  );
  await dbRun(
    `INSERT INTO billing_membership (bill_day, channel_id, role)
     VALUES ('2026-11-10', 'null-ch', 'counted'), ('2026-11-11', 'null-other', 'counted')`,
  );
  const cached = await billingView(admin, { day: "2026-11-11" });
  const before = cached.trend.find((item) => item.day === "2026-11-10");
  assert.ok(before);
  assert.equal(before.missing, true);
  assert.equal(before.value, null);
  assert.equal(before.readings, 0);
  await dbRun("UPDATE billing_rows SET consumption = 0 WHERE bill_day = '2026-11-10' AND channel_id = 'null-ch'");
  const again = await billingView(admin, { day: "2026-11-11" });
  const point = again.trend.find((item) => item.day === "2026-11-10");
  const opened = await billingView(admin, { day: "2026-11-10" });
  const openedPoint = opened.trend.find((item) => item.day === "2026-11-10");
  assert.ok(point);
  assert.ok(openedPoint);
  assert.equal(point.missing, false);
  assert.equal(point.value, 0);
  assert.equal(point.readings, 1);
  assert.notEqual(point.missing, before.missing);
  assert.equal(opened.reading.readings, point.readings);
  assert.equal(opened.reading.consumption, point.value);
  assert.equal(openedPoint.value, point.value);
  assert.equal(openedPoint.missing, point.missing);
  assert.equal(openedPoint.readings, point.readings);
});

test("a snapshot quality change from failed to ok changes the cached trend from missing to zero", async () => {
  const { dbRun } = await freshDb();
  const { authenticate } = await import("./users.ts");
  const { billingView } = await import("./billing-service.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, disabled, kind)
     VALUES ('qual-gw', 'supplier', 'https://qual-cache.example', '', '1', 0, ?, ?, 0, 'newapi_supplier')`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO channels (
      id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, created_here
    ) VALUES ('qual-ch', 'qual-gw', 1, ?, 'qual', 1, 'pool', 1, ?, ?, 1)`,
    [admin.id, now, now],
  );
  await dbRun(
    `INSERT INTO billing_snapshots (channel_id, day, source_id, quality, amount, unit, fx_rate, pulled_at)
     VALUES ('qual-ch', '2026-11-08', 'customer_billing', 'ok', 0, 'usd', NULL, ?),
            ('qual-ch', '2026-11-09', 'customer_billing', 'failed', 0, 'usd', NULL, ?)`,
    [now, now],
  );
  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at)
     VALUES ('2026-11-09', '2026-11-08', 'published', ?, ?),
            ('2026-11-10', '2026-11-09', 'published', ?, ?)`,
    [now, now, now, now],
  );
  const cached = await billingView(admin, { day: "2026-11-09" });
  const before = cached.trend.find((item) => item.day === "2026-11-08");
  assert.ok(before);
  assert.equal(before.missing, true);
  assert.equal(before.value, null);
  await dbRun("UPDATE billing_snapshots SET quality = 'ok' WHERE channel_id = 'qual-ch' AND day = '2026-11-09'");
  const again = await billingView(admin, { day: "2026-11-09" });
  const point = again.trend.find((item) => item.day === "2026-11-08");
  const opened = await billingView(admin, { day: "2026-11-08" });
  const table = columnSummary(opened.rows.map((row) => row.today));
  assert.ok(point);
  assert.equal(point.missing, false);
  assert.equal(point.value, 0);
  assert.equal(point.readings, (before.readings ?? 0) + 1);
  assert.equal(table.missing, false);
  assert.equal(table.value, 0);
  assert.equal(point.value, table.value);
  assert.equal(point.missing, table.missing);
  assert.equal(opened.trend.find((item) => item.day === "2026-11-08")?.value, table.value);
  assert.equal(opened.reading.readings, point.readings);
});
