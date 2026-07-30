const mongoose = require("mongoose");

const studentActivitySchema = new mongoose.Schema(
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
    ownerScope: { type: String, required: true, trim: true, index: true, immutable: true },
    eventType: {
      type: String,
      required: true,
      enum: [
        "accounting_map_reviewed",
        "reconciliation_completed",
        "anonymized_export_created",
      ],
      immutable: true,
    },
    skill: { type: String, required: true, trim: true, maxlength: 64, immutable: true },
    summaryVi: { type: String, required: true, trim: true, maxlength: 240, immutable: true },
    evidenceCount: { type: Number, required: true, min: 0, default: 0, immutable: true },
    containsRawValues: { type: Boolean, default: false, enum: [false], immutable: true },
    retentionExpiresAt: {
      type: Date,
      required: true,
      immutable: true,
      expires: 0,
    },
  },
  { timestamps: true },
);

studentActivitySchema.index({ sessionId: 1, createdAt: -1 });
studentActivitySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("StudentActivity", studentActivitySchema);
