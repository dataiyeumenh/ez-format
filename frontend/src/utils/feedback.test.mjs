import assert from "node:assert/strict";
import test from "node:test";

import {
  FEEDBACK_RATINGS,
  FEEDBACK_STATUSES,
  formatFeedbackDate,
  getFeedbackRatingMeta,
  getFeedbackStatusMeta,
} from "./feedback.js";

test("formats feedback date in Vietnam without time", () => {
  assert.equal(
    formatFeedbackDate("2026-08-03T18:30:00.000Z"),
    "04/08/2026",
  );
  assert.equal(formatFeedbackDate(null), "—");
  assert.equal(formatFeedbackDate("invalid"), "—");
});

test("exposes approved feedback statuses and safe fallback", () => {
  assert.deepEqual(
    FEEDBACK_STATUSES.map(({ value, label }) => ({ value, label })),
    [
      { value: "new", label: "Mới" },
      { value: "received", label: "Đã tiếp nhận" },
      { value: "in_progress", label: "Đang xử lý" },
      { value: "resolved", label: "Đã giải quyết" },
      { value: "rejected", label: "Không thực hiện" },
    ],
  );
  assert.equal(getFeedbackStatusMeta("resolved").label, "Đã giải quyết");
  assert.equal(getFeedbackStatusMeta("unsupported").value, "new");
});

test("exposes the approved user satisfaction ratings", () => {
  assert.deepEqual(
    FEEDBACK_RATINGS.map(({ value, label }) => ({ value, label })),
    [
      { value: "satisfied", label: "Hài lòng" },
      { value: "very_satisfied", label: "Vô cùng hài lòng" },
      { value: "dissatisfied", label: "Chưa hài lòng" },
    ],
  );
  assert.equal(getFeedbackRatingMeta("very_satisfied").label, "Vô cùng hài lòng");
  assert.equal(getFeedbackRatingMeta("unsupported"), null);
});
