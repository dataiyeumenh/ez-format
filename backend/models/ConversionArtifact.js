const mongoose = require("mongoose");

const requiredWhenPublished = function requiredWhenPublished() {
  return !this.tombstoneOnly;
};

const requiredAfterWriteIntent = function requiredAfterWriteIntent() {
  return this.status !== "write_intent";
};

const conversionArtifactSchema = new mongoose.Schema(
  {
    tombstoneOnly: { type: Boolean, default: false, immutable: true, index: true },
    gridFsObjectId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true, index: true },
    ownerScope: { type: String, required: requiredWhenPublished, trim: true, immutable: true, index: true },
    userId: { type: String, required: requiredWhenPublished, trim: true, immutable: true, index: true },
    workspaceId: { type: String, default: null, trim: true, immutable: true },
    runId: { type: String, required: requiredWhenPublished, trim: true, immutable: true, index: true },
    sessionId: { type: String, required: requiredWhenPublished, trim: true, immutable: true, index: true },
    uploadId: { type: String, required: requiredWhenPublished, trim: true, immutable: true },
    targetTemplateId: { type: String, required: requiredWhenPublished, trim: true, immutable: true },
    kind: {
      type: String,
      enum: ["analysis", "upload", "output", "state", "manifest", "import_result", "repair_state", "retry_output"],
      required: requiredWhenPublished,
      trim: true,
      immutable: true,
    },
    revision: { type: Number, required: requiredWhenPublished, min: 1, immutable: true },
    sha256: { type: String, required: requiredAfterWriteIntent, default: "", trim: true, lowercase: true },
    sizeBytes: { type: Number, required: requiredAfterWriteIntent, default: 0, min: 0 },
    mime: { type: String, required: true, trim: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    status: {
      type: String,
      enum: ["write_intent", "available", "deletion_pending", "expired", "deleted", "missing", "corrupted"],
      default: "available",
      required: true,
      index: true,
    },
    purgeAt: { type: Date, default: null },
    writeIntentExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversionArtifactSchema.index(
  { sessionId: 1, kind: 1, revision: 1 },
  { unique: true, partialFilterExpression: { tombstoneOnly: false } },
);
conversionArtifactSchema.index({ ownerScope: 1, sessionId: 1, kind: 1, revision: -1 });
conversionArtifactSchema.index({ status: 1, expiresAt: 1 });
conversionArtifactSchema.index(
  { purgeAt: 1 },
  {
    name: "conversion_artifact_terminal_purge_ttl",
    expireAfterSeconds: 0,
    partialFilterExpression: { status: { $in: ["expired", "deleted", "missing", "corrupted"] } },
  },
);

module.exports = mongoose.models.ConversionArtifact ||
  mongoose.model("ConversionArtifact", conversionArtifactSchema);
