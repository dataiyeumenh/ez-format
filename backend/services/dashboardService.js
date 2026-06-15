const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // Việt Nam = UTC+7
const DAY_MS = 24 * 60 * 60 * 1000;

function vnParts(date) {
  const vn = new Date(date.getTime() + VN_OFFSET_MS);
  return {
    y: vn.getUTCFullYear(),
    m: vn.getUTCMonth(),
    d: vn.getUTCDate(),
    weekday: vn.getUTCDay(),
  };
}

// Mốc UTC tương ứng nửa đêm (giờ VN) của ngày chứa `date`.
function vnStartOfDay(date = new Date()) {
  const { y, m, d } = vnParts(date);
  return new Date(Date.UTC(y, m, d) - VN_OFFSET_MS);
}

// Mốc UTC tương ứng đầu tháng (giờ VN) của tháng chứa `date`.
function vnStartOfMonth(date = new Date()) {
  const { y, m } = vnParts(date);
  return new Date(Date.UTC(y, m, 1) - VN_OFFSET_MS);
}

// Đầu tháng trước (giờ VN).
function vnStartOfPrevMonth(date = new Date()) {
  const { y, m } = vnParts(date);
  return new Date(Date.UTC(y, m - 1, 1) - VN_OFFSET_MS);
}

function addDaysUtc(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

// % thay đổi giữa kỳ hiện tại và kỳ trước (làm tròn). prev=0 -> 100% nếu có tăng, 0 nếu không.
function changePct(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 100);
}

const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

module.exports = {
  VN_OFFSET_MS,
  vnParts,
  vnStartOfDay,
  vnStartOfMonth,
  vnStartOfPrevMonth,
  addDaysUtc,
  changePct,
  WEEKDAY_LABELS,
};
