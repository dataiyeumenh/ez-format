import assert from "node:assert/strict";
import test from "node:test";

import {
  couponToForm,
  formToCouponPayload,
  getCouponStatusMeta,
  toDateTimeLocal,
} from "./coupons.js";

test("maps effective coupon statuses to Vietnamese labels", () => {
  assert.equal(getCouponStatusMeta("active").label, "Đang hoạt động");
  assert.equal(getCouponStatusMeta("scheduled").label, "Sắp diễn ra");
  assert.equal(getCouponStatusMeta("expired").label, "Hết hạn");
});

test("converts an API coupon to an editable form", () => {
  const form = couponToForm({
    code: "SALE10",
    description: "Giảm giá",
    discountPercent: 10,
    maxDiscountAmount: null,
    applicablePlans: [{ id: "plan-1" }, { id: "plan-2" }],
    usageLimit: 100,
    limitPerUser: 1,
    startDate: "2026-08-03T03:00:00.000Z",
    endDate: "2026-08-31T16:59:00.000Z",
    status: "active",
  });

  assert.equal(form.code, "SALE10");
  assert.equal(form.maxDiscountAmount, "");
  assert.deepEqual(form.applicablePlans, ["plan-1", "plan-2"]);
  assert.match(form.startDate, /^2026-08-03T\d{2}:00$/);
});

test("builds an API payload with normalized numeric and date values", () => {
  const payload = formToCouponPayload({
    code: "sale10",
    description: "Giảm giá",
    discountPercent: "10",
    maxDiscountAmount: "",
    applicablePlans: ["plan-1"],
    usageLimit: "100",
    limitPerUser: "1",
    startDate: "2026-08-03T10:00",
    endDate: "2026-08-31T23:59",
    status: "active",
  });

  assert.equal(payload.discountPercent, 10);
  assert.equal(payload.maxDiscountAmount, null);
  assert.equal(payload.usageLimit, 100);
  assert.match(payload.startDate, /Z$/);
  assert.match(payload.endDate, /Z$/);
});

test("returns an empty datetime value for invalid input", () => {
  assert.equal(toDateTimeLocal("not-a-date"), "");
  assert.equal(toDateTimeLocal(null), "");
});
