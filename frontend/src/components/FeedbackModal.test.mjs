import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./FeedbackModal.jsx", import.meta.url), "utf8");

test("feedback modal exposes submit and own-history tabs", () => {
  assert.match(source, /Gửi góp ý/);
  assert.match(source, /Góp ý của tôi/);
  assert.match(source, /fetchMyFeedback\(/);
  assert.match(source, /Đang tải góp ý/);
  assert.match(source, /Bạn chưa gửi góp ý nào/);
  assert.match(source, /Không thể tải góp ý của bạn/);
});

test("own feedback history renders date and workflow status metadata", () => {
  assert.match(source, /formatFeedbackDate\(item\.createdAt\)/);
  assert.match(source, /getFeedbackStatusMeta\(item\.status\)/);
  assert.match(source, /item\.categoryLabel/);
});

test("resolved feedback supports an editable satisfaction rating", () => {
  assert.match(source, /item\.status === "resolved"/);
  assert.match(source, /FEEDBACK_RATINGS/);
  assert.match(source, /rateFeedback\(item\.id, rating\.value\)/);
  assert.match(source, /Bạn hài lòng với cách xử lý góp ý này không\?/);
});
