import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeApiBaseURL } from "./api.js";

test("API base prefers VITE_API_URL and appends exactly one api segment", () => {
  assert.equal(normalizeApiBaseURL(), "/api");
  assert.equal(normalizeApiBaseURL("https://node.example"), "https://node.example/api");
  assert.equal(normalizeApiBaseURL("https://node.example/api/"), "https://node.example/api");
});

test("browser API boundary contains no direct FastAPI configuration", async () => {
  const source = await readFile(new URL("./api.js", import.meta.url), "utf8");
  assert.match(source, /VITE_API_URL[\s\S]*\|\|[\s\S]*VITE_NODE_API_URL/);
  assert.doesNotMatch(
    source,
    /VITE_PYTHON_API_URL|\/python-api|localhost:(?:5000|8000)/,
  );
});

test("Vite exposes only the Node proxy and examples do not document direct converter access", async () => {
  const viteConfig = await readFile(new URL("../../vite.config.js", import.meta.url), "utf8");
  const envExample = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
  assert.doesNotMatch(viteConfig, /\/python-api|localhost:8000/);
  assert.doesNotMatch(
    envExample,
    /VITE_PYTHON_API_URL|localhost:(?:5000|8000)/,
  );
});
