const mongoose = require("mongoose");
const User = require("../models/User");
const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
const {
  getUserPlanCode,
  normalizeDailyFileCredit,
  normalizeSubscriptionState,
  deductConversionCredit,
} = require("./subscriptionService");

function hasConversionCredit(user) {
  normalizeSubscriptionState(user);
  const planCode = getUserPlanCode(user);
  if (planCode === "monthly" || planCode === "yearly") return true;
  if (Number(user.dailyFileCredit || 0) > 0) return true;
  return planCode === "perfile" && Number(user.fileCredits || 0) > 0;
}

function creditError() {
  const error = new Error(
    "Bạn đã hết lượt chuyển đổi. Vui lòng mua thêm lượt hoặc nâng cấp gói.",
  );
  error.statusCode = 402;
  return error;
}

async function deductCreditForCompletedRun(userId, reconstructionRunId = null) {
  if (!reconstructionRunId) {
    const user = await User.findById(userId).populate("plan");
    if (!user) return { charged: false, creditChargedAt: null };
    normalizeDailyFileCredit(user);
    if (!hasConversionCredit(user)) throw creditError();
    const metered = ["free", "perfile"].includes(getUserPlanCode(user));
    if (metered) deductConversionCredit(user);
    await user.save();
    return { charged: metered, creditChargedAt: new Date() };
  }

  let result = { charged: false, creditChargedAt: null, idempotent: false };
  await mongoose.connection.transaction(async (session) => {
    const run = await VoucherReconstructionRun.findById(reconstructionRunId).session(
      session,
    );
    if (!run) {
      const error = new Error("Không tìm thấy phiên tái tạo chứng từ");
      error.statusCode = 404;
      throw error;
    }
    if (run.creditChargedAt) {
      result = {
        charged: false,
        creditChargedAt: run.creditChargedAt,
        idempotent: true,
      };
      return;
    }
    const user = await User.findById(userId).populate("plan").session(session);
    if (!user) {
      const error = new Error("Không tìm thấy người dùng");
      error.statusCode = 404;
      throw error;
    }
    if (!hasConversionCredit(user)) throw creditError();
    const metered = ["free", "perfile"].includes(getUserPlanCode(user));
    if (metered) deductConversionCredit(user);
    const chargedAt = new Date();
    run.creditChargedAt = chargedAt;
    await Promise.all([user.save({ session }), run.save({ session })]);
    result = { charged: metered, creditChargedAt: chargedAt, idempotent: false };
  });
  return result;
}

module.exports = { deductCreditForCompletedRun, hasConversionCredit };
