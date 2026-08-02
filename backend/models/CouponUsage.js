const mongoose = require("mongoose");

const couponUsageSchema = new mongoose.Schema(
  {
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    usedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

couponUsageSchema.index({ coupon: 1, user: 1 });
couponUsageSchema.index(
  { payment: 1 },
  {
    name: "couponusage_payment_unique",
    unique: true,
    partialFilterExpression: { payment: { $type: "objectId" } },
  },
);

module.exports = mongoose.model("CouponUsage", couponUsageSchema);
