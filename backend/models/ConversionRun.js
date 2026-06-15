const mongoose = require("mongoose");

const conversionRunSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userNameSnapshot: {
      type: String,
      trim: true,
      default: "",
    },
    userEmailSnapshot: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    fileName: {
      type: String,
      required: [true, "Tên file là bắt buộc"],
      trim: true,
      maxlength: [255, "Tên file không được quá 255 ký tự"],
    },
    fileSizeBytes: {
      type: Number,
      required: [true, "Kích thước file là bắt buộc"],
      min: [0, "Kích thước file không được âm"],
    },
    outputFormat: {
      type: String,
      enum: ["MISA"],
      default: "MISA",
    },
    status: {
      type: String,
      enum: ["processing", "completed", "failed", "cancelled"],
      default: "processing",
      index: true,
    },
    targetTemplateId: {
      type: String,
      trim: true,
      default: "",
    },
    converterUploadId: {
      type: String,
      trim: true,
      default: "",
    },
    errorMessage: {
      type: String,
      trim: true,
      maxlength: [1000, "Thông báo lỗi không được quá 1000 ký tự"],
      default: "",
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

conversionRunSchema.index({ createdAt: -1 });
conversionRunSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("ConversionRun", conversionRunSchema);
