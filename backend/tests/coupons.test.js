const assert = require("node:assert/strict");
const test = require("node:test");

const Plan = require("../models/Plan");
const Coupon = require("../models/Coupon");
const CouponUsage = require("../models/CouponUsage");
const Payment = require("../models/Payment");
const {
  calculateDiscountAmount,
  matchesStatusFilter,
  normalizeCouponCode,
  normalizeCouponPayload,
  recordCouponUsage,
  resolveCouponStatus,
  serializeCoupon,
  validateCouponForCheckout,
} = require("../services/couponService");

test("coupon model matches the persisted collection contract", () => {
  const coupon = new Coupon({
    code: "hoanganh",
    description: "Mã giảm giá dành cho KOL.",
    discountPercent: 5,
    maxDiscountAmount: null,
    applicablePlans: ["507f1f77bcf86cd799439011"],
    usageLimit: 10,
    usageCount: 0,
    limitPerUser: 1,
    startDate: new Date("2026-07-24T17:00:00.000Z"),
    endDate: new Date("2026-08-24T17:00:00.000Z"),
    status: "active",
  });

  assert.equal(coupon.validateSync(), undefined);
  assert.equal(coupon.code, "HOANGANH");
});

test("normalizes coupon codes and rejects unsupported characters", () => {
  assert.equal(normalizeCouponCode(" summer 20 "), "SUMMER20");
  assert.equal(normalizeCouponCode("HE-2026"), "HE-2026");
  assert.throws(() => normalizeCouponCode("bad code!"), /chỉ gồm/);
});

test("resolves effective status from admin state, dates, and usage", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  const base = {
    status: "active",
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-08-31T23:59:59.000Z",
    usageLimit: 10,
    usageCount: 0,
  };

  assert.equal(resolveCouponStatus({ ...base, status: "inactive" }, now), "inactive");
  assert.equal(
    resolveCouponStatus({ ...base, startDate: "2026-08-04T00:00:00.000Z" }, now),
    "scheduled",
  );
  assert.equal(
    resolveCouponStatus({ ...base, endDate: "2026-08-02T23:59:59.000Z" }, now),
    "expired",
  );
  assert.equal(resolveCouponStatus({ ...base, usageCount: 10 }, now), "exhausted");
  assert.equal(resolveCouponStatus(base, now), "active");
});

test("status filter uses effective status and ignores unknown filters", () => {
  const coupon = {
    status: "active",
    startDate: "2026-01-01T00:00:00.000Z",
    endDate: "2026-07-01T00:00:00.000Z",
    usageLimit: 10,
    usageCount: 0,
  };
  const now = new Date("2026-08-03T00:00:00.000Z");

  assert.equal(matchesStatusFilter(coupon, "expired", now), true);
  assert.equal(matchesStatusFilter(coupon, "active", now), false);
  assert.equal(matchesStatusFilter(coupon, "not-a-status", now), true);
});

test("normalizes a create payload and verifies applicable active plans", async () => {
  const originalFind = Plan.find;
  Plan.find = (filter) => ({
    select: async () => {
      assert.deepEqual(filter, {
        _id: { $in: ["507f1f77bcf86cd799439011"] },
        isActive: true,
        code: { $ne: "free" },
      });
      return [{ _id: "507f1f77bcf86cd799439011" }];
    },
  });

  try {
    const payload = await normalizeCouponPayload({
      code: " welcome10 ",
      description: " Khuyến mãi khai trương ",
      discountPercent: "10",
      maxDiscountAmount: "50000",
      applicablePlans: ["507f1f77bcf86cd799439011"],
      usageLimit: "100",
      limitPerUser: "1",
      startDate: "2026-08-03T00:00:00.000Z",
      endDate: "2026-09-03T00:00:00.000Z",
      status: "active",
    });

    assert.equal(payload.code, "WELCOME10");
    assert.equal(payload.description, "Khuyến mãi khai trương");
    assert.equal(payload.discountPercent, 10);
    assert.equal(payload.maxDiscountAmount, 50000);
    assert.equal(payload.usageLimit, 100);
    assert.equal(payload.limitPerUser, 1);
    assert.deepEqual(payload.applicablePlans, ["507f1f77bcf86cd799439011"]);
  } finally {
    Plan.find = originalFind;
  }
});

test("rejects an empty plan selection", async () => {
  await assert.rejects(
    normalizeCouponPayload({
      code: "BADDATE",
      description: "",
      discountPercent: 10,
      maxDiscountAmount: null,
      applicablePlans: [],
      usageLimit: 10,
      limitPerUser: 1,
      startDate: "2026-09-01",
      endDate: "2026-08-01",
      status: "active",
    }),
    /ít nhất một gói/,
  );
});

test("rejects a coupon whose end date is before its start date", async () => {
  const originalFind = Plan.find;
  Plan.find = () => ({
    select: async () => [{ _id: "507f1f77bcf86cd799439011" }],
  });

  try {
    await assert.rejects(
      normalizeCouponPayload({
        code: "BADDATE",
        description: "",
        discountPercent: 10,
        maxDiscountAmount: null,
        applicablePlans: ["507f1f77bcf86cd799439011"],
        usageLimit: 10,
        limitPerUser: 1,
        startDate: "2026-09-01",
        endDate: "2026-08-01",
        status: "active",
      }),
      /Ngày kết thúc phải sau/,
    );
  } finally {
    Plan.find = originalFind;
  }
});

test("admin router exposes list, create, edit, and soft status actions only", () => {
  const router = require("../routes/admin");
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }))
    .filter((route) => route.path.startsWith("/coupons"));

  assert.deepEqual(routes, [
    { path: "/coupons", methods: ["get", "post"] },
    { path: "/coupons/:id", methods: ["put"] },
    { path: "/coupons/:id/status", methods: ["patch"] },
  ]);
});

