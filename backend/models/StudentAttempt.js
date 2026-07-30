const mongoose = require("mongoose");

const studentAttemptSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StudentFileSession",
      required: true,
      index: true,
      immutable: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      default: null,
      index: true,
      immutable: true,
    },
    ownerScope: {
      type: String,
      required: true,
      trim: true,
      index: true,
      immutable: true,
    },
    revision: { type: Number, required: true, min: 1, immutable: true },
    idempotencyKeyHash: {
      type: String,
      required: true,
      trim: true,
      minlength: 64,
      maxlength: 64,
      immutable: true,
    },
    requestFingerprint: {
      type: String,
      required: true,
      trim: true,
      minlength: 64,
      maxlength: 64,
      immutable: true,
    },
    kind: {
      type: String,
      required: true,
      enum: [
        "mapping_attempt",
        "data_cleanup_attempt",
        "document_classification_attempt",
        "voucher_review_attempt",
        "reconciliation_attempt",
      ],
      immutable: true,
    },
    submittedStateHash: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
      immutable: true,
    },
    sessionStateHash: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
      immutable: true,
    },
    rubricVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      immutable: true,
    },
    score: { type: Number, required: true, min: 0, max: 100, immutable: true },
    summary: { type: mongoose.Schema.Types.Mixed, default: {}, immutable: true },
    hintLevelUsed: { type: Number, default: 0, min: 0, max: 4 },
    retentionExpiresAt: {
      type: Date,
      required: true,
      expires: 0,
      immutable: true,
    },
  },
  { timestamps: true },
);

studentAttemptSchema.index({ sessionId: 1, revision: 1 }, { unique: true });
studentAttemptSchema.index({ sessionId: 1, idempotencyKeyHash: 1 }, { unique: true });
studentAttemptSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("StudentAttempt", studentAttemptSchema);
