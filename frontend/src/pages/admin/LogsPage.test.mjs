import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./LogsPage.jsx", import.meta.url), "utf8");

test("admin feedback page filters and updates workflow status", () => {
  assert.match(source, /FEEDBACK_STATUSES/);
  assert.match(source, /status: statusFilter \|\| undefined/);
  assert.match(source, /updateAdminFeedbackStatus\(item\.id, nextStatus\)/);
  assert.match(source, /"TRẠNG THÁI"/);
  assert.match(source, /Tất cả trạng thái/);
});

test("feedback CSV includes workflow status", () => {
  assert.match(source, /"Trạng thái"/);
  assert.match(source, /getFeedbackStatusMeta\(row\.status\)\.label/);
  assert.match(source, /"Đánh giá"/);
  assert.match(source, /getFeedbackRatingMeta\(row\.rating\)/);
});

test("admin feedback table shows the user's rating", () => {
  assert.match(source, /"ĐÁNH GIÁ"/);
  assert.match(source, /Chưa đánh giá/);
});
