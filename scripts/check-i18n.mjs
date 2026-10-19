import { readFileSync } from "node:fs";

function flatten(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

const zh = flatten(JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url), "utf8")));
const en = flatten(JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8")));
const missingEn = [...zh.keys()].filter((key) => !en.has(key));
const missingZh = [...en.keys()].filter((key) => !zh.has(key));
const empty = [...zh.keys(), ...en.keys()].filter((key) => {
  const sample = zh.get(key) ?? en.get(key);
  return typeof sample !== "string" || sample.trim() === "";
});
if (missingEn.length || missingZh.length || empty.length) {
  if (missingEn.length) console.error(`en is missing: ${missingEn.join(", ")}`);
  if (missingZh.length) console.error(`zh-CN is missing: ${missingZh.join(", ")}`);
  if (empty.length) console.error(`empty messages: ${[...new Set(empty)].join(", ")}`);
  process.exit(1);
}
console.log(`i18n keys match (${zh.size})`);
