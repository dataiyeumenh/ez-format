const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PLAN_CONFIGS,
  buildPaymentDescription,
  normalizePlanType,
} = require("../services/paymentPlans");
const { applyPaidPlanToUser } = require("../services/subscriptionService");

test("payment plan prices are fixed server-side", () => {
  assert.equal(PLAN_CONFIGS.monthly.amount, 149000);
  assert.equal(PLAN_CONFIGS.yearly.amount, 1308000);
  assert.equal(PLAN_CONFIGS.perfile.amount, 10000);
});

test("normalizes and rejects unknown plan types", () => {
  assert.equal(normalizePlanType("Monthly"), "monthly");
  assert.equal(normalizePlanType(" perfile "), "perfile");
  assert.throws(() => normalizePlanType("free"), /Unsupported plan/);
});

test("payOS descriptions stay short and ascii-safe", () => {
  assert.equal(buildPaymentDescription("monthly"), "EZF monthly");
  assert.ok(buildPaymentDescription("yearly").length <= 25);
});

test("monthly payment extends from later existing expiry", () => {
  const user = {
    plan: "Free",
    planExpiresAt: new Date("2026-01-10T00:00:00.000Z"),
    fileCredits: 0,
  };
  const now = new Date("2026-01-01T00:00:00.000Z");

  applyPaidPlanToUser(user, "monthly", now);

  assert.equal(user.plan, "Monthly");
  assert.equal(user.planExpiresAt.toISOString(), "2026-02-09T00:00:00.000Z");
});

test("yearly payment sets yearly and adds 365 days", () => {
  const user = { plan: "Free", planExpiresAt: null, fileCredits: 0 };
  const now = new Date("2026-01-01T00:00:00.000Z");

  applyPaidPlanToUser(user, "yearly", now);

  assert.equal(user.plan, "Yearly");
  assert.equal(user.planExpiresAt.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("per-file payment adds exactly one credit", () => {
  const user = { plan: "Free", planExpiresAt: null, fileCredits: 2 };

  applyPaidPlanToUser(user, "perfile", new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(user.plan, "PerFile");
  assert.equal(user.fileCredits, 3);
});
