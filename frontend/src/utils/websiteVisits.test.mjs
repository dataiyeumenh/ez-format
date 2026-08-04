import assert from "node:assert/strict";
import test from "node:test";

import { formatVisitChartDate } from "./websiteVisits.js";

test("formats website traffic dates without timezone drift", () => {
  assert.equal(formatVisitChartDate("2026-05-01"), "01/05");
  assert.equal(formatVisitChartDate("2026-08-05", true), "05/08/2026");
  assert.equal(formatVisitChartDate("invalid"), "—");
});
