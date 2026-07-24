const User = require("../models/User");
const { getPayOSClient } = require("./payosClient");
const { applyPaidPlanToUser } = require("./subscriptionService");
const { recordCouponUsage } = require("./couponService");
const CouponUsage = require("../models/CouponUsage");

const PAYOS_STATUS_TO_PAYMENT_STATUS = {
  PAID: "paid",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  FAILED: "failed",
  PENDING: "pending",
  PROCESSING: "pending",
  UNDERPAID: "pending",
};

function normalizePayOSStatus(status) {
  return PAYOS_STATUS_TO_PAYMENT_STATUS[String(status || "").toUpperCase()] || "pending";
}

async function applyPaidPayment(payment, remotePaymentLink) {
  if (Number(remotePaymentLink.amount) !== Number(payment.amount)) {
    payment.status = "failed";
    return;
  }

  const user = await User.findById(payment.user);
  if (!user) {
    payment.status = "failed";
    return;
  }

  payment.paidAt = payment.paidAt || new Date();
  const plan = payment.plan?.code ? payment.plan : await payment.populate("plan").then((doc) => doc.plan);
  applyPaidPlanToUser(user, plan, payment.paidAt);
  await user.save();

  payment.status = "paid";

  // Chỉ trừ lượt coupon khi giao dịch thành công.
  if (payment.coupon) {
    const already = await CouponUsage.exists({ payment: payment._id });
    if (!already) {
      await recordCouponUsage({
        couponId: payment.coupon,
        userId: user._id,
        paymentId: payment._id,
        discountAmount: payment.discountAmount || 0,
      });
    }
  }
}

async function syncPaymentStatusFromPayOS(payment) {
  if (!payment || payment.status === "paid") return payment;

  const payOS = getPayOSClient();
  const remotePaymentLink = await payOS.paymentRequests.get(
    payment.paymentLinkId || payment.orderCode,
  );
  const nextStatus = normalizePayOSStatus(remotePaymentLink.status);

  payment.payosData = {
    ...(payment.payosData || {}),
    lastSync: {
      syncedAt: new Date(),
      paymentLink: remotePaymentLink,
    },
  };

  if (nextStatus === "paid") {
    await applyPaidPayment(payment, remotePaymentLink);
  } else {
    payment.status = nextStatus;
  }

  await payment.save();
  return payment;
}

module.exports = {
  normalizePayOSStatus,
  syncPaymentStatusFromPayOS,
};
