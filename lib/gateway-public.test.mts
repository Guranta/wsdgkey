import assert from "node:assert/strict";
import test from "node:test";
import { publicGateway } from "./gateways.ts";

test("gateway responses keep only a mask of the admin token", () => {
  const raw = "sk-fake-admin-token-99";
  const published = publicGateway({
    id: "gw",
    name: "主站",
    baseUrl: "https://example.com",
    adminUserId: "1",
    demo: false,
    tokenSet: true,
    tokenMasked: "",
    createdAt: 1,
    token: raw,
  });
  assert.equal("token" in published, false);
  assert.equal(published.tokenMasked.includes(raw), false);
  assert.equal(published.tokenMasked.startsWith("sk-"), true);
  assert.equal(published.tokenMasked.endsWith("n-99"), true);
  const demo = publicGateway({ ...published, demo: true, tokenSet: true, token: raw });
  assert.equal(demo.tokenMasked, "");
});
