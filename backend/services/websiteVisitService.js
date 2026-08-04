const WebsiteVisit = require("../models/WebsiteVisit");

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const WEBSITE_LAUNCH_DATE = "2026-05-01";

function toVietnamDateKey(value = new Date()) {
  const shifted = new Date(new Date(value).getTime() + VIETNAM_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function parseDateKey(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Invalid date key: ${text}`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`Invalid date key: ${text}`);
  }
  return date;
}

function addDateKeyDays(dateKey, days) {
  const date = parseDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildDailyVisitSeries({ startDateKey, endDateKey, rows = [] }) {
  if (startDateKey > endDateKey) return [];
  parseDateKey(startDateKey);
  parseDateKey(endDateKey);

  const countByDate = new Map(
    rows.map((row) => [String(row.dateKey), Math.max(0, Number(row.count) || 0)]),
  );
  const points = [];
  for (let dateKey = startDateKey; dateKey <= endDateKey; dateKey = addDateKeyDays(dateKey, 1)) {
    points.push({ date: dateKey, visits: countByDate.get(dateKey) || 0 });
  }
  return points;
}

function summarizeWebsiteVisits({
  todayDateKey,
  launchDateKey = WEBSITE_LAUNCH_DATE,
  rows = [],
}) {
  const visitsByDay = buildDailyVisitSeries({
    startDateKey: launchDateKey,
    endDateKey: todayDateKey,
    rows,
  });
  const visitsYesterdayDateKey = addDateKeyDays(todayDateKey, -1);
  const countByDate = new Map(
    rows.map((row) => [String(row.dateKey), Math.max(0, Number(row.count) || 0)]),
  );

  return {
    visitsToday: countByDate.get(todayDateKey) || 0,
    visitsYesterday: countByDate.get(visitsYesterdayDateKey) || 0,
    totalVisits: visitsByDay.reduce((sum, point) => sum + point.visits, 0),
    visitsByDay,
  };
}

function deterministicCount(dateKey) {
  if (dateKey < "2026-05-26") return 0;
  if (dateKey <= "2026-05-31") {
    return [2, 3, 2, 3, 2, 3][Number(dateKey.slice(-2)) - 26];
  }
  if (dateKey === "2026-06-01") return 54;
  if (dateKey === "2026-07-02") return 57;
  if (dateKey === "2026-06-15") return 17;
  if (dateKey === "2026-07-16") return 18;

  const ordinal = Math.floor(parseDateKey(dateKey).getTime() / 86400000);
  if (ordinal % 9 === 0 || ordinal % 13 === 0) return 3 + (ordinal % 5);
  return 10 + (ordinal % 11);
}

function buildSeedVisits(endDateKey = "2026-08-05") {
  parseDateKey(endDateKey);
  if (endDateKey < WEBSITE_LAUNCH_DATE) return [];

  return buildDailyVisitSeries({
    startDateKey: WEBSITE_LAUNCH_DATE,
    endDateKey,
  }).map(({ date }) => ({ dateKey: date, count: deterministicCount(date) }));
}

async function recordWebsiteVisit(now = new Date()) {
  const dateKey = toVietnamDateKey(now);
  try {
    const visit = await WebsiteVisit.findOneAndUpdate(
      { dateKey },
      { $inc: { count: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { dateKey: visit.dateKey, count: visit.count };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const visit = await WebsiteVisit.findOneAndUpdate(
      { dateKey },
      { $inc: { count: 1 } },
      { new: true },
    );
    return { dateKey: visit.dateKey, count: visit.count };
  }
}

module.exports = {
  WEBSITE_LAUNCH_DATE,
  addDateKeyDays,
  buildDailyVisitSeries,
  buildSeedVisits,
  recordWebsiteVisit,
  summarizeWebsiteVisits,
  toVietnamDateKey,
};
