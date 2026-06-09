const { getPlanConfig, normalizePlanType } = require("./paymentPlans");

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function laterDate(a, b) {
  if (!a) return b;
  return a > b ? a : b;
}

function applyPaidPlanToUser(user, planType, now = new Date()) {
  const normalized = normalizePlanType(planType);
  const plan = getPlanConfig(normalized);

  if (normalized === "perfile") {
    user.plan = "PerFile";
    user.fileCredits = Number(user.fileCredits || 0) + plan.fileCredits;
    return user;
  }

  const currentExpiry = user.planExpiresAt ? new Date(user.planExpiresAt) : null;
  const startsAt = laterDate(currentExpiry, now);
  user.plan = plan.userPlan;
  user.planExpiresAt = addDays(startsAt, plan.durationDays);
  return user;
}

module.exports = { applyPaidPlanToUser, addDays };
