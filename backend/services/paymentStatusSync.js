const Payment = require("../models/Payment");
const User = require("../models/User");
const { getPayOSClient } = require("./payosClient");
const { applyPaidPlanToUser } = require("./subscriptionService");

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

function mergePayOSData(payment, snapshotPayOSData, remotePaymentLink) {
  payment.payosData = {
    ...(payment.payosData || {}),
    ...(snapshotPayOSData || {}),
    lastSync: {
      syncedAt: new Date(),
      paymentLink: remotePaymentLink,
    },
  };
}

function mirrorPaymentState(snapshot, storedPayment) {
  if (!snapshot || !storedPayment || snapshot === storedPayment) return storedPayment;
  snapshot.status = storedPayment.status;
  snapshot.paidAt = storedPayment.paidAt;
  snapshot.payosData = storedPayment.payosData;
  return storedPayment;
}

async function withPaymentTransaction(paymentId, work) {
  const session = await Payment.db.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const payment = await Payment.findById(paymentId).session(session).populate("plan");
      result = await work(payment, session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function applyPaidPayment(payment, remotePaymentLink, snapshotPayOSData) {
  return withPaymentTransaction(payment._id, async (storedPayment, session) => {
    if (!storedPayment || storedPayment.status === "paid") return storedPayment || payment;

    mergePayOSData(storedPayment, snapshotPayOSData, remotePaymentLink);
    if (Number(remotePaymentLink.amount) !== Number(storedPayment.amount)) {
      storedPayment.status = "failed";
      await storedPayment.save({ session });
      return storedPayment;
    }

    const user = await User.findById(storedPayment.user).session(session);
    if (!user) {
      storedPayment.status = "failed";
      await storedPayment.save({ session });
      return storedPayment;
    }

    storedPayment.paidAt = storedPayment.paidAt || new Date();
    applyPaidPlanToUser(user, storedPayment.plan, storedPayment.paidAt);
    storedPayment.status = "paid";
    await user.save({ session });
    await storedPayment.save({ session });
    return storedPayment;
  });
}

async function syncPaymentStatusFromPayOS(payment) {
  if (!payment || payment.status === "paid") return payment;

  const payOS = getPayOSClient();
  const remotePaymentLink = await payOS.paymentRequests.get(
    payment.paymentLinkId || payment.orderCode,
  );
  const nextStatus = normalizePayOSStatus(remotePaymentLink.status);

  if (nextStatus === "paid") {
    const settledPayment = await applyPaidPayment(payment, remotePaymentLink, payment.payosData);
    return mirrorPaymentState(payment, settledPayment);
  }

  const syncedPayment = await withPaymentTransaction(payment._id, async (storedPayment, session) => {
    if (!storedPayment || storedPayment.status === "paid") return storedPayment || payment;
    mergePayOSData(storedPayment, payment.payosData, remotePaymentLink);
    storedPayment.status = nextStatus;
    await storedPayment.save({ session });
    return storedPayment;
  });
  return mirrorPaymentState(payment, syncedPayment);
}

module.exports = {
  normalizePayOSStatus,
  applyPaidPayment,
  syncPaymentStatusFromPayOS,
};
