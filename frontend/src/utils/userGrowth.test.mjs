import assert from "node:assert/strict";
import test from "node:test";

import {
  USER_GROWTH_RANGES,
  formatUserGrowthDate,
} from "./userGrowth.js";

test("exposes the approved user growth ranges", () => {
  assert.deepEqual(USER_GROWTH_RANGES, [
    { value: "30d", label: "30 ngày" },
    { value: "90d", label: "90 ngày" },
    { value: "all", label: "Toàn bộ" },
  ]);
});

test("formats daily and monthly chart labels in Vietnamese", () => {
  assert.equal(formatUserGrowthDate("2026-08-04", "day"), "04/08");
  assert.equal(formatUserGrowthDate("2026-08", "month"), "08/2026");
  assert.equal(formatUserGrowthDate("invalid", "day"), "—");
});
