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
    conversionContextId: {
      type: String,
      index: true,
      default: "",
    },
    operationSessionId: {
      type: String,
      index: true,
      default: "",
    },
    usageState: {
      type: String,
      enum: ["not_chargeable", "chargeable", "charged", "charge_failed"],
      default: "chargeable",
    },
    usageIdempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      maxlength: 256,
    },
    exportArtifactKey: {
      type: String,
      default: "",
    },
    analysisArtifactKey: {
      type: String,
      default: "",
    },
    inputSha256: {
      type: String,
      maxlength: 64,
      default: "",
    },
    analysisSha256: {
      type: String,
      maxlength: 64,
      default: "",
    },
    outputSha256: {
      type: String,
      maxlength: 64,
      default: "",
    },
    converterUploadId: {
      type: String,
      trim: true,
      default: "",
    },
    mode: {
      type: String,
      enum: ["mapping", "reconstruction"],
      default: "mapping",
    },
    reconstructionRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VoucherReconstructionRun",
      default: null,
    },
    documentCount: { type: Number, min: 0, default: 0 },
    reviewCount: { type: Number, min: 0, default: 0 },
    creditChargedAt: { type: Date, default: null },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      default: null,
      index: true,
    },
    workspaceNameSnapshot: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },
    snapshotSetHash: {
      type: String,
      trim: true,
      default: "",
      maxlength: 128,
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
