const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeCouponCode,
  resolveCouponStatus,
  serializeCoupon,
  matchesStatusFilter,
  calculateDiscountAmount,
  recordCouponUsage,
} = require("../services/couponService");
const Coupon = require("../models/Coupon");
const CouponUsage = require("../models/CouponUsage");

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

test("records a payment coupon usage once when duplicate settlement snapshots arrive", async () => {
  const originalCreate = CouponUsage.create;
  const originalFindOne = CouponUsage.findOne;
  const originalCountDocuments = CouponUsage.countDocuments;
  const originalFindOneAndUpdate = Coupon.findOneAndUpdate;
  const session = { id: "payment-transaction" };
  let usageExists = false;
  let couponReservations = 0;

  CouponUsage.findOne = async (filter, _projection, options) => {
    assert.deepEqual(filter, { payment: "payment-id" });
    assert.equal(options.session, session);
    return usageExists ? { payment: "payment-id" } : null;
  };
  Coupon.findOneAndUpdate = async (filter, update, options) => {
    assert.equal(filter._id, "coupon-id");
    assert.ok(filter.$expr, "global coupon limit must be part of the atomic update filter");
    assert.deepEqual(update, { $inc: { usageCount: 1 } });
    assert.equal(options.new, true);
    assert.equal(options.session, session);
    couponReservations += 1;
    return { _id: "coupon-id", usageLimit: 10, limitPerUser: 1 };
  };
  CouponUsage.countDocuments = async (filter, options) => {
    assert.deepEqual(filter, { coupon: "coupon-id", user: "user-id" });
    assert.equal(options.session, session);
    return 0;
  };
  CouponUsage.create = async (docs, options) => {
    assert.equal(Array.isArray(docs), true);
    assert.deepEqual(docs[0], {
      coupon: "coupon-id",
      user: "user-id",
      payment: "payment-id",
      discountAmount: 2500,
      usedAt: docs[0].usedAt,
    });
    assert.equal(options.session, session);
    usageExists = true;
  };

  try {
    await recordCouponUsage({
      couponId: "coupon-id",
      userId: "user-id",
      paymentId: "payment-id",
      discountAmount: 2500,
      session,
    });
    const duplicate = await recordCouponUsage({
      couponId: "coupon-id",
      userId: "user-id",
      paymentId: "payment-id",
      discountAmount: 2500,
      session,
    });
    assert.equal(duplicate.recorded, false);
  } finally {
    CouponUsage.create = originalCreate;
    CouponUsage.findOne = originalFindOne;
    CouponUsage.countDocuments = originalCountDocuments;
    Coupon.findOneAndUpdate = originalFindOneAndUpdate;
  }

  assert.equal(couponReservations, 1);
});

test("rejects a coupon settlement when the per-user limit is already reached", async () => {
  const originalFindOne = CouponUsage.findOne;
  const originalCountDocuments = CouponUsage.countDocuments;
  const originalFindOneAndUpdate = Coupon.findOneAndUpdate;
  const session = { id: "payment-transaction" };

  CouponUsage.findOne = async () => null;
  Coupon.findOneAndUpdate = async (_filter, _update, options) => {
    assert.equal(options.session, session);
    return { _id: "coupon-id", usageLimit: 10, limitPerUser: 1 };
  };
  CouponUsage.countDocuments = async () => 1;

  try {
    await assert.rejects(
      recordCouponUsage({
        couponId: "coupon-id",
        userId: "user-id",
        paymentId: "payment-id",
        discountAmount: 2500,
        session,
      }),
      /hết số lần cho phép/,
    );
  } finally {
    CouponUsage.findOne = originalFindOne;
    CouponUsage.countDocuments = originalCountDocuments;
    Coupon.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("rejects a coupon settlement when the global limit cannot be reserved", async () => {
  const originalFindOne = CouponUsage.findOne;
  const originalFindOneAndUpdate = Coupon.findOneAndUpdate;
  const session = { id: "payment-transaction" };

  CouponUsage.findOne = async () => null;
  Coupon.findOneAndUpdate = async (_filter, _update, options) => {
    assert.equal(options.session, session);
    return null;
  };

  try {
    await assert.rejects(
      recordCouponUsage({
        couponId: "coupon-id",
        userId: "user-id",
        paymentId: "payment-id",
        discountAmount: 2500,
        session,
      }),
      /hết lượt sử dụng/,
    );
  } finally {
    CouponUsage.findOne = originalFindOne;
    Coupon.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
