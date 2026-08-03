import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
const layoutSource = readFileSync(
  new URL("../../components/admin/AdminLayout.jsx", import.meta.url),
  "utf8",
);

test("admin navigation exposes the notices management route", () => {
  assert.match(appSource, /path="\/admin\/notices"/);
  assert.match(layoutSource, /label: "Thông báo", path: "\/admin\/notices"/);
  assert.doesNotMatch(layoutSource, />\s*3\s*<\/span>/);
});
