const mongoose = require("mongoose");

const OWNER_SCOPE_PATTERN = /^(workspace|user):[a-f\d]{24}$/i;
const PROFILE_STATUSES = ["draft", "active", "suspended", "superseded", "quarantined"];

const mappingProfileV2Schema = new mongoose.Schema(
  {
    ownerScope: {
      type: String,
      required: [true, "Mapping profile V2 owner scope là bắt buộc"],
      immutable: true,
      index: true,
      validate: {
        validator: (value) => OWNER_SCOPE_PATTERN.test(String(value || "")),
        message: "Mapping profile V2 owner scope không hợp lệ",
      },
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      default: null,
      immutable: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    profileKey: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 64,
    },
    profileFamilyId: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 64,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },
    status: {
      type: String,
      enum: PROFILE_STATUSES,
      default: "draft",
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      immutable: true,
    },
    sourceFamily: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      immutable: true,
    },
    documentType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
    headerFingerprint: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
      immutable: true,
    },
    dataShapeFingerprint: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
      immutable: true,
    },
    targetTemplateId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
    targetTemplateVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
      immutable: true,
    },
    mapping: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      immutable: true,
    },
    defaults: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      immutable: true,
    },
    formulas: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      immutable: true,
    },
    riskFlags: {
      type: [String],
      default: [],
      immutable: true,
    },
    stateHash: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 64,
    },
    previousVersion: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MappingProfileV2",
      default: null,
      immutable: true,
    },
    confirmationCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    confirmedExportIds: {
      type: [String],
      default: [],
      select: false,
    },
    lastConfirmedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    quarantinedAt: {
      type: Date,
      default: null,
    },
    quarantineReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    legacyProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MappingProfile",
      default: null,
      immutable: true,
    },
    mappingProfileV2Migration: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
      immutable: true,
    },
  },
  { timestamps: true, autoIndex: false },
);

mappingProfileV2Schema.index(
  { ownerScope: 1, profileFamilyId: 1, version: 1 },
  { unique: true },
);
mappingProfileV2Schema.index(
  { ownerScope: 1, profileFamilyId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
  },
);
mappingProfileV2Schema.index(
  { legacyProfileId: 1 },
  {
    unique: true,
    partialFilterExpression: { legacyProfileId: { $type: "objectId" } },
  },
);
mappingProfileV2Schema.index({ ownerScope: 1, status: 1, updatedAt: -1 });
mappingProfileV2Schema.index({
  "mappingProfileV2Migration.migrationId": 1,
  "mappingProfileV2Migration.appliedRunId": 1,
});

module.exports = mongoose.model("MappingProfileV2", mappingProfileV2Schema);
module.exports.OWNER_SCOPE_PATTERN = OWNER_SCOPE_PATTERN;
module.exports.PROFILE_STATUSES = PROFILE_STATUSES;
