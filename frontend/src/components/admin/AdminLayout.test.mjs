import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AdminLayout.jsx", import.meta.url), "utf8");

test("admin chrome omits unused search, profile, settings, and storage controls", () => {
  assert.doesNotMatch(source, /Search by name, email or ID/);
  assert.doesNotMatch(source, /to="\/admin\/profile"/);
  assert.doesNotMatch(source, /to="\/admin\/settings"/);
  assert.doesNotMatch(source, /DUNG LƯỢNG LƯU TRỮ/);
});
