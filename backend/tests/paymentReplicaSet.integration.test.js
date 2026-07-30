const assert = require("node:assert/strict");
const test = require("node:test");

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Coupon = require("../models/Coupon");
const CouponUsage = require("../models/CouponUsage");
const Payment = require("../models/Payment");
const Plan = require("../models/Plan");
const User = require("../models/User");
const payosClient = require("../services/payosClient");
const { createPaymentStatusSynchronizer, applyPaidPayment } = require("../services/paymentStatusSync");

const TEST_URI = String(process.env.PAYMENT_REPLICA_SET_TEST_URI || "").trim();
const TEST_DATABASE_PATTERN = /(?:^|[-_])test$/i;
const TEST_DATABASE = TEST_URI.split("?")[0].split("/").pop();
const SKIP_REASON = !TEST_URI
  ? "PAYMENT_REPLICA_SET_TEST_URI is not set; real replica-set payment tests are skipped."
  : !TEST_DATABASE_PATTERN.test(TEST_DATABASE)
    ? "PAYMENT_REPLICA_SET_TEST_URI must use a database name ending in -test or _test."
    : null;

if (SKIP_REASON) {
  for (const name of [
    "replica-set duplicate PayOS webhooks settle once",
    "replica-set transaction rolls back user credits when payment persistence fails",
    "replica-set transaction rolls back payment, entitlement, and coupon when coupon settlement fails",
    "replica-set concurrent settlement retries a write conflict without double credits",
    "replica-set concurrent coupon settlement records one usage",
    "replica-set paid settlements enforce the global coupon limit",
    "replica-set zero-total settlements enforce the per-user coupon limit",
  ]) {
    test(name, { skip: SKIP_REASON }, () => {});
  }
} else {
  const created = { coupons: [], payments: [], plans: [], users: [] };

  async function createFixture({ withCoupon = false } = {}) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const plan = await Plan.create({
      code: `payos-${suffix}`,
      name: `PayOS file plan ${suffix}`,
      price: 10000,
      displayPrice: "10,000 VND",
      fileCredits: 1,
    });
    const user = await User.create({
      name: "PayOS Replica Test",
      email: `payos-${suffix}@example.test`,
      googleId: `payos-${suffix}`,
      authProvider: "google",
      fileCredits: 2,
    });
    const coupon = withCoupon
      ? await Coupon.create({
        code: `PAYOS${suffix.replace(/[^a-z0-9]/gi, "").slice(-16)}`.toUpperCase(),
        description: "Replica-set coupon settlement test",
        discountPercent: 25,
        applicablePlans: [plan._id],
        usageLimit: 10,
        limitPerUser: 1,
        startDate: new Date(Date.now() - 60_000),
        endDate: new Date(Date.now() + 60_000),
      })
      : null;
    const payment = await Payment.create({
      user: user._id,
      plan: plan._id,
      orderCode: Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-12)),
      planCode: plan.code,
      planName: plan.name,
      amount: 10000,
      coupon: coupon?._id || null,
      couponApplied: Boolean(coupon),
      discountAmount: coupon ? 2500 : 0,
      paymentLinkId: `payment-link-${suffix}`,
    });
    created.plans.push(plan._id);
    created.users.push(user._id);
    created.payments.push(payment._id);
    if (coupon) created.coupons.push(coupon._id);
    return { coupon, payment, plan, user };
  }

  test.before(async () => {
    process.env.MONGO_URI = TEST_URI;
    await connectDB();
    const readiness = require("../config/db").getPaymentSettlementReadiness();
    assert.equal(readiness.ready, true, readiness.reason);
  });

  test.after(async () => {
    await CouponUsage.deleteMany({ payment: { $in: created.payments } });
    await Payment.deleteMany({ _id: { $in: created.payments } });
    await Coupon.deleteMany({ _id: { $in: created.coupons } });
    await User.deleteMany({ _id: { $in: created.users } });
    await Plan.deleteMany({ _id: { $in: created.plans } });
    await mongoose.disconnect();
  });

  test("replica-set duplicate PayOS webhooks settle once", async () => {
    const { payment, user } = await createFixture();
    const originalGetPayOSClient = payosClient.getPayOSClient;
    payosClient.getPayOSClient = () => ({
      webhooks: {
        verify: async () => ({
          orderCode: payment.orderCode,
          amount: payment.amount,
          paymentLinkId: payment.paymentLinkId,
          code: "00",
        }),
      },
    });
    delete require.cache[require.resolve("../controllers/paymentController")];
    const { handlePayOSWebhook } = require("../controllers/paymentController");
    const response = () => ({
      status() {
        return this;
      },
      json() {},
    });

    try {
      await handlePayOSWebhook({ body: { success: true } }, response());
      await handlePayOSWebhook({ body: { success: true } }, response());
    } finally {
      payosClient.getPayOSClient = originalGetPayOSClient;
      delete require.cache[require.resolve("../controllers/paymentController")];
    }

    const storedPayment = await Payment.findById(payment._id);
    const storedUser = await User.findById(user._id);
    assert.equal(storedPayment.status, "paid");
    assert.equal(storedUser.fileCredits, 3);
  });

  test("replica-set transaction rolls back user credits when payment persistence fails", async () => {
    const { payment, user } = await createFixture();
    const originalSave = Payment.prototype.save;
    let injectFailure = true;
    Payment.prototype.save = function saveWithInjectedFailure(...args) {
      if (injectFailure && String(this._id) === String(payment._id)) {
        injectFailure = false;
        throw new Error("injected payment persistence failure");
      }
      return originalSave.apply(this, args);
    };

    try {
      await assert.rejects(
        applyPaidPayment(payment, { amount: payment.amount, status: "PAID" }, {}),
        /injected payment persistence failure/,
      );
    } finally {
      Payment.prototype.save = originalSave;
    }

    const storedPayment = await Payment.findById(payment._id);
    const storedUser = await User.findById(user._id);
    assert.equal(storedPayment.status, "pending");
    assert.equal(storedUser.fileCredits, 2);
  });

  test("replica-set transaction rolls back payment, entitlement, and coupon when coupon settlement fails", async () => {
    const { coupon, payment, user } = await createFixture({ withCoupon: true });
    const originalUpdateOne = CouponUsage.updateOne;
    CouponUsage.updateOne = async () => {
      throw new Error("injected coupon settlement failure");
    };

    try {
      await assert.rejects(
        applyPaidPayment(payment, { amount: payment.amount, status: "PAID" }, {}),
        /injected coupon settlement failure/,
      );
    } finally {
      CouponUsage.updateOne = originalUpdateOne;
    }

    const [storedCoupon, storedPayment, storedUser, usages] = await Promise.all([
      Coupon.findById(coupon._id),
      Payment.findById(payment._id),
      User.findById(user._id),
      CouponUsage.countDocuments({ payment: payment._id }),
    ]);
    assert.equal(storedPayment.status, "pending");
    assert.equal(storedUser.fileCredits, 2);
    assert.equal(storedCoupon.usageCount, 0);
    assert.equal(usages, 0);
  });

  test("replica-set concurrent settlement retries a write conflict without double credits", async () => {
    const { payment, user } = await createFixture();
    let arrivals = 0;
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const synchronizer = createPaymentStatusSynchronizer({
      async beforeTransactionWork({ payment: attemptPayment }) {
        if (attemptPayment.status === "paid") return;
        arrivals += 1;
        if (arrivals === 2) releaseGate();
        await gate;
      },
    });

    await Promise.all([
      synchronizer.applyPaidPayment(payment, { amount: payment.amount, status: "PAID" }, {}),
      synchronizer.applyPaidPayment(payment, { amount: payment.amount, status: "PAID" }, {}),
    ]);

    const storedPayment = await Payment.findById(payment._id);
    const storedUser = await User.findById(user._id);
    assert.equal(storedPayment.status, "paid");
    assert.equal(storedUser.fileCredits, 3);
    assert.ok(arrivals >= 3, `Expected a retried transaction attempt; saw ${arrivals}.`);
  });

  test("replica-set concurrent coupon settlement records one usage", async () => {
    const { coupon, payment, user } = await createFixture({ withCoupon: true });
    let arrivals = 0;
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const synchronizer = createPaymentStatusSynchronizer({
      async beforeTransactionWork({ payment: attemptPayment }) {
        if (attemptPayment.status === "paid") return;
        arrivals += 1;
        if (arrivals === 2) releaseGate();
        await gate;
      },
    });

    await Promise.all([
      synchronizer.applyPaidPayment(payment, { amount: payment.amount, status: "PAID" }, {}),
      synchronizer.applyPaidPayment(payment, { amount: payment.amount, status: "PAID" }, {}),
    ]);

    const [storedCoupon, storedPayment, storedUser, usages] = await Promise.all([
      Coupon.findById(coupon._id),
      Payment.findById(payment._id),
      User.findById(user._id),
      CouponUsage.countDocuments({ payment: payment._id }),
    ]);
    assert.equal(storedPayment.status, "paid");
    assert.equal(storedUser.fileCredits, 3);
    assert.equal(usages, 1);
    assert.equal(storedCoupon.usageCount, 1);
  });

  test("replica-set paid settlements enforce the global coupon limit", async () => {
    const { coupon, payment: firstPayment, plan, user: firstUser } = await createFixture({ withCoupon: true });
    await Coupon.updateOne({ _id: coupon._id }, { $set: { usageLimit: 1 } });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const secondUser = await User.create({
      name: "PayOS Replica Test 2",
      email: `payos-${suffix}@example.test`,
      googleId: `payos-${suffix}`,
      authProvider: "google",
      fileCredits: 2,
    });
    const secondPayment = await Payment.create({
      user: secondUser._id,
      plan: plan._id,
      orderCode: Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-12)),
      planCode: plan.code,
      planName: plan.name,
      amount: firstPayment.amount,
      coupon: coupon._id,
      couponApplied: true,
      discountAmount: 2500,
      paymentLinkId: `payment-link-${suffix}`,
    });
    created.users.push(secondUser._id);
    created.payments.push(secondPayment._id);

    let arrivals = 0;
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const synchronizer = createPaymentStatusSynchronizer({
      async beforeTransactionWork({ payment: attemptPayment }) {
        if (attemptPayment.status === "paid") return;
        arrivals += 1;
        if (arrivals === 2) releaseGate();
        await gate;
      },
    });

    const results = await Promise.allSettled([
      synchronizer.applyPaidPayment(firstPayment, { amount: firstPayment.amount, status: "PAID" }, {}),
      synchronizer.applyPaidPayment(secondPayment, { amount: secondPayment.amount, status: "PAID" }, {}),
    ]);
    const [storedCoupon, storedFirstPayment, storedSecondPayment, storedFirstUser, storedSecondUser, usages] = await Promise.all([
      Coupon.findById(coupon._id),
      Payment.findById(firstPayment._id),
      Payment.findById(secondPayment._id),
      User.findById(firstUser._id),
      User.findById(secondUser._id),
      CouponUsage.countDocuments({ coupon: coupon._id }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal([storedFirstPayment, storedSecondPayment].filter((paymentDoc) => paymentDoc.status === "paid").length, 1);
    assert.equal(storedCoupon.usageCount, 1);
    assert.equal(usages, 1);
    assert.equal(storedFirstUser.fileCredits + storedSecondUser.fileCredits, 5);
  });

  test("replica-set zero-total settlements enforce the per-user coupon limit", async () => {
    const { coupon, payment: firstPayment, plan, user } = await createFixture({ withCoupon: true });
    await Payment.updateOne({ _id: firstPayment._id }, { $set: { amount: 0 } });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const secondPayment = await Payment.create({
      user: user._id,
      plan: plan._id,
      orderCode: Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-12)),
      planCode: plan.code,
      planName: plan.name,
      amount: 0,
      coupon: coupon._id,
      couponApplied: true,
      discountAmount: 10000,
      paymentLinkId: `payment-link-${suffix}`,
    });
    created.payments.push(secondPayment._id);

    let arrivals = 0;
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const synchronizer = createPaymentStatusSynchronizer({
      async beforeTransactionWork({ payment: attemptPayment }) {
        if (attemptPayment.status === "paid") return;
        arrivals += 1;
        if (arrivals === 2) releaseGate();
        await gate;
      },
    });

    const results = await Promise.allSettled([
      synchronizer.applyPaidPayment(firstPayment, { amount: 0, status: "PAID" }, { freeCheckout: true }),
      synchronizer.applyPaidPayment(secondPayment, { amount: 0, status: "PAID" }, { freeCheckout: true }),
    ]);
    const [storedCoupon, storedFirstPayment, storedSecondPayment, storedUser, usages] = await Promise.all([
      Coupon.findById(coupon._id),
      Payment.findById(firstPayment._id),
      Payment.findById(secondPayment._id),
      User.findById(user._id),
      CouponUsage.countDocuments({ coupon: coupon._id }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal([storedFirstPayment, storedSecondPayment].filter((paymentDoc) => paymentDoc.status === "paid").length, 1);
    assert.equal(storedUser.fileCredits, 3);
    assert.equal(storedCoupon.usageCount, 1);
    assert.equal(usages, 1);
  });
}
