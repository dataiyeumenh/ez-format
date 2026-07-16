const mongoose = require("mongoose");
const { MASTER_DATA_TYPES } = require("./MasterDataSnapshot");

const masterDataAliasSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: MASTER_DATA_TYPES,
      required: true,
    },
    sourceSystem: {
      type: String,
      trim: true,
      default: "default",
      maxlength: 120,
    },
    rawValue: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedRawValue: {
      type: String,
      required: true,
      trim: true,
    },
    targetCode: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedTargetCode: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["confirmed", "deprecated"],
      default: "confirmed",
    },
    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
  },
  { timestamps: true },
);

masterDataAliasSchema.index(
  { workspace: 1, type: 1, sourceSystem: 1, normalizedRawValue: 1 },
  { unique: true },
);

module.exports = mongoose.model("MasterDataAlias", masterDataAliasSchema);