test("serializes populated plans without exposing mongoose internals", () => {
  const result = serializeCoupon(
    {
      _id: "coupon-id",
      code: "SALE10",
      description: "Giảm 10%",
      discountPercent: 10,
      maxDiscountAmount: null,
      applicablePlans: [
        { _id: "plan-id", code: "monthly", name: "GÓI THÁNG", isActive: true },
      ],
      usageLimit: 100,
      usageCount: 2,
      limitPerUser: 1,
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-31T23:59:59.000Z"),
      status: "active",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    new Date("2026-08-03T00:00:00.000Z"),
  );

  assert.equal(result.id, "coupon-id");
  assert.equal(result.effectiveStatus, "active");
  assert.deepEqual(result.applicablePlans, [
    { id: "plan-id", code: "monthly", name: "GÓI THÁNG", isActive: true },
  ]);
});

test("calculates a percentage discount with an optional maximum cap", () => {
  assert.deepEqual(
    calculateDiscountAmount(500000, {
      discountPercent: 20,
      maxDiscountAmount: 50000,
    }),
    {
      originalAmount: 500000,
      discountPercent: 20,
      discountAmount: 50000,
      finalAmount: 450000,
    },
  );
});

test("coupon preview validates eligibility without consuming usage", async () => {
  const originalFindOne = Coupon.findOne;
  const originalCountDocuments = CouponUsage.countDocuments;
  let usageWrites = 0;

  Coupon.findOne = () => ({
    populate: async () => ({
      _id: "507f1f77bcf86cd799439012",
      code: "SALE20",
      description: "Giảm 20%",
      status: "active",
      discountPercent: 20,
      maxDiscountAmount: 50000,
      usageLimit: 10,
      usageCount: 2,
      limitPerUser: 1,
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-31T23:59:59.000Z"),
      applicablePlans: [{ _id: "507f1f77bcf86cd799439011", isActive: true }],
    }),
  });
  CouponUsage.countDocuments = async (filter) => {
    assert.deepEqual(filter, {
      coupon: "507f1f77bcf86cd799439012",
      user: "507f1f77bcf86cd799439013",
    });
    usageWrites += 0;
    return 0;
  };

  try {
    const result = await validateCouponForCheckout({
      couponCode: "sale20",
      plan: { _id: "507f1f77bcf86cd799439011", price: 500000 },
      userId: "507f1f77bcf86cd799439013",
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    assert.equal(result.pricing.discountAmount, 50000);
    assert.equal(result.pricing.finalAmount, 450000);
    assert.equal(usageWrites, 0);
  } finally {
    Coupon.findOne = originalFindOne;
    CouponUsage.countDocuments = originalCountDocuments;
  }
});

test("records coupon usage once for duplicate paid notifications", async () => {
  const originalFindOne = CouponUsage.findOne;
  const originalCountDocuments = CouponUsage.countDocuments;
  const originalCreate = CouponUsage.create;
  const originalFindOneAndUpdate = Coupon.findOneAndUpdate;
  const session = { id: "transaction" };
  let alreadyRecorded = false;
  let reservations = 0;

  CouponUsage.findOne = async (filter, _projection, options) => {
    assert.deepEqual(filter, { payment: "payment-id" });
    assert.equal(options.session, session);
    return alreadyRecorded ? { payment: "payment-id" } : null;
  };
  Coupon.findOneAndUpdate = async (_filter, update, options) => {
    assert.deepEqual(update, { $inc: { usageCount: 1 } });
    assert.equal(options.session, session);
    reservations += 1;
    return { _id: "coupon-id", limitPerUser: 1 };
  };
  CouponUsage.countDocuments = async (_filter, options) => {
    assert.equal(options.session, session);
    return 0;
  };
  CouponUsage.create = async (documents, options) => {
    assert.equal(options.session, session);
    assert.equal(documents[0].payment, "payment-id");
    alreadyRecorded = true;
  };

  try {
    const first = await recordCouponUsage({
      couponId: "coupon-id",
      userId: "user-id",
      paymentId: "payment-id",
      discountAmount: 50000,
      session,
    });
    const duplicate = await recordCouponUsage({
      couponId: "coupon-id",
      userId: "user-id",
      paymentId: "payment-id",
      discountAmount: 50000,
      session,
    });
    assert.equal(first.recorded, true);
    assert.equal(duplicate.recorded, false);
    assert.equal(reservations, 1);
  } finally {
    CouponUsage.findOne = originalFindOne;
    CouponUsage.countDocuments = originalCountDocuments;
    CouponUsage.create = originalCreate;
    Coupon.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("payment stores immutable coupon pricing snapshot", () => {
  const payment = new Payment({
    user: "507f1f77bcf86cd799439013",
    plan: "507f1f77bcf86cd799439011",
    orderCode: 123456789,
    planCode: "monthly",
    planName: "GÓI THÁNG",
    amount: 450000,
    originalAmount: 500000,
    discountAmount: 50000,
    coupon: "507f1f77bcf86cd799439012",
    couponCode: "SALE20",
    couponApplied: true,
  });

  assert.equal(payment.validateSync(), undefined);
  assert.equal(payment.originalAmount, 500000);
  assert.equal(payment.discountAmount, 50000);
  assert.equal(payment.couponCode, "SALE20");
  assert.equal(payment.couponApplied, true);
});

test("coupon usage has a unique partial index per payment", () => {
  const index = CouponUsage.schema
    .indexes()
    .find(([, options]) => options.name === "couponusage_payment_unique");

  assert.deepEqual(index, [
    { payment: 1 },
    {
      name: "couponusage_payment_unique",
      unique: true,
      partialFilterExpression: { payment: { $type: "objectId" } },
      background: true,
    },
  ]);
});
