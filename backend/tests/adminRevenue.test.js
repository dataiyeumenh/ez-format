const assert = require("node:assert/strict");
const test = require("node:test");

const { formatRevenuePayment } = require("../controllers/adminController");

test("serializes original, discounted, and coupon values for revenue", () => {
  const payment = formatRevenuePayment({
    _id: "payment-id",
    orderCode: 123,
    planCode: "monthly",
    planName: "GOI THANG",
    amount: 119200,
    originalAmount: 149000,
    discountAmount: 29800,
    couponCode: "SALE20",
    user: { _id: "user-id", name: "Nguyen Van A", email: "a@example.com" },
  });

  assert.equal(payment.originalAmount, 149000);
  assert.equal(payment.amount, 119200);
  assert.equal(payment.discountAmount, 29800);
  assert.equal(payment.couponCode, "SALE20");
});

test("uses paid amount as original amount for legacy payments", () => {
  const payment = formatRevenuePayment({
    _id: "legacy-payment",
    orderCode: 456,
    planCode: "monthly",
    planName: "GOI THANG",
    amount: 149000,
    user: {},
  });

  assert.equal(payment.originalAmount, 149000);
  assert.equal(payment.couponCode, "");
});
