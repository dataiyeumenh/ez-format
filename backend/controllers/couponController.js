const Coupon = require("../models/Coupon");
const {
  matchesStatusFilter,
  normalizeCouponPayload,
  serializeCoupon,
} = require("../services/couponService");

function errorMessage(error, fallback) {
  if (error?.code === 11000) return "Mã coupon đã tồn tại";
  if (error?.name === "ValidationError") {
    return Object.values(error.errors || {})[0]?.message || fallback;
  }
  return error?.message || fallback;
}

async function listCoupons(req, res) {
  try {
    const status = String(req.query.status || "").trim().toLowerCase();
    const coupons = await Coupon.find({})
      .populate("applicablePlans", "code name isActive")
      .sort({ createdAt: -1 });
    const items = coupons
      .filter((coupon) => matchesStatusFilter(coupon, status))
      .map((coupon) => serializeCoupon(coupon));

    return res.json({ success: true, total: items.length, coupons: items });
  } catch (_error) {
    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách coupon",
    });
  }
}

async function createCoupon(req, res) {
  try {
    const payload = await normalizeCouponPayload(req.body);
    const coupon = await Coupon.create({ ...payload, usageCount: 0 });
    await coupon.populate("applicablePlans", "code name isActive");
    return res.status(201).json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: errorMessage(error, "Không thể tạo coupon"),
    });
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
    await coupon.save();
    await coupon.populate("applicablePlans", "code name isActive");
    return res.json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: errorMessage(error, "Không thể cập nhật coupon"),
    });
  }
}

async function updateCouponStatus(req, res) {
  try {
    const payload = await normalizeCouponPayload(
      { status: req.body.status },
      { partial: true },
    );
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ success: false, message: "Không tìm thấy coupon" });
    }

    coupon.status = payload.status;
    await coupon.save();
    await coupon.populate("applicablePlans", "code name isActive");
    return res.json({ success: true, coupon: serializeCoupon(coupon) });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: errorMessage(error, "Không thể cập nhật trạng thái coupon"),
    });
  }
}

module.exports = {
  createCoupon,
  listCoupons,
  updateCoupon,
  updateCouponStatus,
};

