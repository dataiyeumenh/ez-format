const Plan = require("../models/Plan");

const DEFAULT_PLANS = Object.freeze([
  {
    code: "free",
    name: "GÓI MIỄN PHÍ",
    price: 0,
    displayPrice: "0đ",
    periodLabel: "/mo",
    description: "Phù hợp để tham khảo các chức năng cơ bản",
    features: ["Chức năng cơ bản", "Giới hạn 3 files", "Thu thập dữ liệu"],
    durationDays: 0,
    fileCredits: 0,
    isPopular: false,
    isActive: true,
    sortOrder: 1,
  },
  {
    code: "monthly",
    name: "GÓI THÁNG",
    price: 149000,
    displayPrice: "149k",
    periodLabel: "/tháng",
    description: "Phù hợp cho mọi loại tình huống, tăng hiệu suất công việc",
    features: ["Chức năng bảng thống kê", "Không quảng cáo"],
    durationDays: 30,
    fileCredits: 0,
    isPopular: false,
    isActive: true,
    sortOrder: 2,
  },
  {
    code: "yearly",
    name: "GÓI NĂM",
    price: 1308000,
    displayPrice: "109k",
    periodLabel: "/tháng",
    description: "Lựa chọn tối ưu dành cho người dùng chuyên sâu và gói chuyên môn",
    features: ["Các chức năng của gói tháng", "Không giới hạn files", "Bảo mật cao"],
    durationDays: 365,
    fileCredits: 0,
    isPopular: true,
    isActive: true,
    sortOrder: 3,
  },
  {
    code: "perfile",
    name: "THEO LƯỢT",
    price: 10000,
    displayPrice: "10k",
    periodLabel: "/ 1 file",
    description: "Phù hợp cho mỗi lần sử dụng",
    features: ["Các chức năng của gói miễn phí", "Không quảng cáo"],
    durationDays: 0,
    fileCredits: 1,
    isPopular: false,
    isActive: true,
    sortOrder: 4,
  },
]);

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return Boolean(value);
}

function toInteger(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error("Giá trị số phải là số nguyên không âm");
  }
  return number;
}

function normalizeFeatures(payload) {
  const rawFeatures =
    Array.isArray(payload.features) ? payload.features : String(payload.featuresText || "").split(/\r?\n/);
  return rawFeatures.map((feature) => String(feature).trim()).filter(Boolean);
}

function normalizePlanPayload(payload = {}, { partial = false } = {}) {
  const output = {};

  if (!partial || payload.code !== undefined) {
    output.code = String(payload.code || "").trim().toLowerCase();
  }
  if (!partial || payload.name !== undefined) output.name = String(payload.name || "").trim();
  if (!partial || payload.price !== undefined) output.price = toInteger(payload.price);
  if (!partial || payload.displayPrice !== undefined) {
    output.displayPrice = String(payload.displayPrice || "").trim();
  }
  if (!partial || payload.periodLabel !== undefined) {
    output.periodLabel = String(payload.periodLabel || "").trim();
  }
  if (!partial || payload.description !== undefined) {
    output.description = String(payload.description || "").trim();
  }
  if (!partial || payload.features !== undefined || payload.featuresText !== undefined) {
    output.features = normalizeFeatures(payload);
  }
  if (!partial || payload.durationDays !== undefined) {
    output.durationDays = toInteger(payload.durationDays);
  }
  if (!partial || payload.fileCredits !== undefined) {
    output.fileCredits = toInteger(payload.fileCredits);
  }
  if (!partial || payload.isPopular !== undefined) output.isPopular = toBoolean(payload.isPopular);
  if (!partial || payload.isActive !== undefined) output.isActive = toBoolean(payload.isActive);
  if (!partial || payload.sortOrder !== undefined) output.sortOrder = toInteger(payload.sortOrder);

  return output;
}

function serializePlan(plan) {
  if (!plan) return null;
  return {
    id: String(plan._id || plan.id),
    code: plan.code,
    name: plan.name,
    price: plan.price,
    displayPrice: plan.displayPrice,
    periodLabel: plan.periodLabel,
    description: plan.description,
    features: plan.features || [],
    durationDays: plan.durationDays || 0,
    fileCredits: plan.fileCredits || 0,
    isPopular: Boolean(plan.isPopular),
    isActive: plan.isActive !== false,
    sortOrder: plan.sortOrder || 0,
  };
}

async function seedDefaultPlans() {
  const count = await Plan.countDocuments();
  if (count > 0) return;
  await Plan.insertMany(DEFAULT_PLANS);
}

async function findActivePlanByCodeOrId(identifier) {
  await seedDefaultPlans();
  const value = String(identifier || "").trim();
  const query = value.match(/^[0-9a-fA-F]{24}$/)
    ? { _id: value, isActive: true }
    : { code: value.toLowerCase(), isActive: true };
  return Plan.findOne(query);
}

async function getDefaultFreePlan() {
  await seedDefaultPlans();
  return Plan.findOne({ code: "free" });
}

module.exports = {
  DEFAULT_PLANS,
  normalizePlanPayload,
  serializePlan,
  seedDefaultPlans,
  findActivePlanByCodeOrId,
  getDefaultFreePlan,
};
