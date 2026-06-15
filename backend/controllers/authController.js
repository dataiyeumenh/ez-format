const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const User = require("../models/User");
const { verifyGoogleCredential } = require("../services/googleAuth");
const { normalizeSubscriptionState } = require("../services/subscriptionService");
const { getDefaultFreePlan, serializePlan } = require("../services/planService");
const {
  generateResetToken,
  hashToken,
} = require("../services/passwordResetService");
const { sendPasswordResetEmail } = require("../services/emailService");

// Generate JWT
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE,
  });
};

const serializeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  plan: serializePlan(user.plan),
  planStartedAt: user.planStartedAt,
  planExpiresAt: user.planExpiresAt,
  fileCredits: user.fileCredits,
  dailyFileCredit: user.dailyFileCredit,
  avatar: user.avatar,
  authProvider: user.authProvider,
  hasPassword: Boolean(user.password),
});

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { name, email, password } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res
        .status(400)
        .json({ success: false, message: "Email đã được sử dụng" });
    }

    const freePlan = await getDefaultFreePlan();
    const user = await User.create({ name, email, password, plan: freePlan?._id });
    await user.populate("plan");
    const token = generateToken(user._id, user.role);

    res.status(201).json({
      success: true,
      message: "Đăng ký thành công",
      token,
      user: serializeUser(user),
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email }).select("+password").populate("plan");
    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Email hoặc mật khẩu không đúng" });
    }

    if (!user.password) {
      return res.status(401).json({
        success: false,
        message: "Tài khoản này đang dùng đăng nhập Google",
      });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Email hoặc mật khẩu không đúng" });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Tài khoản của bạn đã bị khoá. Vui lòng liên hệ quản trị viên.",
      });
    }

    normalizeSubscriptionState(user);
    if (!user.plan) user.plan = (await getDefaultFreePlan())._id;
    if (
      user.isModified("plan") ||
      user.isModified("fileCredits") ||
      user.isModified("dailyFileCredit") ||
      user.isModified("dailyFileCreditDate") ||
      user.isModified("planStartedAt") ||
      user.isModified("planExpiresAt")
    ) {
      await user.save();
      await user.populate("plan");
    }

    const token = generateToken(user._id, user.role);

    res.json({
      success: true,
      message: "Đăng nhập thành công",
      token,
      user: serializeUser(user),
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Login/register with Google Identity Services credential
// @route   POST /api/auth/google
// @access  Public
const googleLogin = async (req, res) => {
  try {
    const googleProfile = await verifyGoogleCredential(req.body?.credential);

    let user = await User.findOne({
      $or: [{ googleId: googleProfile.googleId }, { email: googleProfile.email }],
    }).select("+password");

    if (user) {
      if (!user.googleId) {
        user.googleId = googleProfile.googleId;
      }
      if (!user.avatar && googleProfile.avatar) {
        user.avatar = googleProfile.avatar;
      }
      if (user.authProvider !== "google") {
        user.authProvider = "google";
      }
      await user.save();
    } else {
      user = await User.create({
        name: googleProfile.name,
        email: googleProfile.email,
        googleId: googleProfile.googleId,
        authProvider: "google",
        avatar: googleProfile.avatar,
        plan: (await getDefaultFreePlan())?._id,
      });
    }
    await user.populate("plan");

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Tài khoản của bạn đã bị khoá. Vui lòng liên hệ quản trị viên.",
      });
    }

    normalizeSubscriptionState(user);
    if (!user.plan) user.plan = (await getDefaultFreePlan())._id;
    if (
      user.isModified("plan") ||
      user.isModified("fileCredits") ||
      user.isModified("dailyFileCredit") ||
      user.isModified("dailyFileCreditDate") ||
      user.isModified("planStartedAt") ||
      user.isModified("planExpiresAt")
    ) {
      await user.save();
      await user.populate("plan");
    }

    const token = generateToken(user._id, user.role);

    res.json({
      success: true,
      message: "Đăng nhập Google thành công",
      token,
      user: serializeUser(user),
    });
  } catch (error) {
    const statusCode = error.statusCode || 401;
    res.status(statusCode).json({
      success: false,
      message: error.message || "Đăng nhập Google thất bại",
    });
  }
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("+password").populate("plan");
    normalizeSubscriptionState(user);
    if (!user.plan) user.plan = (await getDefaultFreePlan())._id;
    if (
      user.isModified("plan") ||
      user.isModified("fileCredits") ||
      user.isModified("dailyFileCredit") ||
      user.isModified("dailyFileCreditDate") ||
      user.isModified("planStartedAt") ||
      user.isModified("planExpiresAt")
    ) {
      await user.save();
      await user.populate("plan");
    }
    res.json({
      success: true,
      user: {
        ...serializeUser(user),
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// Base URL của frontend để dựng link reset.
// Ưu tiên Origin của request (nếu nằm trong allowlist) -> cùng 1 .env chạy được cả
// local lẫn prod: gọi từ localhost -> link localhost, gọi từ prod -> link prod.
function resolveFrontendBase(req) {
  const allowed = [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_URL_WWW,
    "http://localhost:5173",
    "http://localhost:3000",
  ]
    .filter(Boolean)
    .map((u) => u.replace(/\/+$/, ""));

  const origin = String(req.headers.origin || "").replace(/\/+$/, "");
  if (origin && allowed.includes(origin)) return origin;

  return String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
}

// @desc    Gửi email đặt lại mật khẩu
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  // Phản hồi chung — không tiết lộ email có tồn tại hay không (chống dò tài khoản).
  const genericMessage =
    "Nếu email tồn tại trong hệ thống, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu.";

  try {
    const email = String(req.body.email || "").toLowerCase();
    const user = await User.findOne({ email }).select("+password");

    // Chỉ gửi cho tài khoản local có mật khẩu (tài khoản Google không áp dụng).
    if (user && user.password) {
      const { token, tokenHash, expiresAt } = generateResetToken();
      user.resetPasswordTokenHash = tokenHash;
      user.resetPasswordExpires = expiresAt;
      await user.save({ validateBeforeSave: false });

      const resetUrl = `${resolveFrontendBase(req)}/reset-password?token=${token}`;
      // Fire-and-forget: KHÔNG await để response không bị treo nếu SMTP chậm/lỗi.
      // Lỗi (nếu có) được log trong emailService để debug qua Render logs.
      sendPasswordResetEmail(user.email, resetUrl, user.name).catch((err) =>
        console.error("[forgotPassword] gửi email lỗi:", err.message),
      );
    }

    return res.json({ success: true, message: genericMessage });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Kiểm tra token đặt lại còn hợp lệ (cho trang reset hiển thị trạng thái)
// @route   GET /api/auth/reset-password/validate
// @access  Public
const validateResetToken = async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.json({ success: true, valid: false });
    const user = await User.findOne({
      resetPasswordTokenHash: hashToken(token),
      resetPasswordExpires: { $gt: new Date() },
    });
    return res.json({ success: true, valid: Boolean(user) });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Đặt lại mật khẩu bằng token
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { token, password } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: "Token không hợp lệ" });
    }

    const user = await User.findOne({
      resetPasswordTokenHash: hashToken(token),
      resetPasswordExpires: { $gt: new Date() },
    }).select("+password");

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Liên kết đặt lại không hợp lệ hoặc đã hết hạn.",
      });
    }

    user.password = password; // pre-save hook sẽ hash
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({
      success: true,
      message: "Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.",
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Đổi mật khẩu (user đã đăng nhập)
// @route   PUT /api/auth/change-password
// @access  Private
const changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select("+password");
    if (!user) {
      return res.status(404).json({ success: false, message: "Không tìm thấy người dùng" });
    }

    // Đã có mật khẩu (local, hoặc Google đã từng đặt) -> bắt buộc xác minh mật khẩu cũ.
    // Chưa có mật khẩu (Google lần đầu) -> cho phép đặt mới mà không cần mật khẩu cũ.
    if (user.password) {
      if (!currentPassword) {
        return res
          .status(400)
          .json({ success: false, message: "Vui lòng nhập mật khẩu hiện tại." });
      }
      const isMatch = await user.matchPassword(currentPassword);
      if (!isMatch) {
        return res
          .status(400)
          .json({ success: false, message: "Mật khẩu hiện tại không đúng." });
      }
    }

    user.password = newPassword; // pre-save hook sẽ hash
    await user.save();

    return res.json({ success: true, message: "Đổi mật khẩu thành công." });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

module.exports = {
  register,
  login,
  googleLogin,
  getMe,
  forgotPassword,
  validateResetToken,
  resetPassword,
  changePassword,
};
