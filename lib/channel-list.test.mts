import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHANNEL_ID_SEARCH_CAP, parseChannelKeyword } from "./channel-query.ts";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-channels-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

test("a pasted id list is one capped set", () => {
  const pasted = parseChannelKeyword("10, 20\n30  20，40");
  assert.deepEqual(pasted.ids, [10, 20, 30, 40]);
  assert.equal(pasted.recognized, 4);
  assert.equal(pasted.truncated, false);
  assert.equal(parseChannelKeyword("兔子").text, "兔子");
  assert.equal(parseChannelKeyword("7").ids.length, 0);
  const overflow = parseChannelKeyword(Array.from({ length: CHANNEL_ID_SEARCH_CAP + 25 }, (_, index) => String(index + 1)).join(" "));
  assert.equal(overflow.ids.length, CHANNEL_ID_SEARCH_CAP);
  assert.equal(overflow.recognized, CHANNEL_ID_SEARCH_CAP + 25);
  assert.equal(overflow.truncated, true);
});

test("thousands of channels still return one sorted page", async () => {
  const { resetDatabaseForTests, dbGet, dbRun, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { authenticate } = await import("./users.ts");
  const { queryChannels } = await import("./channel-service.ts");
  const { shanghaiClock } = await import("./shanghai.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  assert.equal(typeof admin === "object" && admin.role, "admin");
  if (typeof admin !== "object") return;

  const now = Date.now();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at)
     VALUES ('gw', '批量', 'https://demo.invalid', '', '1', 1, ?, ?)`,
    [now, now],
  );
  const total = 4000;
  const batch = 40;
  for (let start = 0; start < total; start += batch) {
    const values: string[] = [];
    const params: unknown[] = [];
    for (let offset = 0; offset < batch; offset += 1) {
      const n = start + offset;
      const status = n % 17 === 0 ? 3 : n % 5 === 0 ? 2 : 1;
      values.push("(?, 'gw', ?, ?, ?, 1, 'pool', ?, ?, ?, ?, 1, ?)");
      params.push(`ch-${n}`, n + 1, admin.id, `渠道 ${n}`, status, now - n * 1000, now, n + 1, n % 29 === 0 ? 1 : 0);
    }
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, created_at, updated_at, used_quota, created_here, upstream_missing
      ) VALUES ${values.join(",")}`,
      params,
    );
  }
  const day = shanghaiClock().day;
  await dbRun("UPDATE channels SET used_quota = 9000, auto_disable_reason = ?, auto_disabled_at = ?, status = 3 WHERE id = 'ch-49'", ["上游返回 401", now - 60_000]);
  await dbRun(
    `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
     VALUES ('ch-49', ?, 1000, 1000, 0, 'exact', ?)`,
    [day, now],
  );

  const listedAt = performance.now();
  const listed = await queryChannels(admin, new URLSearchParams({ gateway: "gw", sort: "total", dir: "asc", page: "1" }));
  const listedMs = performance.now() - listedAt;
  assert.equal(listed.total, total);
  assert.equal(listed.items.length, 50);
  assert.equal(listed.items[0]?.upstreamId, 1);
  assert.equal(listed.items[0]?.usedQuota, 1);
  assert.equal(listed.stats.total, total);
  assert.ok(listed.counts.anomaly > 0);
  assert.ok(listedMs < 1500, `sorted list took ${listedMs.toFixed(0)}ms`);

  const focused = await queryChannels(admin, new URLSearchParams({ gateway: "gw", keyword: "50, 99999" }));
  assert.equal(focused.total, 1);
  const row = focused.items.find((item) => item.upstreamId === 50);
  assert.ok(row);
  assert.equal(row?.beforeQuota, 1000);
  assert.equal(row?.todayQuota, 8000);
  assert.equal(row?.usedQuota, 9000);
  assert.equal(row?.autoDisabled, true);
  assert.equal(row?.autoDisableReason, "上游返回 401");
  assert.equal(row?.autoDisabledAt, now - 60_000);

  const needle = Array.from({ length: 800 }, (_, index) => String((index + 1) * 3)).join(", ");
  const searchedAt = performance.now();
  const searched = await queryChannels(admin, new URLSearchParams({ gateway: "gw", keyword: needle }));
  const searchedMs = performance.now() - searchedAt;
  assert.equal(searched.total, 800);
  assert.equal(searched.items.length, 50);
  assert.equal(searched.recognized, 800);
  assert.equal(searched.truncated, false);
  assert.ok(searchedMs < 1500, `id search took ${searchedMs.toFixed(0)}ms`);

  const stored = await dbGet("SELECT used_quota FROM channels WHERE id = 'ch-0'");
  assert.equal(Number(stored?.used_quota), 1);
});
