const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Vui lòng nhập tên"],
      trim: true,
      maxlength: [50, "Tên không được quá 50 ký tự"],
    },
    email: {
      type: String,
      required: [true, "Vui lòng nhập email"],
      unique: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Email không hợp lệ"],
    },
    password: {
      type: String,
      required: function () {
        return !this.googleId;
      },
      minlength: [6, "Mật khẩu tối thiểu 6 ký tự"],
      select: false,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      default: null,
    },
    planStartedAt: {
      type: Date,
      default: null,
    },
    planExpiresAt: {
      type: Date,
      default: null,
    },
    fileCredits: {
      type: Number,
      default: 0,
      min: [0, "Số lượt file không được âm"],
    },
    dailyFileCredit: {
      type: Number,
      default: 1,
      min: [0, "Lượt miễn phí mỗi ngày không được âm"],
    },
    dailyFileCreditDate: {
      type: String,
      default: "",
    },
    avatar: {
      type: String,
      default: "",
    },
    resetPasswordTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
      select: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    loginCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

// Hash password before save
userSchema.pre("save", async function (next) {
  if (!this.password || !this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Match password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
