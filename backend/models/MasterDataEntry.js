const mongoose = require("mongoose");
const { MASTER_DATA_TYPES } = require("./MasterDataSnapshot");

const masterDataEntrySchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      required: true,
      index: true,
    },
    snapshot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MasterDataSnapshot",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: MASTER_DATA_TYPES,
      required: true,
    },
    code: { type: String, trim: true, default: "" },
    normalizedCode: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    normalizedName: { type: String, trim: true, default: "" },
    taxCode: { type: String, trim: true, default: "" },
    normalizedTaxCode: { type: String, trim: true, default: "" },
    active: { type: Boolean, default: true },
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

masterDataEntrySchema.index({ snapshot: 1, type: 1, normalizedCode: 1 });
masterDataEntrySchema.index({ snapshot: 1, type: 1, normalizedTaxCode: 1 });
masterDataEntrySchema.index({ snapshot: 1, type: 1, normalizedName: 1 });

module.exports = mongoose.model("MasterDataEntry", masterDataEntrySchema);
