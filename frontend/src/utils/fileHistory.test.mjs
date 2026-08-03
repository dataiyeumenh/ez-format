import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_HISTORY_COLUMNS,
  formatFileHistoryDate,
} from "./fileHistory.js";

test("file conversion history has six data columns without actions", () => {
  assert.deepEqual(FILE_HISTORY_COLUMNS, [
    "NGƯỜI DÙNG",
    "TÊN FILE",
    "ĐỊNH DẠNG",
    "KÍCH THƯỚC",
    "TRẠNG THÁI",
    "NGÀY",
  ]);
});

test("file conversion history displays only the Vietnam calendar date", () => {
  assert.equal(formatFileHistoryDate("2026-08-03T18:30:00.000Z"), "04/08/2026");
  assert.equal(formatFileHistoryDate(null), "—");
  assert.equal(formatFileHistoryDate("invalid"), "—");
});
