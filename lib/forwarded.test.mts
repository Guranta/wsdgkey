import assert from "node:assert/strict";
import test from "node:test";
import { cookieSecure, requestOrigin } from "./forwarded.ts";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

test("secure cookie follows X-Forwarded-Proto unless COOKIE_SECURE overrides it", () => {
  const previous = process.env.COOKIE_SECURE;
  delete process.env.COOKIE_SECURE;
  assert.equal(cookieSecure(headers({ "x-forwarded-proto": "https" })), true);
  assert.equal(cookieSecure(headers({ "x-forwarded-proto": "https, http" })), true);
  assert.equal(cookieSecure(headers({ "x-forwarded-proto": "http" })), false);
  assert.equal(cookieSecure(headers({})), false);

  process.env.COOKIE_SECURE = "1";
  assert.equal(cookieSecure(headers({})), true);

  process.env.COOKIE_SECURE = "0";
  assert.equal(cookieSecure(headers({ "x-forwarded-proto": "https" })), false);

  if (previous === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = previous;
});

test("redirect origin uses the forwarded host and protocol", () => {
  const request = {
    headers: headers({
      host: "127.0.0.1:3000",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "new.886668.shop",
    }),
    nextUrl: { protocol: "http:", host: "0.0.0.0:3000", origin: "http://0.0.0.0:3000" },
  };
  assert.equal(requestOrigin(request), "https://new.886668.shop");

  const direct = {
    headers: headers({ host: "127.0.0.1:3000" }),
    nextUrl: { protocol: "https:", host: "0.0.0.0:3000", origin: "https://0.0.0.0:3000" },
  };
  assert.equal(requestOrigin(direct), "http://127.0.0.1:3000");
});
