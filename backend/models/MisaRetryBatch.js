const mongoose = require("mongoose");
const { RETRY_STATUSES } = require("../constants/misaImportRepair");

const RETRY_CONFIRMATION_STATEMENT = "Toàn bộ chứng từ này chưa được MISA nhập";

const retryConfirmationSchema = new mongoose.Schema(
  {
    statement: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      validate: {
        validator: (value) => value === RETRY_CONFIRMATION_STATEMENT,
        message: `Xác nhận phải là "${RETRY_CONFIRMATION_STATEMENT}"`,
      },
    },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    confirmedAt: { type: Date, required: true, immutable: true },
  },
  { _id: false },
);

const misaRetryBatchSchema = new mongoose.Schema(
  {
    repairSession: { type: mongoose.Schema.Types.ObjectId, ref: "MisaImportRepairSession", required: true, index: true },
    ownerScope: { type: String, required: true, trim: true, immutable: true, index: true },
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: "AccountingWorkspace", default: null, index: true },
    exportBatchId: { type: String, required: true, trim: true, immutable: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true, immutable: true, unique: true },
    documentGroupIds: {
      type: [{ type: String, trim: true }],
      required: true,
      validate: {
        validator: (value) =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((documentGroupId) =>
            typeof documentGroupId === "string" && documentGroupId.length > 0,
          ) &&
          new Set(value).size === value.length,
        message: "Retry batch phải có document group không trống và không trùng lặp",
      },
    },
    confirmation: { type: retryConfirmationSchema, required: true, immutable: true },
    status: { type: String, enum: RETRY_STATUSES, default: "pending", required: true, index: true },
    outputArtifactKey: { type: String, trim: true, default: "" },
    outputSha256: { type: String, trim: true, lowercase: true, default: "" },
    readinessSummary: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    mutationId: { type: String, trim: true, default: "", index: true },
    recoveryState: {
      type: String,
      enum: ["none", "cleanup_required", "reconciled"],
      default: "none",
      required: true,
    },
    recoveryError: { type: String, trim: true, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

misaRetryBatchSchema.index({ ownerScope: 1, status: 1, updatedAt: -1 });
misaRetryBatchSchema.index({ workspace: 1, status: 1, updatedAt: -1 });
misaRetryBatchSchema.index({ repairSession: 1, status: 1, createdAt: -1 });
misaRetryBatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.MisaRetryBatch ||
  mongoose.model("MisaRetryBatch", misaRetryBatchSchema);
