const mongoose = require("mongoose");
const {
  ARTIFACT_TYPES,
  IMPORT_STATUSES,
  REPAIR_STATUSES,
} = require("../constants/misaImportRepair");

const repairSummarySchema = new mongoose.Schema(
  {
    totalIssues: { type: Number, min: 0, default: 0 },
    unmatchedIssues: { type: Number, min: 0, default: 0 },
    ambiguousIssues: { type: Number, min: 0, default: 0 },
    confirmedIssues: { type: Number, min: 0, default: 0 },
    unresolvedIssues: { type: Number, min: 0, default: 0 },
    unknownDocumentGroups: { type: Number, min: 0, default: 0 },
    failedDocumentGroups: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const documentGroupStatusSchema = new mongoose.Schema(
  {
    documentGroupId: { type: String, required: true, trim: true },
    status: { type: String, enum: IMPORT_STATUSES, default: "unknown", required: true },
    userConfirmed: { type: Boolean, default: false, required: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },
    evidence: {
      documentNumber: { type: String, trim: true, default: "", immutable: true },
      invoiceNumber: { type: String, trim: true, default: "", immutable: true },
      invoiceSymbol: { type: String, trim: true, default: "", immutable: true },
      documentDate: { type: String, trim: true, default: "", immutable: true },
      partnerCode: { type: String, trim: true, default: "", immutable: true },
      lineCount: { type: Number, min: 0, default: 0, immutable: true },
      outputRowNumbers: { type: [Number], default: [], immutable: true },
    },
  },
  { _id: false },
);

const misaImportRepairSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: "AccountingWorkspace", default: null, index: true },
    conversionRun: { type: mongoose.Schema.Types.ObjectId, ref: "ConversionRun", required: true, index: true },
    ownerScope: { type: String, required: true, trim: true, immutable: true, index: true },
    idempotencyKey: { type: String, trim: true, immutable: true },
    requestFingerprint: { type: String, trim: true, lowercase: true, default: "", immutable: true },
    uploadSha256: { type: String, trim: true, lowercase: true, default: "", immutable: true },
    operationSessionId: { type: String, required: true, trim: true, immutable: true, index: true },
    targetTemplateId: { type: String, required: true, trim: true, immutable: true, index: true },
    misaProduct: { type: String, enum: ["SME"], default: "SME", required: true, immutable: true },
    misaVersion: { type: String, trim: true, default: "" },
    templateHash: { type: String, trim: true, lowercase: true, default: "" },
    rawFileHash: { type: String, trim: true, lowercase: true, default: "" },
    manifestArtifactKey: { type: String, required: true, trim: true, immutable: true },
    manifestSha256: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    errorArtifactKey: { type: String, required: true, trim: true, immutable: true },
    errorSha256: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    artifactType: { type: String, enum: ARTIFACT_TYPES, default: "failed_rows", required: true },
    adapter: {
      id: { type: String, enum: ["manual_excel_v1"], default: "manual_excel_v1", required: true },
      version: { type: Number, enum: [1], default: 1, required: true },
      verified: {
        type: Boolean,
        default: false,
        required: true,
        immutable: true,
        validate: {
          validator: (value) => value === false,
          message: "Phase 1 adapter must remain unverified (false)",
        },
      },
    },
    status: { type: String, enum: REPAIR_STATUSES, default: "uploaded", required: true, index: true },
    version: { type: Number, min: 0, default: 0, required: true },
    summary: { type: repairSummarySchema, default: () => ({}) },
    documentGroupStatuses: { type: [documentGroupStatusSchema], default: [] },
    activeSchemaGenerationId: { type: String, trim: true, default: null },
    pendingMutationId: { type: String, trim: true, default: null },
    pendingMutationType: { type: String, enum: ["schema", "confirm"], default: null },
    pendingMutationStartedAt: { type: Date, default: null },
    pendingRecoveryId: { type: String, trim: true, default: null },
    expiresAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

misaImportRepairSessionSchema.pre("validate", function validateRetryReadiness(next) {
  if (this.status === "retry_ready") {
    const summary = this.summary || {};
    if (summary.unknownDocumentGroups > 0) {
      this.invalidate("status", "Không thể retry khi còn chứng từ chưa xác định trạng thái import");
    } else if (summary.ambiguousIssues > 0) {
      this.invalidate("status", "Không thể retry khi còn match mơ hồ");
    } else if (summary.unmatchedIssues > 0) {
      this.invalidate("status", "Không thể retry khi còn issue chưa match");
    } else if (summary.unresolvedIssues > 0) {
      this.invalidate("status", "Không thể retry khi còn issue chưa được xử lý");
    }
  }
  next();
});

misaImportRepairSessionSchema.index({ ownerScope: 1, status: 1, updatedAt: -1 });
misaImportRepairSessionSchema.index({ workspace: 1, status: 1, updatedAt: -1 });
misaImportRepairSessionSchema.index({ conversionRun: 1, operationSessionId: 1 }, { unique: true });
misaImportRepairSessionSchema.index(
  { user: 1, ownerScope: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  },
);
misaImportRepairSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.MisaImportRepairSession ||
  mongoose.model("MisaImportRepairSession", misaImportRepairSessionSchema);
