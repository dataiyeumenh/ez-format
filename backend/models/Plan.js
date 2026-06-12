const mongoose = require("mongoose");

const CODE_NAME_KEYWORDS = Object.freeze({
  free: ["miễn phí", "free"],
  monthly: ["tháng", "monthly"],
  yearly: ["năm", "yearly"],
  perfile: ["lượt", "file", "perfile"],
});

const planSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Mã gói là bắt buộc"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, "Mã gói chỉ gồm chữ thường, số và dấu gạch ngang"],
      immutable: true,
    },
    name: {
      type: String,
      required: [true, "Tên gói là bắt buộc"],
      trim: true,
      maxlength: [80, "Tên gói không được quá 80 ký tự"],
    },
    price: {
      type: Number,
      required: true,
      min: [0, "Giá gói không được âm"],
    },
    displayPrice: {
      type: String,
      required: true,
      trim: true,
    },
    periodLabel: {
      type: String,
      default: "",
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [300, "Mô tả không được quá 300 ký tự"],
    },
    features: {
      type: [String],
      default: [],
    },
    durationDays: {
      type: Number,
      default: 0,
      min: [0, "Số ngày không được âm"],
    },
    fileCredits: {
      type: Number,
      default: 0,
      min: [0, "Số lượt không được âm"],
    },
    isPopular: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

planSchema.path("name").validate(function validateNameMatchesCode(name) {
  const keywords = CODE_NAME_KEYWORDS[this.code];
  if (!keywords) return true;
  const normalizedName = String(name || "").toLowerCase();
  return keywords.some((keyword) => normalizedName.includes(keyword));
}, "Tên gói không khớp với mã gói");

module.exports = mongoose.model("Plan", planSchema);
