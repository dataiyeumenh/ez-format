const mongoose = require("mongoose");

const conversionSessionStateSchema = new mongoose.Schema(
  {
    ownerScope: { type: String, required: true, trim: true, immutable: true, index: true },
    userId: { type: String, required: true, trim: true, immutable: true, index: true },
    workspaceId: { type: String, default: null, trim: true, immutable: true, index: true },
    runId: { type: String, required: true, trim: true, immutable: true, index: true },
    sessionId: { type: String, required: true, trim: true, immutable: true, index: true },
    targetTemplateId: { type: String, default: "", trim: true, index: true },
    uploadId: { type: String, default: "", trim: true, index: true },
    stateArtifactKey: { type: String, default: "", trim: true },
    stateSha256: { type: String, default: "", trim: true, lowercase: true },
    revision: { type: Number, required: true, min: 0, default: 0 },
    expiresAt: { type: Date, required: true },
    // Session expiry is handled by the sweeper; purgeAt only removes a tombstone
    // after the state object has been deleted successfully.
    purgeAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["allocated", "active", "deletion_pending", "expired", "deleted"],
      default: "allocated",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

conversionSessionStateSchema.index({ sessionId: 1, runId: 1 }, { unique: true });
conversionSessionStateSchema.index({ ownerScope: 1, status: 1, updatedAt: -1 });
conversionSessionStateSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ConversionSessionState ||
  mongoose.model("ConversionSessionState", conversionSessionStateSchema);
