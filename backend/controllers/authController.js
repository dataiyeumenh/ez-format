const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const User = require("../models/User");
const { verifyGoogleCredential } = require("../services/googleAuth");
const { normalizeSubscriptionState } = require("../services/subscriptionService");
const { getDefaultFreePlan, serializePlan } = require("../services/planService");

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
  avatar: user.avatar,
  authProvider: user.authProvider,
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
    });

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
    const user = await User.findById(req.user.id).populate("plan");
    normalizeSubscriptionState(user);
    if (!user.plan) user.plan = (await getDefaultFreePlan())._id;
    if (
      user.isModified("plan") ||
      user.isModified("fileCredits") ||
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

module.exports = { register, login, googleLogin, getMe };
