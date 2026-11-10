import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { channelCreatorId } from "./scope.ts";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-sub-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

const parentActor = { id: "parent", parentUserId: null };
const childActor = { id: "child", parentUserId: "parent" };

test("channel ownership stays with the parent supplier", () => {
  assert.equal(channelCreatorId(parentActor, null), "parent");
  assert.equal(channelCreatorId(childActor, null), "parent");
  assert.equal(channelCreatorId(childActor, "parent"), "parent");
  assert.equal(channelCreatorId(parentActor, "parent"), "parent");
});

test("sub-account copy stays on the username and password session", () => {
  const zh = JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url), "utf8")) as {
    nav: { subAccounts: string };
    settings: { subAccountHint: string };
    subAccounts: Record<string, unknown>;
  };
  const en = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8")) as {
    nav: { subAccounts: string };
    subAccounts: { empty: string; create: string; disableBody: string };
  };
  const blob = JSON.stringify({
    nav: zh.nav.subAccounts,
    hint: zh.settings.subAccountHint,
    sub: zh.subAccounts,
  });
  for (const phrase of ["Access Token", "缺少令牌", "系统访问令牌", "请更新令牌", "令牌失效"]) {
    assert.equal(blob.includes(phrase), false, phrase);
  }
  assert.equal(zh.nav.subAccounts, "子账户");
  assert.equal(en.nav.subAccounts, "Sub-accounts");
  assert.equal(en.subAccounts.create, "Create sub-account");
  assert.equal(en.subAccounts.empty, "No sub-accounts yet. Click “Create sub-account” to add one.");
  assert.match(en.subAccounts.disableBody, /cannot sign in/);
});

