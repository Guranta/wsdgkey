import assert from "node:assert/strict";
import test from "node:test";
import { negotiateLocale, resolveLocale } from "./locale.ts";

test("Accept-Language picks zh or en and falls back to zh-CN", () => {
  assert.equal(negotiateLocale("zh-CN,zh;q=0.9,en;q=0.8"), "zh-CN");
  assert.equal(negotiateLocale("zh-TW,en;q=0.5"), "zh-CN");
  assert.equal(negotiateLocale("en-US,en;q=0.9"), "en");
  assert.equal(negotiateLocale("fr-FR,de;q=0.8"), "zh-CN");
  assert.equal(negotiateLocale("fr;q=0.9,en;q=0.8,zh;q=0.1"), "en");
  assert.equal(negotiateLocale(""), "zh-CN");
  assert.equal(negotiateLocale(null), "zh-CN");
});

test("a saved choice overrides Accept-Language", () => {
  assert.equal(resolveLocale("zh-CN", "en-US,en;q=0.9"), "zh-CN");
  assert.equal(resolveLocale("en", "zh-CN,zh;q=0.9"), "en");
  assert.equal(resolveLocale(null, "en-GB"), "en");
  assert.equal(resolveLocale(undefined, "ja,zh;q=0.8"), "zh-CN");
  assert.equal(resolveLocale("nope", "fr"), "zh-CN");
});
