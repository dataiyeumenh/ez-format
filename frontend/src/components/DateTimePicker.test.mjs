import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pickerSource = readFileSync(
  new URL("./DateTimePicker.jsx", import.meta.url),
  "utf8",
);
const couponSource = readFileSync(
  new URL("../pages/admin/CouponsPage.jsx", import.meta.url),
  "utf8",
);

test("datetime picker exposes calendar, time, year, Today, and dialog controls", () => {
  assert.match(pickerSource, /role="dialog"/);
  assert.match(pickerSource, /aria-label="Chọn tháng"/);
  assert.match(pickerSource, /aria-label="Chọn năm"/);
  assert.match(pickerSource, /Giờ/);
  assert.match(pickerSource, /Phút/);
  assert.match(pickerSource, /Hôm nay/);
  assert.match(pickerSource, /Hủy/);
  assert.match(pickerSource, /Áp dụng/);
});

test("mobile footer keeps Today beside the cancel and apply actions", () => {
  assert.doesNotMatch(pickerSource, /flex-col-reverse/);
  assert.match(pickerSource, /grid-cols-\[auto_1fr\]/);
});

test("coupon form replaces every native datetime-local input", () => {
  assert.doesNotMatch(couponSource, /type="datetime-local"/);
  assert.match(couponSource, /import DateTimePicker/);
  assert.equal((couponSource.match(/<DateTimePicker/g) || []).length, 2);
});
