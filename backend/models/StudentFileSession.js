const mongoose = require("mongoose");
const {
  sanitizeStudentFileMetadata,
} = require("../services/studentSessionService");

const fileMetadataSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      required: [true, "Tên file là bắt buộc"],
      trim: true,
      maxlength: 255,
    },
    sizeBytes: {
      type: Number,
      required: [true, "Kích thước file là bắt buộc"],
      min: [0, "Kích thước file không được âm"],
    },
    extension: { type: String, trim: true, lowercase: true, maxlength: 16 },
    contentHash: { type: String, trim: true, maxlength: 256, default: "" },
    rawRetained: { type: Boolean, default: false },
  },
  { _id: false },
);

fileMetadataSchema.pre("validate", function sanitizeRawFilename() {
  const safeFile = sanitizeStudentFileMetadata(this);
  this.originalName = safeFile.originalName;
  this.extension = safeFile.extension;
});

const studentFileSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      default: null,
      index: true,
    },
    ownerScope: { type: String, required: true, trim: true, index: true },
    mode: {
      type: String,
      enum: ["student_assistant"],
      default: "student_assistant",
    },
    status: {
      type: String,
      enum: [
        "created",
        "analyzed",
        "in_review",
        "exported",
        "deleting",
        "delete_failed",
        "expired",
        "deleted",
      ],
      default: "created",
      index: true,
    },
    file: { type: fileMetadataSchema, required: true },
    converterUploadId: { type: String, trim: true, maxlength: 128, default: "" },
    targetTemplateId: { type: String, trim: true, maxlength: 128, default: "" },
    sourceSignatureHash: { type: String, trim: true, maxlength: 256, default: "" },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    childWriteEpoch: { type: Number, default: 0, min: 0 },
    deleteFailureCode: { type: String, trim: true, maxlength: 80, default: "" },
    deleteStartedAt: { type: Date, default: null, index: true },
    deleteFailedAt: { type: Date, default: null },
    retentionExpiresAt: { type: Date, required: true },
    purgedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
  },
  { timestamps: true },
);

studentFileSessionSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });
studentFileSessionSchema.index(
  { purgeAt: 1 },
  {
    name: "student_deleted_tombstone_ttl",
    expireAfterSeconds: 0,
    partialFilterExpression: { status: "deleted" },
  },
);

module.exports = mongoose.model("StudentFileSession", studentFileSessionSchema);
