const assert = require("node:assert/strict");
const test = require("node:test");

const {
  vnDateString,
  normalizeDailyFileCredit,
  deductConversionCredit,
} = require("../services/subscriptionService");

test("vnDateString trả ngày theo giờ Việt Nam (UTC+7)", () => {
  // 2026-06-15T18:00:00Z -> VN 2026-06-16T01:00 -> 2026-06-16
  assert.equal(vnDateString(new Date("2026-06-15T18:00:00.000Z")), "2026-06-16");
  // 2026-06-15T16:00:00Z -> VN 2026-06-15T23:00 -> 2026-06-15
  assert.equal(vnDateString(new Date("2026-06-15T16:00:00.000Z")), "2026-06-15");
});

test("normalizeDailyFileCredit reset về 1 khi sang ngày VN mới", () => {
  const now = new Date("2026-06-16T03:00:00.000Z");
  const user = { dailyFileCredit: 0, dailyFileCreditDate: "2026-06-15" };
  normalizeDailyFileCredit(user, now);
  assert.equal(user.dailyFileCredit, 1);
  assert.equal(user.dailyFileCreditDate, vnDateString(now));
});

test("normalizeDailyFileCredit giữ nguyên trong cùng ngày VN", () => {
  const now = new Date("2026-06-16T03:00:00.000Z");
  const today = vnDateString(now);
  const user = { dailyFileCredit: 0, dailyFileCreditDate: today };
  normalizeDailyFileCredit(user, now);
  assert.equal(user.dailyFileCredit, 0); // không reset
});

test("deduct: Free trừ dailyFileCredit", () => {
  const user = { plan: "Free", dailyFileCredit: 1, fileCredits: 0 };
  const managed = deductConversionCredit(user);
  assert.equal(managed, true);
  assert.equal(user.dailyFileCredit, 0);
});

test("deduct: Free hết lượt thì giữ 0", () => {
  const user = { plan: "Free", dailyFileCredit: 0, fileCredits: 0 };
  deductConversionCredit(user);
  assert.equal(user.dailyFileCredit, 0);
});

test("deduct: PerFile ưu tiên trừ dailyFileCredit trước", () => {
  const user = { plan: { code: "perfile" }, dailyFileCredit: 1, fileCredits: 5 };
  deductConversionCredit(user);
  assert.equal(user.dailyFileCredit, 0);
  assert.equal(user.fileCredits, 5);
});

test("deduct: PerFile hết daily thì trừ fileCredits", () => {
  const user = { plan: { code: "perfile" }, dailyFileCredit: 0, fileCredits: 5 };
  deductConversionCredit(user);
  assert.equal(user.dailyFileCredit, 0);
  assert.equal(user.fileCredits, 4);
});

test("deduct: plan trả phí (monthly) không bị trừ", () => {
  const user = { plan: { code: "monthly" }, dailyFileCredit: 1, fileCredits: 0 };
  const managed = deductConversionCredit(user);
  assert.equal(managed, false);
  assert.equal(user.dailyFileCredit, 1);
});
