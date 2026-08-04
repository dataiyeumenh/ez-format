const assert = require("node:assert/strict");
const test = require("node:test");

const WebsiteVisit = require("../models/WebsiteVisit");
const {
  buildDailyVisitSeries,
  buildSeedVisits,
  recordWebsiteVisit,
  summarizeWebsiteVisits,
  toVietnamDateKey,
} = require("../services/websiteVisitService");

test("website visit model stores one aggregate per Vietnam date", () => {
  assert.equal(WebsiteVisit.schema.path("dateKey").options.required, true);
  assert.equal(WebsiteVisit.schema.path("dateKey").options.unique, true);
  assert.equal(WebsiteVisit.schema.path("count").options.min, 0);
});

test("creates Vietnam date keys at the UTC day boundary", () => {
  assert.equal(
    toVietnamDateKey(new Date("2026-08-04T16:59:59.000Z")),
    "2026-08-04",
  );
  assert.equal(
    toVietnamDateKey(new Date("2026-08-04T17:00:00.000Z")),
    "2026-08-05",
  );
});

test("records a visit with an atomic daily upsert", async () => {
  const originalFindOneAndUpdate = WebsiteVisit.findOneAndUpdate;
  WebsiteVisit.findOneAndUpdate = async (filter, update, options) => {
    assert.deepEqual(filter, { dateKey: "2026-08-05" });
    assert.deepEqual(update, { $inc: { count: 1 } });
    assert.equal(options.upsert, true);
    return { dateKey: "2026-08-05", count: 4 };
  };

  try {
    assert.deepEqual(
      await recordWebsiteVisit(new Date("2026-08-04T17:30:00.000Z")),
      { dateKey: "2026-08-05", count: 4 },
    );
  } finally {
    WebsiteVisit.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("builds a gap-free daily visit series", () => {
  assert.deepEqual(
    buildDailyVisitSeries({
      startDateKey: "2026-05-01",
      endDateKey: "2026-05-04",
      rows: [
        { dateKey: "2026-05-02", count: 3 },
        { dateKey: "2026-05-04", count: 2 },
      ],
    }),
    [
      { date: "2026-05-01", visits: 0 },
      { date: "2026-05-02", visits: 3 },
      { date: "2026-05-03", visits: 0 },
      { date: "2026-05-04", visits: 2 },
    ],
  );
});

test("summarizes today, yesterday, total, and all-time chart data", () => {
  const summary = summarizeWebsiteVisits({
    todayDateKey: "2026-05-04",
    launchDateKey: "2026-05-01",
    rows: [
      { dateKey: "2026-05-02", count: 3 },
      { dateKey: "2026-05-03", count: 4 },
      { dateKey: "2026-05-04", count: 5 },
    ],
  });

  assert.equal(summary.visitsToday, 5);
  assert.equal(summary.visitsYesterday, 4);
  assert.equal(summary.totalVisits, 12);
  assert.deepEqual(summary.visitsByDay[0], { date: "2026-05-01", visits: 0 });
  assert.equal(summary.visitsByDay.length, 4);
});

test("generates the approved deterministic showcase traffic", () => {
  const rows = buildSeedVisits("2026-08-05");
  const byDate = new Map(rows.map((row) => [row.dateKey, row.count]));

  assert.equal(rows[0].dateKey, "2026-05-01");
  assert.equal(rows.at(-1).dateKey, "2026-08-05");
  assert.equal(byDate.get("2026-05-01"), 0);
  assert.equal(byDate.get("2026-05-20"), 0);
  assert.ok([2, 3].includes(byDate.get("2026-05-31")));
  assert.ok(byDate.get("2026-06-01") > 50);
  assert.ok(byDate.get("2026-07-02") > 50);
  assert.ok(byDate.get("2026-06-15") >= 15 && byDate.get("2026-06-15") <= 20);
  assert.ok(byDate.get("2026-07-16") >= 15 && byDate.get("2026-07-16") <= 20);

  const regularRows = rows.filter(
    ({ dateKey }) => dateKey >= "2026-06-01" &&
      !["2026-06-01", "2026-07-02", "2026-06-15", "2026-07-16"].includes(dateKey),
  );
  assert.ok(regularRows.some(({ count }) => count >= 3 && count <= 7));
  assert.ok(regularRows.some(({ count }) => count >= 10 && count <= 20));
  assert.ok(regularRows.every(({ count }) =>
    (count >= 3 && count <= 7) || (count >= 10 && count <= 20),
  ));
});

test("public analytics router exposes only the visit recording endpoint", () => {
  const router = require("../routes/analytics");
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods),
    }));

  assert.deepEqual(routes, [{ path: "/visit", methods: ["post"] }]);
});
