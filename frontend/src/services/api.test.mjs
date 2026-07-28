import assert from "node:assert/strict";
import test from "node:test";

import { normalizeApiBaseURL, shouldLogoutForUnauthorized } from "./api.js";

test("API base URL appends exactly one terminal api segment", () => {
  assert.equal(normalizeApiBaseURL(), "/api");
  assert.equal(normalizeApiBaseURL("https://node.example"), "https://node.example/api");
  assert.equal(normalizeApiBaseURL("https://node.example/"), "https://node.example/api");
  assert.equal(normalizeApiBaseURL("https://node.example/api"), "https://node.example/api");
  assert.equal(normalizeApiBaseURL("https://node.example/api/"), "https://node.example/api");
});

test("recoverable converter context expiry does not trigger global logout", () => {
  assert.equal(
    shouldLogoutForUnauthorized({
      response: { status: 401 },
      config: {
        url: "/converter/conversions/export",
        allowConverterContextRefresh: true,
      },
    }),
    false,
  );
  assert.equal(
    shouldLogoutForUnauthorized({
      response: { status: 401 },
      config: { url: "/converter/conversions/export" },
    }),
    true,
  );
  assert.equal(
    shouldLogoutForUnauthorized({
      response: { status: 401 },
      config: { url: "/files", allowConverterContextRefresh: true },
    }),
    true,
  );
  assert.equal(
    shouldLogoutForUnauthorized({
      response: { status: 401 },
      config: { url: "/auth/login" },
    }),
    false,
  );
});
