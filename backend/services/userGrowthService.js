const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const VALID_RANGES = new Set(["30d", "90d", "all"]);

function normalizeUserGrowthRange(value) {
  return VALID_RANGES.has(value) ? value : "30d";
}

function shiftedParts(value) {
  const shifted = new Date(new Date(value).getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function startOfVietnamDay(value) {
  const { year, month, day } = shiftedParts(value);
  return new Date(Date.UTC(year, month, day) - VN_OFFSET_MS);
}

function startOfVietnamMonth(value) {
  const { year, month } = shiftedParts(value);
  return new Date(Date.UTC(year, month, 1) - VN_OFFSET_MS);
}

function addPeriod(value, granularity) {
  if (granularity === "day") {
    return new Date(new Date(value).getTime() + 24 * 60 * 60 * 1000);
  }
  const { year, month } = shiftedParts(value);
  return new Date(Date.UTC(year, month + 1, 1) - VN_OFFSET_MS);
}

function formatPeriodKey(value, granularity) {
  const { year, month, day } = shiftedParts(value);
  const monthText = String(month + 1).padStart(2, "0");
  if (granularity === "month") return `${year}-${monthText}`;
  return `${year}-${monthText}-${String(day).padStart(2, "0")}`;
}

function buildCumulativeUserSeries({
  start,
  endExclusive,
  granularity,
  baseline = 0,
  registrations = [],
}) {
  const counts = new Map(
    registrations.map((item) => [String(item._id), Number(item.count) || 0]),
  );
  const points = [];
  let total = Number(baseline) || 0;

  for (
    let cursor = new Date(start);
    cursor < endExclusive;
    cursor = addPeriod(cursor, granularity)
  ) {
    const date = formatPeriodKey(cursor, granularity);
    total += counts.get(date) || 0;
    points.push({ date, total });
  }

  return points;
}

module.exports = {
  addPeriod,
  buildCumulativeUserSeries,
  formatPeriodKey,
  normalizeUserGrowthRange,
  startOfVietnamDay,
  startOfVietnamMonth,
};
