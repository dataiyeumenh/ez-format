const User = require("../models/User");
const {
  getUserPlanCode,
  normalizeSubscriptionState,
  vnDateString,
} = require("./subscriptionService");

function entitlementError() {
  const error = new Error(
    "Bạn đã hết lượt chuyển đổi. Vui lòng mua thêm lượt hoặc nâng cấp gói.",
  );
  error.statusCode = 402;
  error.code = "CONVERSION_CREDIT_UNAVAILABLE";
  return error;
}

function queryWithSession(query, session) {
  if (session && typeof query?.session === "function") return query.session(session);
  return query;
}

async function loadCurrentUser(userId, session = null) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    const error = new Error("Thiếu người dùng đã xác thực");
    error.statusCode = 401;
    throw error;
  }

  let query = User.findById(normalizedUserId);
  if (typeof query?.populate === "function") query = query.populate("plan");
  const user = await queryWithSession(query, session);
  if (!user) {
    const error = new Error("Không tìm thấy người dùng");
    error.statusCode = 404;
    throw error;
  }
  return user;
}

async function persistNormalizedUser(user, session = null) {
  if (typeof user?.save !== "function") return;
  if (typeof user.isModified === "function") {
    const changed = [
      "plan",
      "planStartedAt",
      "planExpiresAt",
      "fileCredits",
      "dailyFileCredit",
      "dailyFileCreditDate",
    ].some((path) => user.isModified(path));
    if (!changed) return;
  }
  await user.save(session ? { session } : undefined);
}

function entitlementFromUser(user, now = new Date()) {
  normalizeSubscriptionState(user, now);
  const planCode = getUserPlanCode(user);
  const dailyCredit = Number(user.dailyFileCredit || 0);
  const fileCredit = Number(user.fileCredits || 0);
  const creditSource =
    planCode === "monthly" || planCode === "yearly"
      ? "subscription"
      : dailyCredit > 0
        ? "daily"
        : fileCredit > 0
          ? "file"
          : null;

  return {
    allowed:
      planCode === "monthly" ||
      planCode === "yearly" ||
      (planCode === "free" && dailyCredit > 0) ||
      (planCode === "perfile" && (dailyCredit > 0 || fileCredit > 0)),
    planCode,
    metered: planCode === "free" || planCode === "perfile",
    creditSource,
    dailyCredit,
    fileCredit,
    dailyFileCreditDate: user.dailyFileCreditDate || vnDateString(now),
    planExpiresAt: user.planExpiresAt || null,
    user,
  };
}

async function getCurrentConversionEntitlement({ userId, session = null, now = new Date() }) {
  const user = await loadCurrentUser(userId, session);
  if (user.isActive === false) {
    const error = new Error("Tài khoản không hoạt động");
    error.statusCode = 403;
    throw error;
  }
  normalizeSubscriptionState(user, now);
  await persistNormalizedUser(user, session);
  return entitlementFromUser(user, now);
}

async function assertCurrentConversionEntitlement(options) {
  const entitlement = await getCurrentConversionEntitlement(options);
  if (!entitlement.allowed) throw entitlementError();
  return entitlement;
}

async function hasCurrentConversionEntitlement(options) {
  try {
    return (await getCurrentConversionEntitlement(options)).allowed;
  } catch (error) {
    if (error?.statusCode === 402) return false;
    throw error;
  }
}

module.exports = {
  assertCurrentConversionEntitlement,
  entitlementError,
  entitlementFromUser,
  getCurrentConversionEntitlement,
  hasCurrentConversionEntitlement,
  loadCurrentUser,
};
