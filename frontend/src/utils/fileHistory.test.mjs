import assert from "node:assert/strict";
import test from "node:test";

import { FILE_HISTORY_COLUMNS } from "./fileHistory.js";

test("file conversion history has six data columns without actions", () => {
  assert.deepEqual(FILE_HISTORY_COLUMNS, [
    "NGƯỜI DÙNG",
    "TÊN FILE",
    "ĐỊNH DẠNG",
    "KÍCH THƯỚC",
    "TRẠNG THÁI",
    "NGÀY & GIỜ",
  ]);
});
