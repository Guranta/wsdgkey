import assert from "node:assert/strict";
import test from "node:test";
import { safeLogLine, scrubSecrets, scrubStream } from "./redact.ts";

test("removes bearer values, sk tokens, and an explicit secret", () => {
  const secret = "nk-example-token-value";
  const input = `Authorization: Bearer ${secret}\nkey=sk-abcdefghijklmnopqrstuvwxyz`;
  const output = scrubSecrets(input, [secret]);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(output, /Bearer \[redacted\]/);
  assert.match(output, /sk-\[redacted\]/);
});

test("log lines drop query strings and sk-looking hosts", () => {
  const line = safeLogLine(401, "sk-abcdefghijklmnopqrstuvwxyz.example.com", "v1/models?api_key=sekret");
  assert.equal(line.includes("sekret"), false);
  assert.equal(line.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(line, /^\[proxy\] 401 /);
});

test("stream scrubber redacts a token split across chunks", async () => {
  const secret = "sk-testtokenvalue";
  const raw = `data: hello ${secret} world\n\n`;
  const bytes = new TextEncoder().encode(raw);
  const splitAt = raw.indexOf("test") + 2;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, splitAt));
      controller.enqueue(bytes.slice(splitAt));
      controller.close();
    },
  });
  const output = await new Response(scrubStream(stream, [secret])).text();
  assert.equal(output.includes(secret), false);
  assert.match(output, /\[redacted\]/);
});
