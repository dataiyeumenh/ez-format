import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./DashboardPage.jsx", import.meta.url), "utf8");

test("admin dashboard shows today's website visits", () => {
  assert.match(source, /stats\.visitsToday\?\.value/);
  assert.match(source, /LƯỢT TRUY CẬP HÔM NAY/);
});

test("admin dashboard charts all-time website traffic", () => {
  assert.match(source, /visitsByDay/);
  assert.match(source, /Lượt truy cập website/);
  assert.match(source, /Từ 01\/05\/2026 đến nay/);
  assert.match(source, /dataKey="visits"/);
  assert.match(source, /totalVisits/);
});
