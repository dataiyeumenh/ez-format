const Coupon = require("../models/Coupon");
const Plan = require("../models/Plan");
const {
  normalizeCouponPayload,
  serializeCoupon,
  matchesStatusFilter,
  resolveCouponStatus,
} = require("../services/couponService");
const { seedDefaultPlans, serializePlan } = require("../services/planService");

async function listCoupons(req, res) {
  try {
    const statusFilter = String(req.query.status || "").trim().toLowerCase();
    const coupons = await Coupon.find({})
      .populate("applicablePlans", "code name")
      .sort({ createdAt: -1 });

    const items = coupons
      .filter((coupon) => matchesStatusFilter(coupon, statusFilter))
      .map(serializeCoupon);

    res.json({
      success: true,
      total: items.length,
      coupons: items,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Không thể tải danh sách coupon",
      error: error.message,
    });
  }
}

async function getCoupon(req, res) {
  try {
    const coupon = await Coupon.findById(req.params.id).populate(
      "applicablePlans",
      "code name",
    );
    if (!coupon) {
      return res.status(404).json({ success: false, message: "Không tìm thấy coupon" });
    }
    return res.json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể tải coupon",
      error: error.message,
    });
  }
}

async function createCoupon(req, res) {
  try {
    const payload = await normalizeCouponPayload(req.body);
    const coupon = await Coupon.create({
      ...payload,
      usageCount: 0,
    });
    await coupon.populate("applicablePlans", "code name");
    return res.status(201).json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (error) {
    const status = error.code === 11000 ? 400 : 400;
    const message =
      error.code === 11000
        ? "Mã coupon đã tồn tại"
        : error.message || "Không thể tạo coupon";
    return res.status(status).json({ success: false, message });
  }
}

async function updateCoupon(req, res) {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ success: false, message: "Không tìm thấy coupon" });
    }

    const payload = await normalizeCouponPayload(req.body, { partial: true });
    Object.assign(coupon, payload);

    // Keep usageCount immutable from admin edit unless explicitly sent and valid
    if (req.body.usageCount !== undefined) {
      const nextCount = Number(req.body.usageCount);
      if (!Number.isInteger(nextCount) || nextCount < 0) {
        return res.status(400).json({
          success: false,
          message: "Số lượt đã dùng phải là số nguyên không âm",
        });
      }
      if (nextCount > Number(coupon.usageLimit || 0)) {
        return res.status(400).json({
          success: false,
          message: "Số lượt đã dùng không được vượt giới hạn",
        });
      }
      coupon.usageCount = nextCount;
    }

    await coupon.save();
    await coupon.populate("applicablePlans", "code name");
    return res.json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (error) {
    const message =
      error.code === 11000
        ? "Mã coupon đã tồn tại"
        : error.message || "Không thể cập nhật coupon";
    return res.status(400).json({ success: false, message });
  }
}

async function deleteCoupon(req, res) {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ success: false, message: "Không tìm thấy coupon" });
    }
    if (Number(coupon.usageCount || 0) > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Không thể xoá coupon đã được sử dụng. Hãy đặt Inactive để ngừng áp dụng.",
      });
    }
    await coupon.deleteOne();
    return res.json({ success: true, message: "Đã xoá coupon." });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Không thể xoá coupon",
    });
  }
}

async function listCouponPlanOptions(req, res) {
  try {
    await seedDefaultPlans();
    const plans = await Plan.find({
      isActive: true,
      code: { $ne: "free" },
    }).sort({ sortOrder: 1, createdAt: 1 });
    return res.json({
      success: true,
      plans: plans.map(serializePlan),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách gói",
      error: error.message,
    });
  }
}

module.exports = {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  listCouponPlanOptions,
  resolveCouponStatus,
};
