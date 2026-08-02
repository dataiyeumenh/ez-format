const assert = require("node:assert/strict");
const test = require("node:test");

const Payment = require("../models/Payment");
const planService = require("../services/planService");
const payosClient = require("../services/payosClient");
const couponService = require("../services/couponService");

const original = {
  paymentExists: Payment.exists,
  paymentCreate: Payment.create,
  findPlan: planService.findActivePlanByCodeOrId,
  getPayOSClient: payosClient.getPayOSClient,
  normalizeCouponCode: couponService.normalizeCouponCode,
  validateCoupon: couponService.validateCouponForCheckout,
};

test.after(() => {
  Payment.exists = original.paymentExists;
  Payment.create = original.paymentCreate;
  planService.findActivePlanByCodeOrId = original.findPlan;
  payosClient.getPayOSClient = original.getPayOSClient;
  couponService.normalizeCouponCode = original.normalizeCouponCode;
  couponService.validateCouponForCheckout = original.validateCoupon;
  delete require.cache[require.resolve("../controllers/paymentController")];
});

test("creating a pending PayOS link stores pricing but does not settle coupon usage", async () => {
  const plan = {
    _id: "plan-id",
    code: "monthly",
    name: "GÓI THÁNG",
    price: 149000,
  };
  let createdPaymentData;
  let saved = 0;

  Payment.exists = async () => false;
  Payment.create = async (data) => {
    createdPaymentData = data;
    return {
      ...data,
      _id: "payment-id",
      save: async () => {
        saved += 1;
      },
    };
  };
  planService.findActivePlanByCodeOrId = async () => plan;
  couponService.normalizeCouponCode = () => "SALE50";
  couponService.validateCouponForCheckout = async () => ({
    coupon: { _id: "coupon-id" },
    pricing: {
      originalAmount: 149000,
      discountAmount: 74500,
      finalAmount: 74500,
    },
  });
  payosClient.getPayOSClient = () => ({
    paymentRequests: {
      create: async (payload) => ({
        checkoutUrl: "https://pay.example/checkout",
        paymentLinkId: "payment-link-id",
        amount: payload.amount,
      }),
    },
  });

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
    {
      body: { planId: "plan-id", couponCode: "sale50" },
      user: { _id: "user-id", name: "User", email: "user@example.com" },
    },
    response,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(createdPaymentData.status, "pending");
  assert.equal(createdPaymentData.originalAmount, 149000);
  assert.equal(createdPaymentData.discountAmount, 74500);
  assert.equal(createdPaymentData.amount, 74500);
  assert.equal(createdPaymentData.couponCode, "SALE50");
  assert.equal(createdPaymentData.couponApplied, true);
  assert.equal(saved, 1);
});
