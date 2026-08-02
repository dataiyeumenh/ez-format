import assert from "node:assert/strict";
import test from "node:test";

import { formatRevenueDate } from "./revenue.js";

test("formats revenue dates as Vietnamese calendar dates without time", () => {
  assert.equal(formatRevenueDate("2026-08-02T18:30:00.000Z"), "03/08/2026");
});

test("returns a dash for missing or invalid dates", () => {
  assert.equal(formatRevenueDate(null), "—");
  assert.equal(formatRevenueDate("not-a-date"), "—");
});
