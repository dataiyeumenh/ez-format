const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const {
  register,
  login,
  googleLogin,
  getMe,
  forgotPassword,
  validateResetToken,
  resetPassword,
  changePassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");

router.use(requireDb);

// @route POST /api/auth/register
router.post(
  "/register",
  [
    body("name").notEmpty().withMessage("Tên không được để trống"),
    body("email").isEmail().withMessage("Email không hợp lệ"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Mật khẩu tối thiểu 6 ký tự"),
  ],
  register,
);

// @route POST /api/auth/login
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Email không hợp lệ"),
    body("password").notEmpty().withMessage("Mật khẩu không được để trống"),
  ],
  login,
);

// @route POST /api/auth/google
router.post("/google", googleLogin);

// @route POST /api/auth/forgot-password
router.post(
  "/forgot-password",
  [body("email").isEmail().withMessage("Email không hợp lệ")],
  forgotPassword,
);

// @route GET /api/auth/reset-password/validate
router.get("/reset-password/validate", validateResetToken);

// @route POST /api/auth/reset-password
router.post(
  "/reset-password",
  [
    body("token").notEmpty().withMessage("Token không hợp lệ"),
    body("password").isLength({ min: 6 }).withMessage("Mật khẩu tối thiểu 6 ký tự"),
  ],
  resetPassword,
);

// @route PUT /api/auth/change-password
router.put(
  "/change-password",
  protect,
  [
    body("currentPassword").optional({ checkFalsy: true }),
    body("newPassword").isLength({ min: 6 }).withMessage("Mật khẩu mới tối thiểu 6 ký tự"),
  ],
  changePassword,
);

// @route GET /api/auth/me
router.get("/me", protect, getMe);

module.exports = router;
