const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PLAN_CONFIGS,
  buildPaymentDescription,
  normalizePlanType,
} = require("../services/paymentPlans");
const {
  applyPaidPlanToUser,
  applyAdminPlanToUser,
  normalizeDepletedPerFilePlan,
  normalizeExpiredTimePlan,
} = require("../services/subscriptionService");

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
    planStartedAt: null,
    planExpiresAt: new Date("2026-01-10T00:00:00.000Z"),
    fileCredits: 0,
  };
  const now = new Date("2026-01-01T00:00:00.000Z");

  applyPaidPlanToUser(user, "monthly", now);

  assert.equal(user.plan, "Monthly");
  assert.equal(user.planStartedAt.toISOString(), "2026-01-10T00:00:00.000Z");
  assert.equal(user.planExpiresAt.toISOString(), "2026-02-09T00:00:00.000Z");
});

test("yearly payment sets yearly and adds 365 days", () => {
  const user = { plan: "Free", planExpiresAt: null, fileCredits: 0 };
  const now = new Date("2026-01-01T00:00:00.000Z");

  applyPaidPlanToUser(user, "yearly", now);

  assert.equal(user.plan, "Yearly");
  assert.equal(user.planStartedAt.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(user.planExpiresAt.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("admin monthly plan starts from admin edit time", () => {
  const user = {
    plan: "Free",
    planStartedAt: null,
    planExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    fileCredits: 0,
  };
  const now = new Date("2026-06-13T10:30:00.000Z");

  applyAdminPlanToUser(user, "Monthly", now);

  assert.equal(user.plan, "Monthly");
  assert.equal(user.planStartedAt.toISOString(), "2026-06-13T10:30:00.000Z");
  assert.equal(user.planExpiresAt.toISOString(), "2026-07-13T10:30:00.000Z");
});

test("admin yearly plan starts from admin edit time", () => {
  const user = { plan: "Free", planStartedAt: null, planExpiresAt: null };
  const now = new Date("2026-06-13T10:30:00.000Z");

  applyAdminPlanToUser(user, "Yearly", now);

  assert.equal(user.plan, "Yearly");
  assert.equal(user.planStartedAt.toISOString(), "2026-06-13T10:30:00.000Z");
  assert.equal(user.planExpiresAt.toISOString(), "2027-06-13T10:30:00.000Z");
});

test("admin free plan clears time subscription dates", () => {
  const user = {
    plan: "Monthly",
    planStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    planExpiresAt: new Date("2026-02-01T00:00:00.000Z"),
  };

  applyAdminPlanToUser(user, "Free", new Date("2026-06-13T10:30:00.000Z"));

  assert.equal(user.plan, "Free");
  assert.equal(user.planStartedAt, null);
  assert.equal(user.planExpiresAt, null);
});

test("per-file payment adds exactly one credit", () => {
  const user = { plan: "Free", planExpiresAt: null, fileCredits: 2 };

  applyPaidPlanToUser(user, "perfile", new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(user.plan, "PerFile");
  assert.equal(user.fileCredits, 3);
});

test("depleted per-file plan falls back to free", () => {
  const user = {
    plan: "PerFile",
    planStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    planExpiresAt: new Date("2026-02-01T00:00:00.000Z"),
    fileCredits: 0,
  };

  normalizeDepletedPerFilePlan(user);

  assert.equal(user.plan, "Free");
  assert.equal(user.planStartedAt, null);
  assert.equal(user.planExpiresAt, null);
  assert.equal(user.fileCredits, 0);
});

test("non per-file plan is not changed when credits are zero", () => {
  const user = { plan: "Monthly", planExpiresAt: null, fileCredits: 0 };

  normalizeDepletedPerFilePlan(user);

  assert.equal(user.plan, "Monthly");
  assert.equal(user.fileCredits, 0);
});

test("expired monthly/yearly plan falls back to free", () => {
  const user = {
    plan: "Monthly",
    planStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    planExpiresAt: new Date("2026-02-01T00:00:00.000Z"),
    fileCredits: 0,
  };

  normalizeExpiredTimePlan(user, new Date("2026-02-01T00:00:00.001Z"));

  assert.equal(user.plan, "Free");
  assert.equal(user.planStartedAt, null);
  assert.equal(user.planExpiresAt, null);
});
