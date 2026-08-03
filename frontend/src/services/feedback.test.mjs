import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./feedback.js", import.meta.url), "utf8");

test("feedback API client supports own history, admin status filter, and updates", () => {
  assert.match(source, /api\.get\("\/feedback\/mine"/);
  assert.match(source, /status: status \|\| undefined/);
  assert.match(source, /api\.patch\(`\/admin\/feedback\/\$\{id\}\/status`/);
  assert.match(source, /api\.patch\(`\/feedback\/\$\{id\}\/rating`/);
});
