const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeCouponCode,
  resolveCouponStatus,
  serializeCoupon,
  matchesStatusFilter,
  calculateDiscountAmount,
} = require("../services/couponService");

test("normalizes coupon code to uppercase without spaces", () => {
  assert.equal(normalizeCouponCode(" summer 20 "), "SUMMER20");
  assert.equal(normalizeCouponCode("HE-2026"), "HE-2026");
  assert.throws(() => normalizeCouponCode("bad code!"), /chỉ gồm/);
});

test("resolves effective coupon status from dates and usage", () => {
  const now = new Date("2026-07-24T00:00:00.000Z");

  assert.equal(
    resolveCouponStatus(
      {
        status: "inactive",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        usageLimit: 10,
        usageCount: 0,
      },
      now,
    ),
    "inactive",
  );

  assert.equal(
    resolveCouponStatus(
      {
        status: "active",
        startDate: "2026-01-01",
        endDate: "2026-07-01",
        usageLimit: 10,
        usageCount: 0,
      },
      now,
    ),
    "expired",
  );

  assert.equal(
    resolveCouponStatus(
      {
        status: "active",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        usageLimit: 5,
        usageCount: 5,
      },
      now,
    ),
    "exhausted",
  );

  assert.equal(
    resolveCouponStatus(
      {
        status: "active",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        usageLimit: 5,
        usageCount: 2,
      },
      now,
    ),
    "active",
  );
});

test("serializes coupon with plan ids and effective status", () => {
  const payload = serializeCoupon({
    _id: "c1",
    code: "SALE10",
    description: "Giảm 10%",
    discountPercent: 10,
    maxDiscountAmount: 50000,
    applicablePlans: [{ _id: "p1", code: "monthly", name: "Gói tháng" }],
    usageLimit: 100,
    usageCount: 3,
    limitPerUser: 1,
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-08-01T00:00:00.000Z"),
    status: "active",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });

  assert.equal(payload.id, "c1");
  assert.equal(payload.code, "SALE10");
  assert.equal(payload.maxDiscountAmount, 50000);
  assert.deepEqual(payload.applicablePlans, [
    { id: "p1", code: "monthly", name: "Gói tháng", isActive: true },
  ]);
  assert.equal(typeof payload.effectiveStatus, "string");
});

test("status filter matches effective status", () => {
  const coupon = {
    status: "active",
    startDate: "2026-01-01",
    endDate: "2026-07-01",
    usageLimit: 10,
    usageCount: 0,
  };
  assert.equal(matchesStatusFilter(coupon, "expired"), true);
  assert.equal(matchesStatusFilter(coupon, "active"), false);
  assert.equal(matchesStatusFilter(coupon, ""), true);
});


test("calculates percent discount with optional max cap", () => {
  const uncapped = calculateDiscountAmount(200000, {
    discountPercent: 20,
    maxDiscountAmount: null,
  });
  assert.equal(uncapped.discountAmount, 40000);
  assert.equal(uncapped.finalAmount, 160000);

  const capped = calculateDiscountAmount(200000, {
    discountPercent: 20,
    maxDiscountAmount: 50000,
  });
  // 20% of 200k = 40k < max 50k => 40k
  assert.equal(capped.discountAmount, 40000);

  const cappedHard = calculateDiscountAmount(500000, {
    discountPercent: 20,
    maxDiscountAmount: 50000,
  });
  // 20% of 500k = 100k, capped to 50k
  assert.equal(cappedHard.discountAmount, 50000);
  assert.equal(cappedHard.finalAmount, 450000);
});

test("pending payments must not count toward limit_per_user logic contract", () => {
  // Contract: countUserCouponUses only reads CouponUsage (paid success),
  // never Payment status=pending. Apply-coupon / cancelled checkout must not consume quota.
  const countUserCouponUsesSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../services/couponService.js"),
    "utf8",
  );
  assert.match(countUserCouponUsesSource, /CouponUsage\.countDocuments/);
  assert.doesNotMatch(
    countUserCouponUsesSource,
    /Payment\.countDocuments\([\s\S]*status:\s*"pending"/,
  );
});
