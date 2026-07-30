const mongoose = require("mongoose");
const {
  MATCH_STATUSES,
  RESOLUTION_SCOPES,
  RESOLUTION_STATUSES,
} = require("../constants/misaImportRepair");

const normalizedLocatorSchema = new mongoose.Schema(
  {
    sourceRowNumber: { type: Number, min: 1, default: null },
    documentNumber: { type: String, trim: true, default: "" },
    invoiceNumber: { type: String, trim: true, default: "" },
    invoiceSymbol: { type: String, trim: true, default: "" },
    documentDate: { type: String, trim: true, default: "" },
    partnerCode: { type: String, trim: true, default: "" },
    itemCode: { type: String, trim: true, default: "" },
    amount: { type: String, trim: true, default: "" },
    lineFingerprint: { type: String, trim: true, lowercase: true, default: null, immutable: true },
  },
  { _id: false },
);

const issueCandidateSchema = new mongoose.Schema(
  {
    documentGroupId: { type: String, trim: true, required: true },
    method: { type: String, trim: true, default: "" },
    evidence: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const issueResolutionSchema = new mongoose.Schema(
  {
    status: { type: String, enum: RESOLUTION_STATUSES, default: "unresolved", required: true },
    scope: { type: String, enum: RESOLUTION_SCOPES, default: "once", required: true },
    patch: { type: mongoose.Schema.Types.Mixed, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
  },
  { _id: false },
);

const misaImportIssueSchema = new mongoose.Schema(
  {
    repairSession: { type: mongoose.Schema.Types.ObjectId, ref: "MisaImportRepairSession", required: true, index: true },
    ownerScope: { type: String, required: true, trim: true, immutable: true, index: true },
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: "AccountingWorkspace", default: null, index: true },
    issueKey: { type: String, required: true, trim: true, immutable: true },
    artifactRowNumber: { type: Number, min: 1, default: null },
    technicalMessage: { type: String, required: true, trim: true },
    normalizedLocator: { type: normalizedLocatorSchema, default: () => ({}) },
    category: { type: String, trim: true, default: "" },
    severity: { type: String, trim: true, default: "" },
    candidates: { type: [issueCandidateSchema], default: [] },
    matchStatus: { type: String, enum: MATCH_STATUSES, default: "unmatched", required: true, index: true },
    confirmedDocumentGroupId: { type: String, trim: true, default: "" },
    userConfirmedMatch: { type: Boolean, default: false, required: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },
    schemaGenerationId: { type: String, trim: true, default: null, immutable: true },
    mutationId: { type: String, trim: true, default: null },
    mutationPreviousMatchStatus: { type: String, enum: MATCH_STATUSES, default: null },
    mutationPreviousResolution: { type: mongoose.Schema.Types.Mixed, default: null },
    resolution: { type: issueResolutionSchema, default: () => ({}) },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

misaImportIssueSchema.pre("validate", function validateConfirmedMatch(next) {
  if (this.matchStatus === "confirmed" && !this.confirmedDocumentGroupId) {
    this.invalidate("confirmedDocumentGroupId", "Match đã xác nhận phải có document group");
  }
  next();
});

misaImportIssueSchema.index({ repairSession: 1, issueKey: 1 }, { unique: true });
misaImportIssueSchema.index({ ownerScope: 1, matchStatus: 1, updatedAt: -1 });
misaImportIssueSchema.index({ workspace: 1, matchStatus: 1, updatedAt: -1 });
misaImportIssueSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.MisaImportIssue ||
  mongoose.model("MisaImportIssue", misaImportIssueSchema);
