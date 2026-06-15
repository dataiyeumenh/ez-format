const assert = require("node:assert/strict");
const test = require("node:test");

const {
  vnStartOfDay,
  vnStartOfMonth,
  vnStartOfPrevMonth,
  addDaysUtc,
  changePct,
  vnParts,
} = require("../services/dashboardService");

test("changePct tính % thay đổi và xử lý prev=0", () => {
  assert.equal(changePct(120, 100), 20);
  assert.equal(changePct(80, 100), -20);
  assert.equal(changePct(5, 0), 100); // từ 0 lên có giá trị
  assert.equal(changePct(0, 0), 0);
});

test("vnStartOfDay trả nửa đêm giờ VN (= 17:00 UTC hôm trước)", () => {
  // 2026-06-16T03:00:00Z là 10:00 sáng giờ VN ngày 16/06
  const start = vnStartOfDay(new Date("2026-06-16T03:00:00.000Z"));
  assert.equal(start.toISOString(), "2026-06-15T17:00:00.000Z");
});

test("vnStartOfDay với thời điểm sát nửa đêm VN", () => {
  // 2026-06-15T17:30:00Z = 00:30 ngày 16/06 giờ VN -> đầu ngày 16/06
  const start = vnStartOfDay(new Date("2026-06-15T17:30:00.000Z"));
  assert.equal(start.toISOString(), "2026-06-15T17:00:00.000Z");
});

test("vnStartOfMonth và vnStartOfPrevMonth", () => {
  const now = new Date("2026-06-16T03:00:00.000Z"); // tháng 6 giờ VN
  assert.equal(vnStartOfMonth(now).toISOString(), "2026-05-31T17:00:00.000Z"); // 01/06 VN
  assert.equal(vnStartOfPrevMonth(now).toISOString(), "2026-04-30T17:00:00.000Z"); // 01/05 VN
});

test("addDaysUtc cộng đúng số ngày", () => {
  const base = new Date("2026-06-15T17:00:00.000Z");
  assert.equal(addDaysUtc(base, 1).toISOString(), "2026-06-16T17:00:00.000Z");
  assert.equal(addDaysUtc(base, -6).toISOString(), "2026-06-09T17:00:00.000Z");
});

test("vnParts.weekday đúng theo giờ VN", () => {
  // 2026-06-15 là thứ Hai. 17:00 UTC = 00:00 16/06 VN (thứ Ba = 2)
  assert.equal(vnParts(new Date("2026-06-15T17:00:00.000Z")).weekday, 2);
});
