const mongoose = require("mongoose");

const COUPON_STATUSES = Object.freeze([
  "active",
  "inactive",
  "expired",
  "exhausted",
]);

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Mã coupon là bắt buộc"],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [40, "Mã coupon không được quá 40 ký tự"],
      match: [
        /^[A-Z0-9_-]+$/,
        "Mã coupon chỉ gồm chữ in hoa, số, gạch ngang hoặc gạch dưới",
      ],
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Mô tả không được quá 500 ký tự"],
    },
    discountPercent: {
      type: Number,
      required: [true, "Phần trăm giảm giá là bắt buộc"],
      min: [1, "Phần trăm giảm tối thiểu là 1"],
      max: [100, "Phần trăm giảm tối đa là 100"],
    },
    maxDiscountAmount: {
      type: Number,
      default: null,
      min: [0, "Số tiền giảm tối đa không được âm"],
    },
    applicablePlans: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Plan",
      },
    ],
    usageLimit: {
      type: Number,
      required: [true, "Giới hạn lượt dùng là bắt buộc"],
      min: [1, "Giới hạn lượt dùng tối thiểu là 1"],
    },
    usageCount: {
      type: Number,
      default: 0,
      min: [0, "Số lượt đã dùng không được âm"],
    },
    limitPerUser: {
      type: Number,
      required: [true, "Giới hạn mỗi user là bắt buộc"],
      min: [1, "Mỗi user được dùng tối thiểu 1 lần"],
      default: 1,
    },
    startDate: {
      type: Date,
      required: [true, "Ngày bắt đầu là bắt buộc"],
    },
    endDate: {
      type: Date,
      required: [true, "Ngày kết thúc là bắt buộc"],
    },
    status: {
      type: String,
      enum: {
        values: ["active", "inactive"],
        message: "Trạng thái chỉ nhận active hoặc inactive",
      },
      default: "active",
    },
  },
  { timestamps: true },
);

couponSchema.index({ status: 1, endDate: 1 });

couponSchema.pre("validate", function validateDateRange(next) {
  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    this.invalidate("endDate", "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu");
  }
  if (
    this.maxDiscountAmount !== null &&
    this.maxDiscountAmount !== undefined &&
    Number(this.maxDiscountAmount) <= 0
  ) {
    this.invalidate(
      "maxDiscountAmount",
      "Số tiền giảm tối đa phải lớn hơn 0 khi được đặt",
    );
  }
  next();
});

module.exports = mongoose.model("Coupon", couponSchema);
module.exports.COUPON_STATUSES = COUPON_STATUSES;
