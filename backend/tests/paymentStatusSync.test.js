const assert = require("node:assert/strict");
const test = require("node:test");

const Payment = require("../models/Payment");
const User = require("../models/User");
const payosClient = require("../services/payosClient");
const originalFindById = User.findById;
const originalFindPaymentById = Payment.findById;
const originalStartSession = Payment.db.startSession;

payosClient.getPayOSClient = () => ({
  paymentRequests: {
    get: async () => ({ amount: 10000, status: "PAID" }),
  },
});
delete require.cache[require.resolve("../services/paymentStatusSync")];
const {
  createPaymentStatusSynchronizer,
  normalizePayOSStatus,
} = require("../services/paymentStatusSync");

function syncPaymentStatusFromPayOS(...args) {
  return createPaymentStatusSynchronizer({
    PaymentModel: Payment,
    UserModel: User,
    getPayOSClient: () => payosClient.getPayOSClient(),
    assertPaymentSettlementReady: () => {},
  }).syncPaymentStatusFromPayOS(...args);
}

test.after(() => {
  User.findById = originalFindById;
  Payment.findById = originalFindPaymentById;
  Payment.db.startSession = originalStartSession;
  delete require.cache[require.resolve("../services/paymentStatusSync")];
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function queryFor(value) {
  return {
    session() {
      return this;
    },
    populate() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function installPaymentStore({ failNextPaymentSave = false } = {}) {
  const store = {
    payment: {
      _id: "payment-id",
      user: "user-id",
      amount: 10000,
      paymentLinkId: "payment-link-id",
      plan: { _id: "perfile-plan", code: "perfile", fileCredits: 1, durationDays: 0 },
      status: "pending",
      paidAt: null,
      payosData: {},
    },
    user: { _id: "user-id", plan: "Free", fileCredits: 2 },
    failNextPaymentSave,
    transactions: 0,
  };
  store.user.save = async () => {};

  const createPaymentDocument = (state) => ({
    ...state.payment,
    async save() {
      if (state.failNextPaymentSave) {
        state.failNextPaymentSave = false;
        store.failNextPaymentSave = false;
        throw new Error("payment save failed");
      }
    },
  });
  const createUserDocument = (state) => ({
    ...state.user,
    async save() {},
  });

  Payment.db.startSession = async () => {
    const session = {
      state: null,
      async withTransaction(work) {
        this.state = clone(store);
        this.state.payment = createPaymentDocument(this.state);
        this.state.user = createUserDocument(this.state);
        store.transactions += 1;
        try {
          await work();
          store.payment = clone(this.state.payment);
          store.user = clone(this.state.user);
          store.failNextPaymentSave = this.state.failNextPaymentSave;
        } finally {
          this.state = null;
        }
      },
      async endSession() {},
    };
    return session;
  };
  Payment.findById = (_id) => ({
    session(session) {
      return queryFor(session.state.payment);
    },
    populate() {
      return this;
    },
  });
  User.findById = (_id) => ({
    session(session) {
      return queryFor(session.state.user);
    },
    then(resolve, reject) {
      return Promise.resolve(store.user).then(resolve, reject);
    },
  });

  return {
    createPendingSnapshot() {
      return createPaymentDocument(store);
    },
    store,
  };
}

test("PayOS statuses retain their payment-state mapping", () => {
  assert.equal(normalizePayOSStatus("PAID"), "paid");
  assert.equal(normalizePayOSStatus("CANCELLED"), "cancelled");
  assert.equal(normalizePayOSStatus("PROCESSING"), "pending");
});

test("PayOS settlement refuses to start a transaction when deployment readiness fails", async () => {
  let startSessionCalled = false;
  const sync = createPaymentStatusSynchronizer({
    PaymentModel: {
      db: {
        async startSession() {
          startSessionCalled = true;
        },
      },
    },
    assertPaymentSettlementReady() {
      const error = new Error("MongoDB transactions unavailable");
      error.code = "PAYMENT_SETTLEMENT_NOT_READY";
      throw error;
    },
  });

  await assert.rejects(
    sync.applyPaidPayment({ _id: "payment-id" }, { amount: 10000 }, {}),
    (error) => error.code === "PAYMENT_SETTLEMENT_NOT_READY",
  );
  assert.equal(startSessionCalled, false);
});

test("PayOS transaction seam exposes each real transaction attempt", async () => {
  let attempts = 0;
  const paidPayment = { _id: "payment-id", status: "paid" };
  const sync = createPaymentStatusSynchronizer({
    PaymentModel: {
      db: {
        async startSession() {
          return {
            async endSession() {},
            async withTransaction(work) {
              await work();
            },
          };
        },
      },
      findById() {
        return {
          session() {
            return {
              populate: async () => paidPayment,
            };
          },
        };
      },
    },
    assertPaymentSettlementReady() {},
    async beforeTransactionWork() {
      attempts += 1;
    },
  });

  await sync.applyPaidPayment(paidPayment, { amount: 10000 }, {});
  assert.equal(attempts, 1);
});

test("PayOS sync applies a paid per-file plan exactly once", async () => {
  const { createPendingSnapshot, store } = installPaymentStore();
  const payment = createPendingSnapshot();

  const result = await syncPaymentStatusFromPayOS(payment);
  const repeatedResult = await syncPaymentStatusFromPayOS(payment);

  assert.equal(result.status, "paid");
  assert.equal(repeatedResult.status, "paid");
  assert.equal(store.user.plan, "perfile-plan");
  assert.equal(store.user.fileCredits, 3);
  assert.equal(store.transactions, 1);
});

test("PayOS sync does not reapply credits from independent pending snapshots", async () => {
  const { createPendingSnapshot, store } = installPaymentStore();
  const firstSnapshot = createPendingSnapshot();
  const retrySnapshot = createPendingSnapshot();

  const first = await syncPaymentStatusFromPayOS(firstSnapshot);
  const retry = await syncPaymentStatusFromPayOS(retrySnapshot);

  assert.equal(first.status, "paid");
  assert.equal(retry.status, "paid");
  assert.equal(store.user.fileCredits, 3);
  assert.equal(store.transactions, 2);
});

test("non-paid webhook status cannot downgrade a payment settled by a concurrent transaction", async () => {
  const { createPendingSnapshot, store } = installPaymentStore();
  store.payment.status = "paid";
  store.payment.paidAt = new Date().toISOString();
  store.user.fileCredits = 3;
  const sync = createPaymentStatusSynchronizer({
    PaymentModel: Payment,
    UserModel: User,
    assertPaymentSettlementReady: () => {},
  });

  const transitioned = await sync.applyNonPaidPaymentStatus(
    createPendingSnapshot(),
    "failed",
    { amount: 10000, status: "FAILED" },
    { webhook: { success: false } },
  );

  assert.equal(transitioned.status, "paid");
  assert.equal(store.payment.status, "paid");

  const retry = await sync.applyPaidPayment(
    createPendingSnapshot(),
    { amount: 10000, status: "PAID" },
    {},
  );
  assert.equal(retry.status, "paid");
  assert.equal(store.user.fileCredits, 3);
});

test("PayOS concurrent snapshots settle one coupon usage in the payment transaction", async () => {
  const { createPendingSnapshot, store } = installPaymentStore();
  store.payment.coupon = "coupon-id";
  store.payment.discountAmount = 2500;
  const recordedPayments = new Set();
  let couponSettlements = 0;

  const sync = createPaymentStatusSynchronizer({
    PaymentModel: Payment,
    UserModel: User,
    getPayOSClient: () => payosClient.getPayOSClient(),
    assertPaymentSettlementReady: () => {},
    async recordCouponUsage({ couponId, userId, paymentId, discountAmount, session }) {
      assert.equal(couponId, "coupon-id");
      assert.equal(userId, "user-id");
      assert.equal(paymentId, "payment-id");
      assert.equal(discountAmount, 2500);
      assert.ok(session?.state, "coupon settlement must receive the active transaction session");
      if (!recordedPayments.has(paymentId)) {
        recordedPayments.add(paymentId);
        couponSettlements += 1;
      }
    },
  });

  await Promise.all([
    sync.applyPaidPayment(createPendingSnapshot(), { amount: 10000, status: "PAID" }, {}),
    sync.applyPaidPayment(createPendingSnapshot(), { amount: 10000, status: "PAID" }, {}),
  ]);

  assert.equal(store.payment.status, "paid");
  assert.equal(store.user.fileCredits, 3);
  assert.equal(couponSettlements, 1);
});

test("zero-total settlement uses the same transactional coupon and entitlement path", async () => {
  const { createPendingSnapshot, store } = installPaymentStore();
  store.payment.amount = 0;
  store.payment.coupon = "coupon-id";
  store.payment.discountAmount = 10000;
  let couponSettlements = 0;
  const sync = createPaymentStatusSynchronizer({
    PaymentModel: Payment,
    UserModel: User,
    assertPaymentSettlementReady: () => {},
    async recordCouponUsage({ paymentId, session }) {
      assert.equal(paymentId, "payment-id");
      assert.ok(session?.state, "coupon settlement must receive the active transaction session");
      couponSettlements += 1;
    },
  });

  const settled = await sync.applyPaidPayment(createPendingSnapshot(), { amount: 0 }, {
    freeCheckout: true,
  });

  assert.equal(settled.status, "paid");
  assert.equal(store.payment.status, "paid");
  assert.equal(store.user.fileCredits, 3);
  assert.equal(couponSettlements, 1);
  assert.equal(store.transactions, 1);
});

test("PayOS settlement rolls back payment and entitlement when coupon settlement fails", async () => {
  const { createPendingSnapshot, store } = installPaymentStore();
  store.payment.coupon = "coupon-id";

  const sync = createPaymentStatusSynchronizer({
    PaymentModel: Payment,
    UserModel: User,
    assertPaymentSettlementReady: () => {},
    async recordCouponUsage() {
      throw new Error("coupon usage failed");
    },
  });

  await assert.rejects(
    sync.applyPaidPayment(createPendingSnapshot(), { amount: 10000, status: "PAID" }, {}),
    /coupon usage failed/,
  );
  assert.equal(store.payment.status, "pending");
  assert.equal(store.user.fileCredits, 2);
});

test("PayOS sync rolls back credits when payment persistence fails", async () => {
  const { createPendingSnapshot, store } = installPaymentStore({ failNextPaymentSave: true });

  await assert.rejects(syncPaymentStatusFromPayOS(createPendingSnapshot()), /payment save failed/);
  assert.equal(store.payment.status, "pending");
  assert.equal(store.user.fileCredits, 2);

  const retry = await syncPaymentStatusFromPayOS(createPendingSnapshot());
  assert.equal(retry.status, "paid");
  assert.equal(store.user.fileCredits, 3);
});
