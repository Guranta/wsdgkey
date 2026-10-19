import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "newapi-claim-"));
process.env.DATABASE_URL = `file:${path.join(dir, "app.db")}`;
process.env.TOKEN_ENCRYPTION_KEY = "test-token-key";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.DEMO_GATEWAY = "0";

/** 回归：真实网关（非 demo）创建渠道后必须被认领入库。demo 网关的 add 直接写本地表，
 *  走不到 rememberChannel 的 INSERT 分支，所以这里起一个假 New API 走完整链路。 */
test("a channel created on a real gateway is claimed into the local table", async () => {
  const { resetDatabaseForTests, dbGet, ensureReady } = await import("./db.ts");
  const { resetSecretKeyForTests } = await import("./secret-box.ts");
  resetSecretKeyForTests();
  resetDatabaseForTests();
  await ensureReady();
  const { authenticate } = await import("./users.ts");
  const { createChannels, syncGatewayPage } = await import("./channel-service.ts");
  const { createGateway } = await import("./gateways.ts");
  const admin = await authenticate("admin", "admin-pass-123");
  if (typeof admin !== "object") throw new Error("admin auth failed");

  const upstream: Record<string, unknown>[] = [];
  let nextId = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    const send = (body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/channel/" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(raw) as { mode?: string; channel?: Record<string, unknown> };
        const keys = String(payload.channel?.key ?? "").split("\n").filter(Boolean);
        const pieces = payload.mode === "multi_to_single" ? [keys.join("\n")] : keys;
        for (const key of pieces) {
          nextId += 1;
          upstream.push({ id: nextId, type: 1, status: 1, used_quota: 0, ...payload.channel, key });
        }
        send({ success: true, message: "" });
      });
      return;
    }
    if (url.pathname === "/api/channel/" && req.method === "GET") {
      send({ success: true, data: { items: upstream, total: upstream.length } });
      return;
    }
    if (/^\/api\/channel\/test\/\d+$/.test(url.pathname)) {
      send({ success: true, message: "", time: 0.12 });
      return;
    }
    if (url.pathname === "/api/log/stat") {
      send({ success: true, data: { quota: 0 } });
      return;
    }
    if (url.pathname === "/api/group/") {
      send({ success: true, data: ["default", "vip", "svip"] });
      return;
    }
    if (url.pathname === "/api/pricing") {
      send({ data: [{ model_name: "gpt-4o", enable_groups: ["default"] }, { model_name: "gpt-4o-mini", enable_groups: ["default", "vip"] }] });
      return;
    }
    res.statusCode = 404;
    send({ success: false, message: "not implemented" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const gateway = await createGateway({
      name: "本地假上游",
      baseUrl: `http://127.0.0.1:${port}`,
      adminUserId: "1",
      token: "nap-local-test",
    });
    const created = await createChannels(admin, {
      gatewayId: gateway.id,
      name: "回归-认领",
      type: 1,
      base_url: "https://upstream.example.com",
      models: "gpt-4o-mini",
      key: "sk-test-1234567890abcdef",
      group: "default",
      priority: 6,
      weight: 2,
      tag: "qa",
      remark: "回归备注",
      openai_organization: "org-qa",
      test_model: "gpt-4o-mini",
      model_mapping: JSON.stringify({ "gpt-4o": "gpt-4o-2024-08-06" }),
    });
    assert.equal(created.created, 1, "创建的渠道被本地认领");
    const row = (await dbGet(
      "SELECT name, priority, weight, tag, remark, openai_organization, model_mapping, created_here, creator_user_id FROM channels WHERE gateway_id = ?",
      [gateway.id],
    )) as
      | {
          name: string;
          priority: number;
          weight: number;
          tag: string;
          remark: string;
          openai_organization: string;
          model_mapping: string;
          created_here: number;
          creator_user_id: string;
        }
      | undefined;
    assert.ok(row, "认领后本地有渠道行");
    assert.equal(row.name, "回归-认领");
    assert.equal(Number(row.priority), 6);
    assert.equal(Number(row.weight), 2);
    assert.equal(row.tag, "qa");
    assert.equal(row.remark, "回归备注");
    assert.equal(row.openai_organization, "org-qa");
    assert.equal(row.model_mapping, JSON.stringify({ "gpt-4o": "gpt-4o-2024-08-06" }));
    assert.equal(Number(row.created_here), 1);
    assert.equal(row.creator_user_id, admin.id);
    assert.equal(created.tests.length, 1, "创建后自动测试跑了一次");

    // 已有行再次走列表同步：UPDATE 分支不抛错、行保留
    await syncGatewayPage(gateway.id, 1);
    const after = (await dbGet("SELECT name, created_here FROM channels WHERE gateway_id = ?", [gateway.id])) as
      | { name: string; created_here: number }
      | undefined;
    assert.ok(after, "再同步后渠道行仍在");
    assert.equal(Number(after.created_here), 1);

    // 抽屉的分组与模型点选数据：/api/group/ 与 /api/pricing
    const { getGateway } = await import("./gateways.ts");
    const { fetchGatewayGroups, fetchGatewayModels } = await import("./upstream.ts");
    const secret = await getGateway(gateway.id);
    assert.ok(secret, "网关密钥可读");
    assert.deepEqual(await fetchGatewayGroups(secret!), ["default", "vip", "svip"]);
    assert.deepEqual(await fetchGatewayModels(secret!), [
      { name: "gpt-4o", groups: ["default"] },
      { name: "gpt-4o-mini", groups: ["default", "vip"] },
    ]);
  } finally {
    server.close();
  }
});
