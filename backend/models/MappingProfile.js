const mongoose = require("mongoose");

const mappingProfileSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      required: true,
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
  },
  { timestamps: true },
);

mappingProfileSchema.index(
  { workspace: 1, targetTemplateId: 1, sourceSignatureHash: 1 },
  { unique: true },
);

module.exports = mongoose.model("MappingProfile", mappingProfileSchema);
