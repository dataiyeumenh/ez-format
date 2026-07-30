const Payment = require("../models/Payment");
const User = require("../models/User");
const { assertPaymentSettlementReady } = require("../config/db");
const { getPayOSClient } = require("./payosClient");
const { recordCouponUsage } = require("./couponService");
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

function createPaymentStatusSynchronizer({
  PaymentModel = Payment,
  UserModel = User,
  getPayOSClient: getPayOSClientForSync = getPayOSClient,
  assertPaymentSettlementReady: assertReady = assertPaymentSettlementReady,
  beforeTransactionWork = async () => {},
  recordCouponUsage: recordCouponUsageForSettlement = recordCouponUsage,
} = {}) {
  async function withPaymentTransaction(paymentId, work) {
    assertReady();
    const session = await PaymentModel.db.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const payment = await PaymentModel.findById(paymentId).session(session).populate("plan");
        await beforeTransactionWork({ payment, session });
        result = await work(payment, session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function applyPaidPayment(payment, remotePaymentLink, snapshotPayOSData) {
    return withPaymentTransaction(payment._id, async (storedPayment, session) => {
      if (!storedPayment) return payment;
      if (storedPayment.status === "paid") {
        if (storedPayment.coupon) {
          await recordCouponUsageForSettlement({
            couponId: storedPayment.coupon,
            userId: storedPayment.user,
            paymentId: storedPayment._id,
            discountAmount: storedPayment.discountAmount || 0,
            session,
          });
        }
        return storedPayment;
      }

      mergePayOSData(storedPayment, snapshotPayOSData, remotePaymentLink);
      if (Number(remotePaymentLink.amount) !== Number(storedPayment.amount)) {
        storedPayment.status = "failed";
        await storedPayment.save({ session });
        return storedPayment;
      }

      const user = await UserModel.findById(storedPayment.user).session(session);
      if (!user) {
        storedPayment.status = "failed";
        await storedPayment.save({ session });
        return storedPayment;
      }

      storedPayment.paidAt = storedPayment.paidAt || new Date();
      applyPaidPlanToUser(user, storedPayment.plan, storedPayment.paidAt);
      storedPayment.status = "paid";
      if (storedPayment.coupon) {
        await recordCouponUsageForSettlement({
          couponId: storedPayment.coupon,
          userId: storedPayment.user,
          paymentId: storedPayment._id,
          discountAmount: storedPayment.discountAmount || 0,
          session,
        });
      }
      await user.save({ session });
      await storedPayment.save({ session });
      return storedPayment;
    });
  }

  async function applyNonPaidPaymentStatus(
    payment,
    nextStatus,
    remotePaymentLink,
    snapshotPayOSData,
  ) {
    return withPaymentTransaction(payment._id, async (storedPayment, session) => {
      if (!storedPayment || storedPayment.status === "paid") {
        return storedPayment || payment;
      }

      mergePayOSData(storedPayment, snapshotPayOSData, remotePaymentLink);
      storedPayment.status = nextStatus;
      await storedPayment.save({ session });
      return storedPayment;
    });
  }

  async function syncPaymentStatusFromPayOS(payment) {
    if (!payment || payment.status === "paid") return payment;

    const payOS = getPayOSClientForSync();
    const remotePaymentLink = await payOS.paymentRequests.get(
      payment.paymentLinkId || payment.orderCode,
    );
    const nextStatus = normalizePayOSStatus(remotePaymentLink.status);

    if (nextStatus === "paid") {
      const settledPayment = await applyPaidPayment(payment, remotePaymentLink, payment.payosData);
      return mirrorPaymentState(payment, settledPayment);
    }

    const syncedPayment = await applyNonPaidPaymentStatus(
      payment,
      nextStatus,
      remotePaymentLink,
      payment.payosData,
    );
    return mirrorPaymentState(payment, syncedPayment);
  }

  return {
    applyPaidPayment,
    applyNonPaidPaymentStatus,
    syncPaymentStatusFromPayOS,
    withPaymentTransaction,
  };
}

const defaultSynchronizer = createPaymentStatusSynchronizer();

module.exports = {
  createPaymentStatusSynchronizer,
  normalizePayOSStatus,
  ...defaultSynchronizer,
};
