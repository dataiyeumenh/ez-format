const assert = require("node:assert/strict");
const test = require("node:test");

const User = require("../models/User");
const {
  buildCumulativeUserSeries,
  formatPeriodKey,
  normalizeUserGrowthRange,
} = require("../services/userGrowthService");
const { getUserGrowth } = require("../controllers/adminController");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("normalizes supported user growth ranges", () => {
  assert.equal(normalizeUserGrowthRange("30d"), "30d");
  assert.equal(normalizeUserGrowthRange("90d"), "90d");
  assert.equal(normalizeUserGrowthRange("all"), "all");
  assert.equal(normalizeUserGrowthRange("unsupported"), "30d");
});

test("builds a gap-free cumulative daily user series", () => {
  const points = buildCumulativeUserSeries({
    start: new Date("2026-08-01T17:00:00.000Z"),
    endExclusive: new Date("2026-08-04T17:00:00.000Z"),
    granularity: "day",
    baseline: 2,
    registrations: [
      { _id: "2026-08-02", count: 1 },
      { _id: "2026-08-04", count: 2 },
    ],
  });

  assert.deepEqual(points, [
    { date: "2026-08-02", total: 3 },
    { date: "2026-08-03", total: 3 },
    { date: "2026-08-04", total: 5 },
  ]);
});

test("builds cumulative monthly points for the all-time range", () => {
  const points = buildCumulativeUserSeries({
    start: new Date("2026-01-31T17:00:00.000Z"),
    endExclusive: new Date("2026-04-30T17:00:00.000Z"),
    granularity: "month",
    baseline: 0,
    registrations: [
      { _id: "2026-02", count: 4 },
      { _id: "2026-04", count: 3 },
    ],
  });

  assert.deepEqual(points, [
    { date: "2026-02", total: 4 },
    { date: "2026-03", total: 4 },
    { date: "2026-04", total: 7 },
  ]);
});

test("admin user growth endpoint returns 30 cumulative daily points", async () => {
  const originalCount = User.countDocuments;
  const originalAggregate = User.aggregate;
  const today = formatPeriodKey(new Date(), "day");

  User.countDocuments = async (filter) => {
    assert.ok(filter.createdAt.$lt instanceof Date);
    return 10;
  };
  User.aggregate = async (pipeline) => {
    assert.equal(pipeline[1].$group._id.$dateToString.timezone, "+07:00");
    return [{ _id: today, count: 2 }];
  };

  try {
    const res = createResponse();
    await getUserGrowth({ query: { range: "30d" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.range, "30d");
    assert.equal(res.body.granularity, "day");
    assert.equal(res.body.points.length, 30);
    assert.equal(res.body.points.at(-1).total, 12);
  } finally {
    User.countDocuments = originalCount;
    User.aggregate = originalAggregate;
  }
});

test("admin router exposes the user growth endpoint", () => {
  const router = require("../routes/admin");
  const route = router.stack.find(
    (layer) => layer.route?.path === "/users/growth",
  );
  assert.ok(route);
  assert.deepEqual(Object.keys(route.route.methods), ["get"]);
});
