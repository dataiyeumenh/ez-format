const mongoose = require("mongoose");

const mappingProfileSchema = new mongoose.Schema(
  {
    ownerScope: {
      type: String,
      required: [true, "Mapping profile owner scope là bắt buộc"],
      trim: true,
      validate: {
        validator: (value) => Boolean(String(value || "").trim()),
        message: "Mapping profile owner scope là bắt buộc",
      },
      index: true,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      default: null,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    targetTemplateId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    sourceSignatureHash: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },
    sourceHeaders: {
      type: [String],
      default: [],
    },
    sheetName: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },
    headerRow: {
      type: Number,
      min: 1,
      default: 1,
    },
    mapping: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    defaults: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    formulas: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 1,
    },
    usageCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      trim: true,
      default: undefined,
    },
    quarantinedAt: {
      type: Date,
      default: undefined,
    },
    quarantineReason: {
      type: String,
      trim: true,
      default: undefined,
    },
    mappingProfileV2Migration: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
  },
  { timestamps: true, autoIndex: false },
);

mappingProfileSchema.index(
  { ownerScope: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
  { unique: true },
);

module.exports = mongoose.model("MappingProfile", mappingProfileSchema);
