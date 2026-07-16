const mongoose = require("mongoose");

const voucherReconstructionRunSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      default: null,
      index: true,
    },
    conversionRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ConversionRun",
      required: true,
      unique: true,
    },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    fileSizeBytes: { type: Number, required: true, min: 0 },
    sourceFileHash: { type: String, trim: true, default: "", maxlength: 128 },
    sourceSignatureHash: {
      type: String,
      trim: true,
      default: "",
      maxlength: 128,
      index: true,
    },
    mode: {
      type: String,
      enum: ["auto", "purchase", "sales"],
      default: "auto",
    },
    targetTemplateId: { type: String, trim: true, default: "", maxlength: 120 },
    status: {
      type: String,
      enum: [
        "created",
        "analyzing",
        "review_required",
        "approved",
        "exported",
        "failed",
        "expired",
      ],
      default: "created",
      index: true,
    },
    engineVersion: { type: String, trim: true, default: "phase3-v1" },
    shadowMode: { type: Boolean, default: false },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    profile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReconstructionProfile",
      default: null,
    },
    profileVersion: { type: Number, min: 0, default: 0 },
    workspaceRevision: { type: Number, min: 0, default: 0 },
    snapshotSetHash: { type: String, trim: true, default: "", maxlength: 128 },
    inputSheetCount: { type: Number, min: 0, default: 0 },
    inputRowCount: { type: Number, min: 0, default: 0 },
    draftCount: { type: Number, min: 0, default: 0 },
    readyCount: { type: Number, min: 0, default: 0 },
    reviewCount: { type: Number, min: 0, default: 0 },
    blockedCount: { type: Number, min: 0, default: 0 },
    classificationSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
    reconciliationSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
    latestDraftRevision: { type: Number, min: 0, default: 0 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    exportedAt: { type: Date, default: null },
    exportIdempotencyKey: { type: String, trim: true, default: "", maxlength: 160 },
    creditChargedAt: { type: Date, default: null },
    errorCode: { type: String, trim: true, default: "", maxlength: 120 },
    errorMessage: { type: String, trim: true, default: "", maxlength: 1000 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

voucherReconstructionRunSchema.index({ workspace: 1, createdAt: -1 });
voucherReconstructionRunSchema.index({ user: 1, createdAt: -1 });
voucherReconstructionRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
  "VoucherReconstructionRun",
  voucherReconstructionRunSchema,
);
