import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { billingPickerDay, billingRequestQuery, disabledGatewayAmountText, groupSubtotalText, readingAmountText, rollupReadingValues } from "./billing-query.ts";
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
    billing: { incompleteReadings: string };
  };
  const en = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8")) as {
    channels: { confirmedAt: string; pendingConfirm: string };
    billing: { incompleteReadings: string };
  };
  assert.equal(zh.billing.incompleteReadings, "不完整（{readings}/{channels} 有读数）");
  assert.equal(en.billing.incompleteReadings, "incomplete ({readings}/{channels} with readings)");
  assert.equal(zh.channels.confirmedAt, "最近确认于 {when}");
  assert.equal(zh.channels.pendingConfirm, "待确认");
  assert.equal(en.channels.confirmedAt, "Last confirmed {when}");
  assert.equal(en.channels.pendingConfirm, "Pending confirmation");
});

async function freshDb() {
  const { resetDatabaseForTests, dbGet, dbRun, dbAll, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  for (const table of ["billing_rows", "billing_runs", "billing_attempts", "channel_bindings", "channels", "gateways"]) {
    await dbRun(`DELETE FROM ${table}`);
  }
  return { dbGet, dbRun, dbAll };
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
