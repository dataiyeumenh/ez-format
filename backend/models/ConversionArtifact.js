const mongoose = require("mongoose");

const conversionArtifactSchema = new mongoose.Schema(
  {
    ownerScope: { type: String, required: true, trim: true, immutable: true, index: true },
    userId: { type: String, required: true, trim: true, immutable: true, index: true },
    workspaceId: { type: String, default: null, trim: true, immutable: true, index: true },
    runId: { type: String, required: true, trim: true, immutable: true, index: true },
    sessionId: { type: String, required: true, trim: true, immutable: true, index: true },
    uploadId: { type: String, required: true, trim: true, immutable: true, index: true },
    targetTemplateId: { type: String, required: true, trim: true, immutable: true, index: true },
    kind: {
      type: String,
      enum: ["analysis", "upload", "output", "state"],
      required: true,
      immutable: true,
    },
    storageKey: { type: String, required: true, trim: true, immutable: true, unique: true },
    sha256: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    sizeBytes: { type: Number, required: true, min: 0, immutable: true },
    contentType: { type: String, required: true, trim: true, immutable: true },
    revision: { type: Number, required: true, min: 1, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    status: {
      type: String,
      enum: [
        "available",
        "deletion_pending",
        "expired",
        "deleted",
        "missing",
        "corrupted",
      ],
      default: "available",
      required: true,
      index: true,
    },
    purgeAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversionArtifactSchema.index(
  { sessionId: 1, kind: 1, revision: 1 },
  { unique: true },
);
conversionArtifactSchema.index({ ownerScope: 1, sessionId: 1, kind: 1, revision: -1 });
conversionArtifactSchema.index({ status: 1, expiresAt: 1 });
conversionArtifactSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ConversionArtifact ||
  mongoose.model("ConversionArtifact", conversionArtifactSchema);
