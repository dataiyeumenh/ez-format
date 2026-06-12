const assert = require("node:assert/strict");
const test = require("node:test");

const Plan = require("../models/Plan");
const {
  DEFAULT_PLANS,
  normalizePlanPayload,
  serializePlan,
} = require("../services/planService");

test("default plans include editable pricing metadata and one popular plan", () => {
  assert.deepEqual(
    DEFAULT_PLANS.map((plan) => plan.code),
    ["free", "monthly", "yearly", "perfile"],
  );
  assert.equal(DEFAULT_PLANS.find((plan) => plan.code === "yearly").isPopular, true);
  assert.equal(DEFAULT_PLANS.find((plan) => plan.code === "monthly").periodLabel, "/tháng");
});

test("plan model requires code and name to point to the same business plan", () => {
  const invalid = new Plan({
    code: "monthly",
    name: "THEO LƯỢT",
    price: 149000,
    displayPrice: "149k",
    periodLabel: "/tháng",
  });

  assert.match(invalid.validateSync().message, /Tên gói không khớp/);
});

test("normalizes editable plan payload", () => {
  const payload = normalizePlanPayload({
    code: " Monthly ",
    name: "GÓI THÁNG",
    price: "149000",
    displayPrice: "149k",
    periodLabel: "/tháng",
    featuresText: "Không quảng cáo\n\nBảng thống kê",
    durationDays: "30",
    fileCredits: "",
    isPopular: true,
    isActive: false,
    sortOrder: "2",
  });

  assert.equal(payload.code, "monthly");
  assert.equal(payload.price, 149000);
  assert.deepEqual(payload.features, ["Không quảng cáo", "Bảng thống kê"]);
  assert.equal(payload.durationDays, 30);
  assert.equal(payload.fileCredits, 0);
  assert.equal(payload.isPopular, true);
  assert.equal(payload.isActive, false);
});

test("serializes plan for pricing/admin UI", () => {
  const plan = serializePlan({
    _id: "plan-id",
    code: "yearly",
    name: "GÓI NĂM",
    price: 1308000,
    displayPrice: "109k",
    periodLabel: "/tháng",
    description: "Gói năm",
    features: ["Không giới hạn files"],
    durationDays: 365,
    fileCredits: 0,
    isPopular: true,
    isActive: true,
    sortOrder: 3,
  });

  assert.equal(plan.id, "plan-id");
  assert.equal(plan.code, "yearly");
  assert.equal(plan.periodLabel, "/tháng");
  assert.equal(plan.isPopular, true);
});
