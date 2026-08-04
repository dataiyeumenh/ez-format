import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./UsersPage.jsx", import.meta.url), "utf8");

test("admin users page renders cumulative user growth from the API", () => {
  assert.match(source, /api\.get\("\/admin\/users\/growth"/);
  assert.match(source, /Tăng trưởng người dùng/);
  assert.match(source, /Tổng người dùng tích lũy theo thời gian/);
  assert.match(source, /ResponsiveContainer/);
  assert.match(source, /<LineChart/);
  assert.match(source, /dataKey="total"/);
  assert.match(source, /USER_GROWTH_RANGES/);
});

test("user growth chart exposes loading, empty, error, and retry states", () => {
  assert.match(source, /Đang tải dữ liệu tăng trưởng/);
  assert.match(source, /Chưa có dữ liệu người dùng/);
  assert.match(source, /Không thể tải dữ liệu tăng trưởng/);
  assert.match(source, /Thử lại/);
});
