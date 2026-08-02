const assert = require("node:assert/strict");
const test = require("node:test");

const Payment = require("../models/Payment");
const User = require("../models/User");
const planService = require("../services/planService");
const paymentStatusSync = require("../services/paymentStatusSync");
const couponService = require("../services/couponService");

const original = {
  exists: Payment.exists,
  create: Payment.create,
  findById: User.findById,
  findActivePlanByCodeOrId: planService.findActivePlanByCodeOrId,
  serializePlan: planService.serializePlan,
  applyPaidPayment: paymentStatusSync.applyPaidPayment,
  createAndSettleZeroTotalPayment: paymentStatusSync.createAndSettleZeroTotalPayment,
  validateCouponForCheckout: couponService.validateCouponForCheckout,
};

test.after(() => {
  Payment.exists = original.exists;
  Payment.create = original.create;
  User.findById = original.findById;
  planService.findActivePlanByCodeOrId = original.findActivePlanByCodeOrId;
  planService.serializePlan = original.serializePlan;
  paymentStatusSync.applyPaidPayment = original.applyPaidPayment;
  paymentStatusSync.createAndSettleZeroTotalPayment = original.createAndSettleZeroTotalPayment;
  couponService.validateCouponForCheckout = original.validateCouponForCheckout;
  delete require.cache[require.resolve("../controllers/paymentController")];
});

test("zero-total checkout creates and settles the payment in one transactional service call", async () => {
  const plan = { _id: "plan-id", code: "perfile", name: "Per-file", price: 10000, fileCredits: 1 };
  const coupon = { _id: "coupon-id" };
  let settlement;

  Payment.exists = async () => false;
  Payment.create = async () => {
    throw new Error("controller must not create zero-total payments directly");
  };
  User.findById = async () => {
    throw new Error("controller must not settle zero-total checkouts directly");
  };
  planService.findActivePlanByCodeOrId = async () => plan;
  planService.serializePlan = (value) => value;
  couponService.validateCouponForCheckout = async () => ({
    coupon,
    pricing: { originalAmount: 10000, discountAmount: 10000, finalAmount: 0 },
  });
  paymentStatusSync.createAndSettleZeroTotalPayment = async (paymentData, settlementData) => {
    settlement = { paymentData, settlementData };
    return { ...paymentData, _id: "payment-id", plan, status: "paid", paidAt: new Date() };
  };

  delete require.cache[require.resolve("../controllers/paymentController")];
  const { createPayment } = require("../controllers/paymentController");
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await createPayment(
    { body: { planId: "perfile", couponCode: "FREE100" }, user: { _id: "user-id" } },
    response,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.freeCheckout, true);
  assert.equal(settlement.paymentData.amount, 0);
  assert.equal(settlement.paymentData.orderCode, response.body.orderCode);
  assert.deepEqual(settlement.settlementData, { amount: 0, status: "PAID" });
});
