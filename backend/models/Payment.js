const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderCode: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    planType: {
      type: String,
      enum: ["monthly", "yearly", "perfile"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired", "failed"],
      default: "pending",
      index: true,
    },
    checkoutUrl: {
      type: String,
      default: "",
    },
    paymentLinkId: {
      type: String,
      default: "",
      index: true,
    },
    payosData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Payment", paymentSchema);