test("parent, sub-account, and admin permissions", async () => {
  const { resetDatabaseForTests, dbRun, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { authenticate, createSubAccount, createSupplier, listSubAccounts, recordLogin, updateSubAccount } = await import("./users.ts");
  const { assertCanManageGateways } = await import("./scope.ts");
  const { createChannels, importSellerChannels, queryChannels, updateChannel } = await import("./channel-service.ts");
  const { billingView } = await import("./billing-service.ts");
  const { applyReconAction } = await import("./recon-service.ts");
  const { createSellerGateway, listVisibleGateways } = await import("./gateways.ts");

  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin");
  const parent = await createSupplier({ username: "shop", name: "华东供应商", password: "supplier-pass" });
  const other = await createSupplier({ username: "other", name: "另一家", password: "supplier-pass" });

  assert.deepEqual(await listSubAccounts(parent), []);
  const created = await createSubAccount(parent, { username: "clerk", password: "clerk-pass-1" });
  assert.equal(created.username, "clerk");
  assert.equal(created.parentId, parent.id);
  assert.equal("password" in created, false);
  const listed = await listSubAccounts(parent);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.disabled, false);
  assert.equal(JSON.stringify(listed).includes("clerk-pass-1"), false);

  const sub = await authenticate("clerk", "clerk-pass-1");
  if (typeof sub !== "object") throw new Error("sub");
  assert.equal(sub.parentUserId, parent.id);
  assert.equal(sub.role, "supplier");
  await assert.rejects(() => createSubAccount(sub, { username: "nested", password: "nested-pass-1" }), (error: Error) => error.message === "subAccountNested");
  await assert.rejects(() => createSubAccount(admin, { username: "deeper", password: "desk-pass-11", parentId: created.id }), (error: Error) => error.message === "parentInvalid");
  await assert.rejects(() => createSubAccount(parent, { username: "nope", password: "supplier-pass", parentId: other.id }), (error: Error) => error.message === "subAccountTransfer");
  await assert.rejects(() => createSubAccount(admin, { username: "nope", password: "supplier-pass" }), (error: Error) => error.message === "parentRequired");

  await recordLogin(sub.id, 1_700_000_000_000);
  assert.equal((await listSubAccounts(parent))[0]?.lastLoginAt, 1_700_000_000_000);

  await updateSubAccount(parent, sub.id, { disabled: true });
  assert.equal(await authenticate("clerk", "clerk-pass-1"), "disabled");
  await updateSubAccount(parent, sub.id, { disabled: false });
  assert.equal(typeof (await authenticate("clerk", "clerk-pass-1")), "object");
  const reset = await updateSubAccount(parent, sub.id, { password: "clerk-pass-2" });
  assert.equal(JSON.stringify(reset).includes("clerk-pass-2"), false);
  assert.equal(await authenticate("clerk", "clerk-pass-1"), "invalid");
  const resigned = await authenticate("clerk", "clerk-pass-2");
  if (typeof resigned !== "object") throw new Error("resigned");

  const adminMade = await createSubAccount(admin, { username: "desk", password: "desk-pass-11", parentId: parent.id });
  assert.equal(adminMade.parentId, parent.id);
  await assert.rejects(() => updateSubAccount(admin, adminMade.id, { parentId: other.id }), (error: Error) => error.message === "subAccountTransfer");
  await updateSubAccount(admin, adminMade.id, { disabled: true });
  assert.equal(await authenticate("desk", "desk-pass-11"), "disabled");
  await updateSubAccount(admin, adminMade.id, { password: "desk-pass-22", disabled: false });
  assert.equal(typeof (await authenticate("desk", "desk-pass-22")), "object");
  const otherSub = await createSubAccount(admin, { username: "foreign", password: "foreign-pass", parentId: other.id });
  const everyone = await listSubAccounts(admin);
  assert.equal(everyone.length, 3);
  assert.equal((await listSubAccounts(parent)).some((item) => item.id === otherSub.id), false);
  await assert.rejects(() => listSubAccounts(resigned), (error: Error) => error.message === "forbidden");
  await assert.rejects(() => updateSubAccount(resigned, adminMade.id, { disabled: true }), (error: Error) => error.message === "subAccountNested");
  await assert.rejects(() => updateSubAccount(other, created.id, { disabled: true }), (error: Error) => error.message === "forbidden");

  assert.throws(() => assertCanManageGateways(resigned), (error: Error & { status?: number }) => error.message === "forbidden" && error.status === 403);
  await assert.rejects(
    () => createSellerGateway(resigned, { name: "nope", baseUrl: "https://seller.example", username: "a", password: "b" }),
    (error: Error) => error.message === "forbidden",
  );

  const now = Date.now();
  const gateways: [string, string, string | null][] = [
    ["gw-admin", "newapi_admin", null],
    ["gw-parent-seller", "newapi_seller", parent.id],
    ["gw-other-seller", "newapi_seller", other.id],
    ["gw-parent-jwt", "newapi_supplier", parent.id],
    ["gw-other-jwt", "newapi_supplier", other.id],
  ];
  for (const [id, kind, owner] of gateways) {
    await dbRun(
      `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, owner_user_id)
       VALUES (?, ?, 'https://gw.example', '', '1', 0, ?, ?, ?, ?)`,
      [id, id, now, now, kind, owner],
    );
  }
  const visible = (await listVisibleGateways(resigned)).map((item) => item.id).sort();
  assert.deepEqual(visible, ["gw-admin", "gw-parent-jwt", "gw-parent-seller"]);
  const parentVisible = (await listVisibleGateways(parent)).map((item) => item.id);
  assert.equal(parentVisible.includes("gw-parent-seller"), true);
  assert.equal(parentVisible.includes("gw-other-seller"), false);

  async function channel(id: string, gatewayId: string, creator: string, name: string, owned: number | null, upstream: number) {
    await dbRun(
      `INSERT INTO channels (
        id, gateway_id, upstream_id, creator_user_id, name, type, group_name, status, models, created_at, updated_at, created_here, owned, origin
      ) VALUES (?, ?, ?, ?, ?, 1, 'pool', 1, 'gpt', ?, ?, 1, ?, ?)`,
      [id, gatewayId, upstream, creator, name, now, now, owned, owned === 0 ? "imported" : "created"],
    );
  }
  await channel("ch-parent", "gw-admin", parent.id, "parent-bill", null, 1);
  await channel("ch-other", "gw-admin", other.id, "other-bill", null, 2);
  await channel("ch-owned", "gw-parent-jwt", parent.id, "", 1, 3);
  await channel("ch-imported", "gw-parent-jwt", parent.id, "imported-key", 0, 4);

  const parentRows = await queryChannels(parent, new URLSearchParams());
  const subRows = await queryChannels(resigned, new URLSearchParams());
  const otherRows = await queryChannels(other, new URLSearchParams());
  const ids = (rows: { items: { id: string }[] }) => rows.items.map((item) => item.id).sort();
  assert.deepEqual(ids(parentRows), ["ch-imported", "ch-owned", "ch-parent"]);
  assert.deepEqual(ids(subRows), ids(parentRows));
  assert.deepEqual(ids(otherRows), ["ch-other"]);

  await assert.rejects(() => updateChannel(resigned, "ch-imported", {}), (error: Error & { status?: number }) => error.message === "supplierNotOwned" && error.status === 403);
  await assert.rejects(() => updateChannel(parent, "ch-imported", {}), (error: Error) => error.message === "supplierNotOwned");
  await assert.rejects(() => updateChannel(resigned, "ch-owned", {}), (error: Error) => error.message === "channelNameRequired");
  await assert.rejects(() => updateChannel(other, "ch-owned", {}), (error: Error) => error.message === "notFound");
  await assert.rejects(() => createChannels(resigned, { gatewayId: "gw-other-jwt" }), (error: Error) => error.message === "gatewayMissing");
  await assert.rejects(() => createChannels(resigned, { gatewayId: "gw-other-seller" }), (error: Error) => error.message === "gatewayMissing");
  await assert.rejects(() => importSellerChannels(resigned, "gw-other-seller"), (error: Error) => error.message === "gatewayMissing");
  await assert.rejects(() => importSellerChannels(other, "gw-parent-seller"), (error: Error) => error.message === "gatewayMissing");

  await dbRun(
    `INSERT INTO billing_runs (baseline_day, bill_day, status, started_at, published_at) VALUES ('2026-11-09', '2026-11-08', 'published', 1, 2)`,
  );
  await dbRun(
    `INSERT INTO billing_rows (id, bill_day, channel_id, start_day, end_day, span_days, kind, consumption)
     VALUES ('bill-p', '2026-11-08', 'ch-parent', '2026-11-08', '2026-11-08', 1, 'amount', 100),
            ('bill-o', '2026-11-08', 'ch-other', '2026-11-08', '2026-11-08', 1, 'amount', 999)`,
  );
  const parentBill = await billingView(parent);
  const subBill = await billingView(resigned);
  const otherBill = await billingView(other);
  assert.equal(parentBill.totalConsumption, 100);
  assert.equal(subBill.totalConsumption, 100);
  assert.deepEqual(subBill.rows.map((row) => row.id), parentBill.rows.map((row) => row.id));
  assert.equal(otherBill.totalConsumption, 999);
  assert.equal(subBill.rows.some((row) => row.id === "ch-other"), false);

  await dbRun(
    `INSERT INTO recon_rows (
      id, bill_day, channel_id, gateway_id, start_day, end_day, check_status, tolerance, quota_per_unit, updated_at
    ) VALUES ('recon-1', '2026-11-08', 'ch-parent', 'gw-admin', '2026-11-08', '2026-11-08', 'match', 0.01, 500000, ?)`,
    [now],
  );
  await assert.rejects(() => applyReconAction(resigned, { action: "confirm", id: "recon-1" }), (error: Error & { status?: number }) => error.message === "forbidden" && error.status === 403);
  await assert.rejects(() => applyReconAction(resigned, { action: "dispute", id: "recon-1", note: "no" }), (error: Error) => error.message === "forbidden");
  await assert.rejects(() => applyReconAction(other, { action: "confirm", id: "recon-1" }), (error: Error) => error.message === "forbidden");
  await applyReconAction(parent, { action: "confirm", id: "recon-1" });
});
