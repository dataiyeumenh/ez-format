const mongoose = require("mongoose");

const reconstructionProfileSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    sourceSignatureHash: { type: String, required: true, trim: true, maxlength: 128 },
    compatibleHeaderFingerprint: { type: String, trim: true, default: "", maxlength: 128 },
    directionScope: {
      type: String,
      enum: ["auto", "purchase", "sales"],
      default: "auto",
    },
    status: {
      type: String,
      enum: ["draft", "approved", "active", "deprecated"],
      default: "draft",
      index: true,
    },
    version: { type: Number, min: 1, required: true },
    groupingKeys: { type: [String], default: [] },
    fillDownFields: { type: [String], default: [] },
    fieldRoles: { type: mongoose.Schema.Types.Mixed, default: {} },
    mapping: { type: mongoose.Schema.Types.Mixed, default: {} },
    defaults: { type: mongoose.Schema.Types.Mixed, default: {} },
    formulas: { type: mongoose.Schema.Types.Mixed, default: {} },
    classificationRules: { type: mongoose.Schema.Types.Mixed, default: {} },
    templateRouting: { type: mongoose.Schema.Types.Mixed, default: {} },
    usageCount: { type: Number, min: 0, default: 0 },
    successCount: { type: Number, min: 0, default: 0 },
    reviewCount: { type: Number, min: 0, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reconstructionProfileSchema.index(
  { workspace: 1, sourceSignatureHash: 1, version: 1 },
  { unique: true },
);
reconstructionProfileSchema.index(
  { workspace: 1, sourceSignatureHash: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "uniq_active_reconstruction_profile",
  },
);

module.exports = mongoose.model("ReconstructionProfile", reconstructionProfileSchema);
