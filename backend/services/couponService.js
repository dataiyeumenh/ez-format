const mongoose = require("mongoose");
const Plan = require("../models/Plan");
const Coupon = require("../models/Coupon");
const CouponUsage = require("../models/CouponUsage");

const ADMIN_STATUSES = new Set(["active", "inactive"]);
const FILTER_STATUSES = new Set([
  "active",
  "inactive",
  "scheduled",
  "expired",
  "exhausted",
]);

function toInteger(value, { min = 0, field = "Giá trị" } = {}) {
  if (value === "" || value === null || value === undefined) {
    throw new Error(`${field} là bắt buộc`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`${field} phải là số nguyên >= ${min}`);
  }
  return number;
}

function toOptionalMaxDiscount(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Số tiền giảm tối đa phải lớn hơn 0");
  }
  return Math.round(number);
}

function toDate(value, field) {
  if (!value) throw new Error(`${field} là bắt buộc`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} không hợp lệ`);
  return date;
}

function normalizeCouponCode(code) {
  const normalized = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!normalized) throw new Error("Mã coupon là bắt buộc");
  if (!/^[A-Z0-9_-]+$/.test(normalized)) {
    throw new Error("Mã coupon chỉ gồm chữ in hoa, số, gạch ngang hoặc gạch dưới");
  }
  return normalized;
}

function resolveCouponStatus(coupon, now = new Date()) {
  if (String(coupon?.status || "active").toLowerCase() === "inactive") {
    return "inactive";
  }

  const startDate = coupon?.startDate ? new Date(coupon.startDate) : null;
  if (
    startDate &&
    !Number.isNaN(startDate.getTime()) &&
    startDate.getTime() > now.getTime()
  ) {
    return "scheduled";
  }

  const endDate = coupon?.endDate ? new Date(coupon.endDate) : null;
  if (
    endDate &&
    !Number.isNaN(endDate.getTime()) &&
    endDate.getTime() < now.getTime()
  ) {
    return "expired";
  }

  const usageLimit = Number(coupon?.usageLimit || 0);
  const usageCount = Number(coupon?.usageCount || 0);
  if (usageLimit > 0 && usageCount >= usageLimit) return "exhausted";
  return "active";
}

function calculateDiscountAmount(originalAmount, coupon) {
  const price = Math.max(0, Number(originalAmount || 0));
  const percent = Number(coupon?.discountPercent || 0);
  let discountAmount = Math.round((price * percent) / 100);
  if (
    coupon?.maxDiscountAmount !== null &&
    coupon?.maxDiscountAmount !== undefined &&
    Number(coupon.maxDiscountAmount) > 0
  ) {
    discountAmount = Math.min(discountAmount, Math.round(coupon.maxDiscountAmount));
  }
  discountAmount = Math.max(0, Math.min(discountAmount, price));
  return {
    originalAmount: price,
    discountPercent: percent,
    discountAmount,
    finalAmount: price - discountAmount,
  };
}

function serializeCoupon(coupon, now = new Date()) {
  const plain = typeof coupon.toObject === "function" ? coupon.toObject() : coupon;
  const applicablePlans = Array.isArray(plain.applicablePlans)
    ? plain.applicablePlans.map((plan) => {
        if (plan && typeof plan === "object" && plan._id) {
          return {
            id: String(plan._id),
            code: plan.code || "",
            name: plan.name || "",
            isActive: plan.isActive !== false,
          };
        }
        return { id: String(plan), code: "", name: "", isActive: true };
      })
    : [];

  return {
    id: String(plain._id),
    code: plain.code,
    description: plain.description || "",
    discountPercent: Number(plain.discountPercent || 0),
    maxDiscountAmount:
      plain.maxDiscountAmount === null || plain.maxDiscountAmount === undefined
        ? null
        : Number(plain.maxDiscountAmount),
    applicablePlans,
    usageLimit: Number(plain.usageLimit || 0),
    usageCount: Number(plain.usageCount || 0),
    limitPerUser: Number(plain.limitPerUser || 1),
    startDate: plain.startDate,
    endDate: plain.endDate,
    status: plain.status || "active",
    effectiveStatus: resolveCouponStatus(plain, now),
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function normalizeCouponPayload(body, { partial = false } = {}) {
  const payload = {};

  if (!partial || body.code !== undefined) {
    payload.code = normalizeCouponCode(body.code);
  }
  if (!partial || body.description !== undefined) {
    payload.description = String(body.description || "").trim();
  }
  if (!partial || body.discountPercent !== undefined) {
    const percent = Number(body.discountPercent);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      throw new Error("Phần trăm giảm phải từ 1 đến 100");
    }
    payload.discountPercent = percent;
  }
  if (!partial || body.maxDiscountAmount !== undefined) {
    payload.maxDiscountAmount = toOptionalMaxDiscount(body.maxDiscountAmount);
  }
  if (!partial || body.applicablePlans !== undefined) {
    const planIds = Array.isArray(body.applicablePlans)
      ? [...new Set(body.applicablePlans.map(String).filter(Boolean))]
      : [];
    if (planIds.length === 0) {
      throw new Error("Phải chọn ít nhất một gói áp dụng");
    }
    if (planIds.some((id) => !mongoose.isValidObjectId(id))) {
      throw new Error("Gói áp dụng không hợp lệ");
    }
    const found = await Plan.find({
      _id: { $in: planIds },
      isActive: true,
      code: { $ne: "free" },
    }).select("_id");
    if (found.length !== planIds.length) {
      throw new Error("Chỉ được chọn gói đang hoạt động, không gồm gói miễn phí");
    }
    payload.applicablePlans = found.map((plan) => plan._id);
  }
  if (!partial || body.usageLimit !== undefined) {
    payload.usageLimit = toInteger(body.usageLimit, {
      min: 1,
      field: "Giới hạn lượt dùng",
    });
  }
  if (!partial || body.limitPerUser !== undefined) {
    payload.limitPerUser = toInteger(body.limitPerUser, {
      min: 1,
      field: "Giới hạn mỗi người dùng",
    });
  }
  if (!partial || body.startDate !== undefined) {
    payload.startDate = toDate(body.startDate, "Ngày bắt đầu");
  }
  if (!partial || body.endDate !== undefined) {
    payload.endDate = toDate(body.endDate, "Ngày kết thúc");
  }
  if (!partial || body.status !== undefined) {
    const status = String(body.status || "active").toLowerCase();
    if (!ADMIN_STATUSES.has(status)) {
      throw new Error("Trạng thái chỉ nhận active hoặc inactive");
    }
    payload.status = status;
  }

  if (payload.startDate && payload.endDate && payload.endDate < payload.startDate) {
    throw new Error("Ngày kết thúc phải sau hoặc bằng ngày bắt đầu");
  }
  return payload;
}

function matchesStatusFilter(coupon, statusFilter, now = new Date()) {
  const normalized = String(statusFilter || "").trim().toLowerCase();
  if (!FILTER_STATUSES.has(normalized)) return true;
  return resolveCouponStatus(coupon, now) === normalized;
}

async function countUserCouponUses(couponId, userId) {
  // Chỉ CouponUsage của giao dịch paid mới được tính vào giới hạn mỗi user.
  return CouponUsage.countDocuments({ coupon: couponId, user: userId });
}

async function validateCouponForCheckout({
  couponCode,
  plan,
  userId,
  now = new Date(),
}) {
  const code = normalizeCouponCode(couponCode);
  const coupon = await Coupon.findOne({ code }).populate(
    "applicablePlans",
    "code name isActive",
  );
  if (!coupon) throw new Error("Mã giảm giá không tồn tại");

  const effectiveStatus = resolveCouponStatus(coupon, now);
  if (effectiveStatus === "inactive") throw new Error("Mã giảm giá đang tạm ngưng");
  if (effectiveStatus === "scheduled") {
    throw new Error("Mã giảm giá chưa đến thời gian áp dụng");
  }
  if (effectiveStatus === "expired") throw new Error("Mã giảm giá đã hết hạn");
  if (effectiveStatus === "exhausted") {
    throw new Error("Mã giảm giá đã hết lượt sử dụng");
  }

  const planId = String(plan?._id || plan?.id || "");
  const planAllowed = (coupon.applicablePlans || []).some(
    (item) => String(item?._id || item) === planId,
  );
  if (!planAllowed) throw new Error("Mã giảm giá không áp dụng cho gói này");

  const userUses = await countUserCouponUses(coupon._id, userId);
  if (userUses >= Number(coupon.limitPerUser || 1)) {
    throw new Error("Bạn đã dùng hết số lần cho phép của mã này");
  }

  return {
    coupon,
    pricing: calculateDiscountAmount(plan.price, coupon),
    serialized: serializeCoupon(coupon, now),
  };
}

async function recordCouponUsage({
  couponId,
  userId,
  paymentId,
  discountAmount,
  session,
}) {
  if (!session) {
    throw new Error("Ghi nhận coupon phải chạy trong MongoDB transaction");
  }

  const existingUsage = paymentId
    ? await CouponUsage.findOne({ payment: paymentId }, null, { session })
    : null;
  if (existingUsage) return { recorded: false };

  const coupon = await Coupon.findOneAndUpdate(
    {
      _id: couponId,
      $expr: {
        $lt: [{ $ifNull: ["$usageCount", 0] }, "$usageLimit"],
      },
    },
    { $inc: { usageCount: 1 } },
    { new: true, session },
  );
  if (!coupon) throw new Error("Mã giảm giá đã hết lượt sử dụng");

  const userUses = await CouponUsage.countDocuments(
    { coupon: couponId, user: userId },
    { session },
  );
  if (userUses >= Number(coupon.limitPerUser || 1)) {
    throw new Error("Bạn đã dùng hết số lần cho phép của mã này");
  }

  await CouponUsage.create(
    [
      {
        coupon: couponId,
        user: userId,
        payment: paymentId || null,
        discountAmount: Number(discountAmount || 0),
        usedAt: new Date(),
      },
    ],
    { session },
  );
  return { recorded: true };
}

module.exports = {
  calculateDiscountAmount,
  countUserCouponUses,
  matchesStatusFilter,
  normalizeCouponCode,
  normalizeCouponPayload,
  recordCouponUsage,
  resolveCouponStatus,
  serializeCoupon,
  validateCouponForCheckout,
};
