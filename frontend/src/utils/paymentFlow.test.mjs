import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPaidBenefit,
  resolvePaymentNavigation,
} from "./paymentFlow.js";

test("keeps zero-total checkout inside the app with its settled order", () => {
  assert.deepEqual(
    resolvePaymentNavigation({
      freeCheckout: true,
      orderCode: 123456,
      checkoutUrl: "https://another-origin.example/payment/success",
    }),
    {
      mode: "internal",
      href: "/payment/success?orderCode=123456&settled=1",
    },
  );
});

test("continues redirecting paid checkout to payOS", () => {
  assert.deepEqual(
    resolvePaymentNavigation({
      checkoutUrl: "https://pay.payos.vn/web/checkout-id",
      orderCode: 789,
    }),
    {
      mode: "external",
      href: "https://pay.payos.vn/web/checkout-id",
    },
  );
});

test("rejects incomplete payment responses", () => {
  assert.throws(
    () => resolvePaymentNavigation({ freeCheckout: true }),
    /orderCode/,
  );
  assert.throws(() => resolvePaymentNavigation({}), /checkoutUrl/);
});

test("recognizes current plan objects and per-file credits as paid benefits", () => {
  assert.equal(hasPaidBenefit({ plan: { code: "monthly" } }), true);
  assert.equal(hasPaidBenefit({ plan: { code: "yearly" } }), true);
  assert.equal(hasPaidBenefit({ plan: { code: "free" }, fileCredits: 1 }), true);
  assert.equal(hasPaidBenefit({ plan: { code: "free" }, fileCredits: 0 }), false);
});
