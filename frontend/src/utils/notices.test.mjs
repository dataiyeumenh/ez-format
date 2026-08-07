import assert from "node:assert/strict";
import test from "node:test";

import {
  formatNoticeDate,
  formatUnreadCount,
  getNoticeListParams,
  normalizeNoticeForm,
} from "./notices.js";

test("builds admin notice list params for each supported tab", () => {
  assert.deepEqual(getNoticeListParams("broadcast"), {
    limit: 50,
    scope: "broadcast",
  });
  assert.deepEqual(getNoticeListParams("individual"), {
    limit: 50,
    scope: "individual",
  });
  assert.deepEqual(getNoticeListParams("unexpected"), {
    limit: 50,
    scope: "broadcast",
  });
});

test("normalizes a notice form for the API", () => {
  assert.deepEqual(
    normalizeNoticeForm({
      title: "  Bảo trì hệ thống  ",
      description: "  Hệ thống bảo trì lúc 22:00.  ",
    }),
    {
      title: "Bảo trì hệ thống",
      description: "Hệ thống bảo trì lúc 22:00.",
    },
  );
});

test("rejects blank and oversized notice forms", () => {
  assert.throws(
    () => normalizeNoticeForm({ title: "", description: "Nội dung" }),
    /Tiêu đề.*bắt buộc/,
  );
  assert.throws(
    () => normalizeNoticeForm({ title: "Tin", description: "A".repeat(1001) }),
    /1000 ký tự/,
  );
});

test("formats notice date in Vietnam without time", () => {
  assert.equal(
    formatNoticeDate("2026-08-03T18:30:00.000Z"),
    "04/08/2026",
  );
  assert.equal(formatNoticeDate("invalid"), "—");
});

test("formats the unread badge without overflowing the bell", () => {
  assert.equal(formatUnreadCount(1), "1");
  assert.equal(formatUnreadCount(99), "99");
  assert.equal(formatUnreadCount(100), "99+");
  assert.equal(formatUnreadCount(-1), "0");
});
