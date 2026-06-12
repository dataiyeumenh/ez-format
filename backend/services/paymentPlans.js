const PLAN_CONFIGS = Object.freeze({
  monthly: {
    id: "monthly",
    name: "GÓI THÁNG",
    userPlan: "Monthly",
    amount: 149000,
    durationDays: 30,
    itemName: "Gói tháng EzFormat",
  },
  yearly: {
    id: "yearly",
    name: "GÓI NĂM",
    userPlan: "Yearly",
    amount: 1308000,
    durationDays: 365,
    itemName: "Gói năm EzFormat",
  },
  perfile: {
    id: "perfile",
    name: "THEO LƯỢT",
    userPlan: "PerFile",
    amount: 10000,
    fileCredits: 1,
    itemName: "1 lượt chuyển đổi EzFormat",
  },
});

function normalizePlanType(planType) {
  const normalized = String(planType || "").trim().toLowerCase();
  if (!PLAN_CONFIGS[normalized]) {
    throw new Error("Unsupported plan type");
  }
  return normalized;
}

function getPlanConfig(planType) {
  return PLAN_CONFIGS[normalizePlanType(planType)];
}

function buildPaymentDescription(planType) {
  const normalized = String(planType || "").trim().toLowerCase();
  if (!normalized) throw new Error("Unsupported plan type");
  return `EZF ${normalized}`.slice(0, 25);
}

module.exports = {
  PLAN_CONFIGS,
  normalizePlanType,
  getPlanConfig,
  buildPaymentDescription,
};
