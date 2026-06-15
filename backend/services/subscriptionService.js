const { getPlanConfig, normalizePlanType } = require("./paymentPlans");

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function laterDate(a, b) {
  if (!a) return b;
  return a > b ? a : b;
}

function getPlanCode(planOrType) {
  if (typeof planOrType === "string") return normalizePlanType(planOrType);
  return String(planOrType?.code || "").trim().toLowerCase();
}

function getPlanObjectId(planOrType) {
  if (typeof planOrType === "string") return null;
  return planOrType?._id || planOrType?.id || null;
}

function getPlanRuntimeConfig(planOrType) {
  if (typeof planOrType === "string") {
    const normalized = normalizePlanType(planOrType);
    return {
      ...getPlanConfig(normalized),
      code: normalized,
      planObjectId: null,
    };
  }

  const code = getPlanCode(planOrType);
  return {
    code,
    userPlan: code === "monthly" ? "Monthly" : code === "yearly" ? "Yearly" : code === "perfile" ? "PerFile" : "Free",
    durationDays: Number(planOrType?.durationDays || 0),
    fileCredits: Number(planOrType?.fileCredits || 0),
    planObjectId: getPlanObjectId(planOrType),
  };
}

function applyPaidPlanToUser(user, planOrType, now = new Date()) {
  const plan = getPlanRuntimeConfig(planOrType);

  if (plan.code === "perfile" || (plan.fileCredits > 0 && plan.durationDays === 0)) {
    if (plan.planObjectId) user.plan = plan.planObjectId;
    else user.plan = "PerFile";
    user.planStartedAt = null;
    user.planExpiresAt = null;
    user.fileCredits = Number(user.fileCredits || 0) + Number(plan.fileCredits || 1);
    return user;
  }

  const currentExpiry = user.planExpiresAt ? new Date(user.planExpiresAt) : null;
  const startsAt = laterDate(currentExpiry, now);
  if (plan.planObjectId) user.plan = plan.planObjectId;
  else user.plan = plan.userPlan;
  user.planStartedAt = startsAt;
  user.planExpiresAt = addDays(startsAt, plan.durationDays);
  return user;
}

function normalizeUserPlan(plan) {
  const normalized = String(plan || "").trim().toLowerCase();
  const plans = {
    free: "Free",
    monthly: "Monthly",
    yearly: "Yearly",
    perfile: "PerFile",
  };
  return plans[normalized] || String(plan || "").trim();
}

function clearTimeSubscription(user) {
  user.planStartedAt = null;
  user.planExpiresAt = null;
  return user;
}

function applyAdminPlanToUser(user, nextPlan, now = new Date()) {
  if (nextPlan && typeof nextPlan === "object") {
    const plan = getPlanRuntimeConfig(nextPlan);
    if (plan.durationDays > 0) {
      user.plan = plan.planObjectId;
      user.planStartedAt = now;
      user.planExpiresAt = addDays(now, plan.durationDays);
      return user;
    }
    user.plan = plan.planObjectId;
    clearTimeSubscription(user);
    return user;
  }

  const normalizedPlan = normalizeUserPlan(nextPlan);

  if (normalizedPlan === "Monthly" || normalizedPlan === "Yearly") {
    const planConfig = getPlanConfig(normalizedPlan.toLowerCase());
    user.plan = normalizedPlan;
    user.planStartedAt = now;
    user.planExpiresAt = addDays(now, planConfig.durationDays);
    if (user.fileCredits === undefined || user.fileCredits === null) {
      user.fileCredits = 0;
    }
    return user;
  }

  user.plan = normalizedPlan || "Free";
  if (user.plan === "Free" || user.plan === "PerFile") {
    clearTimeSubscription(user);
  }
  return user;
}

function normalizeDepletedPerFilePlan(user) {
  const planCode = user?.plan?.code || user?.plan;
  if ((planCode === "PerFile" || planCode === "perfile") && Number(user.fileCredits || 0) <= 0) {
    if (user.plan?.code) user.plan = null;
    else user.plan = "Free";
    clearTimeSubscription(user);
    user.fileCredits = 0;
  }
  return user;
}

function normalizeExpiredTimePlan(user, now = new Date()) {
  const planCode = user?.plan?.code || user?.plan;
  if (
    planCode !== "PerFile" &&
    planCode !== "perfile" &&
    user.planExpiresAt &&
    new Date(user.planExpiresAt).getTime() <= now.getTime()
  ) {
    if (user.plan?.code) user.plan = null;
    else user.plan = "Free";
    clearTimeSubscription(user);
  }
  return user;
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // Việt Nam = UTC+7 (không có DST)

// Ngày hiện tại theo giờ Việt Nam dưới dạng "YYYY-MM-DD".
function vnDateString(date = new Date()) {
  return new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

// Reset lượt miễn phí hằng ngày khi sang ngày mới (giờ VN).
function normalizeDailyFileCredit(user, now = new Date()) {
  if (!user) return user;
  const today = vnDateString(now);
  if (user.dailyFileCreditDate !== today) {
    user.dailyFileCredit = 1;
    user.dailyFileCreditDate = today;
  }
  return user;
}

function getUserPlanCode(user) {
  const raw = user?.plan?.code ?? user?.plan;
  return String(raw || "free").trim().toLowerCase();
}

// Trừ 1 lượt khi convert + tải thành công.
// Free: trừ dailyFileCredit. PerFile: ưu tiên dailyFileCredit rồi tới fileCredits.
// Plan khác (monthly/yearly): không trừ. Trả về true nếu plan thuộc diện quản lý lượt.
function deductConversionCredit(user) {
  const planCode = getUserPlanCode(user);
  if (planCode === "perfile") {
    if (Number(user.dailyFileCredit || 0) > 0) {
      user.dailyFileCredit = Number(user.dailyFileCredit) - 1;
    } else if (Number(user.fileCredits || 0) > 0) {
      user.fileCredits = Number(user.fileCredits) - 1;
      normalizeDepletedPerFilePlan(user);
    }
    return true;
  }
  if (planCode === "free") {
    if (Number(user.dailyFileCredit || 0) > 0) {
      user.dailyFileCredit = Number(user.dailyFileCredit) - 1;
    }
    return true;
  }
  return false;
}

function normalizeSubscriptionState(user, now = new Date()) {
  normalizeDepletedPerFilePlan(user);
  normalizeExpiredTimePlan(user, now);
  normalizeDailyFileCredit(user, now);
  return user;
}

module.exports = {
  applyPaidPlanToUser,
  applyAdminPlanToUser,
  normalizeDepletedPerFilePlan,
  normalizeExpiredTimePlan,
  normalizeSubscriptionState,
  normalizeDailyFileCredit,
  deductConversionCredit,
  getUserPlanCode,
  vnDateString,
  addDays,
};
