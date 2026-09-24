import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEndpoint, DEFAULT_BASE_URL, SYSTEM_ONE_PATH } from "../../lib/jev.js";

test("resolveEndpoint: base URLs get /v1/systemone appended", () => {
  assert.equal(resolveEndpoint("https://api.typesafe.ai"), "https://api.typesafe.ai/v1/systemone");
  assert.equal(resolveEndpoint("http://localhost:8787"), "http://localhost:8787/v1/systemone");
  assert.equal(resolveEndpoint("https://api.typesafe.ai/"), "https://api.typesafe.ai/v1/systemone");
});

test("resolveEndpoint: full endpoints (with a path) are used verbatim", () => {
  assert.equal(resolveEndpoint("http://localhost:8787/decide"), "http://localhost:8787/decide");
  assert.equal(resolveEndpoint("https://my.site/proxy/systemone"), "https://my.site/proxy/systemone");
});

test("resolveEndpoint: empty / default fallback", () => {
  assert.equal(resolveEndpoint(""), `${DEFAULT_BASE_URL}${SYSTEM_ONE_PATH}`);
  assert.equal(resolveEndpoint(undefined), `${DEFAULT_BASE_URL}${SYSTEM_ONE_PATH}`);
});