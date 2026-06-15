const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { normalizeSubscriptionState } = require("../services/subscriptionService");
const { getDefaultFreePlan } = require("../services/planService");

const protect = async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "Không có quyền truy cập" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).populate("plan");
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Token không hợp lệ" });
    }
    if (!req.user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Tài khoản của bạn đã bị khoá. Vui lòng liên hệ quản trị viên.",
      });
    }
    normalizeSubscriptionState(req.user);
    if (!req.user.plan) req.user.plan = (await getDefaultFreePlan())._id;
    if (
      req.user.isModified("plan") ||
      req.user.isModified("fileCredits") ||
      req.user.isModified("dailyFileCredit") ||
      req.user.isModified("dailyFileCreditDate") ||
      req.user.isModified("planStartedAt") ||
      req.user.isModified("planExpiresAt")
    ) {
      await req.user.save();
    }
    next();
  } catch (error) {
    return res
      .status(401)
      .json({ success: false, message: "Token không hợp lệ" });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res
      .status(403)
      .json({ success: false, message: "Chỉ admin mới có quyền truy cập" });
  }
};

module.exports = { protect, adminOnly };
