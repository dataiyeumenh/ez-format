const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPaymentStatusSynchronizer,
} = require("../services/paymentStatusSync");

function createHarness({ initialStatus = "pending", coupon = "coupon-id" } = {}) {
  const events = [];
  const session = {
    withTransaction: async (work) => {
      events.push("transaction:start");
      await work();
      events.push("transaction:commit");
    },
    endSession: async () => events.push("session:end"),
  };
  const payment = {
    _id: "payment-id",
    user: "user-id",
    plan: {
      _id: "plan-id",
      code: "monthly",
      durationDays: 30,
      fileCredits: 0,
    },
    amount: 90000,
    discountAmount: 10000,
    coupon,
    status: initialStatus,
    paidAt: null,
    payosData: {},
    save: async (options) => {
      assert.equal(options.session, session);
      events.push(`payment:save:${payment.status}`);
    },
  };
  const user = {
    plan: null,
    planExpiresAt: null,
    save: async (options) => {
      assert.equal(options.session, session);
      events.push("user:save");
    },
  };
  const PaymentModel = {
    db: { startSession: async () => session },
    findById: (id) => ({
      session: (actualSession) => ({
        populate: async () => {
          assert.equal(id, "payment-id");
          assert.equal(actualSession, session);
          return payment;
        },
      }),
    }),
  };
  const UserModel = {
    findById: (id) => ({
      session: async (actualSession) => {
        assert.equal(id, "user-id");
        assert.equal(actualSession, session);
        return user;
      },
    }),
  };
  const usageCalls = [];
  const synchronizer = createPaymentStatusSynchronizer({
    PaymentModel,
    UserModel,
    recordCouponUsage: async (payload) => {
      usageCalls.push(payload);
      events.push("coupon:record");
      return { recorded: true };
    },
  });
  return { synchronizer, payment, user, events, usageCalls, session };
}

test("cancelled payment does not consume a coupon usage", async () => {
  const { synchronizer, payment, usageCalls, events } = createHarness();

  await synchronizer.applyNonPaidPaymentStatus(
    payment,
    "cancelled",
    { status: "CANCELLED", amount: 90000 },
    {},
  );

  assert.equal(payment.status, "cancelled");
  assert.equal(usageCalls.length, 0);
  assert.deepEqual(events, [
    "transaction:start",
    "payment:save:cancelled",
    "transaction:commit",
    "session:end",
  ]);
});

test("paid payment consumes one coupon usage inside the settlement transaction", async () => {
  const { synchronizer, payment, user, usageCalls, session } = createHarness();

  await synchronizer.applyPaidPayment(
    payment,
    { status: "PAID", amount: 90000 },
    {},
  );

  assert.equal(payment.status, "paid");
  assert.ok(payment.paidAt instanceof Date);
  assert.equal(String(user.plan), "plan-id");
  assert.equal(usageCalls.length, 1);
  assert.deepEqual(usageCalls[0], {
    couponId: "coupon-id",
    userId: "user-id",
    paymentId: "payment-id",
    discountAmount: 10000,
    session,
  });
});

test("amount mismatch fails payment and does not consume coupon", async () => {
  const { synchronizer, payment, usageCalls } = createHarness();

  await synchronizer.applyPaidPayment(
    payment,
    { status: "PAID", amount: 1000 },
    {},
  );

  assert.equal(payment.status, "failed");
  assert.equal(usageCalls.length, 0);
});
