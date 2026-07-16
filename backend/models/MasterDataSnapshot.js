const mongoose = require("mongoose");

const MASTER_DATA_TYPES = [
  "account",
  "supplier",
  "customer",
  "item",
  "warehouse",
  "unit",
  "employee",
  "bank_account",
];

const masterDataSnapshotSchema = new mongoose.Schema(
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
    sourceFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    sourceFileHash: {
      type: String,
      required: true,
      trim: true,
    },
    rowCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      enum: ["processing", "ready", "active", "archived", "failed"],
      default: "processing",
    },
    schemaVersion: {
      type: Number,
      min: 1,
      default: 1,
    },
    warnings: {
      type: [String],
      default: [],
    },
    errorMessage: {
      type: String,
      default: "",
    },
    importedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

masterDataSnapshotSchema.index(
  { workspace: 1, type: 1, sourceFileHash: 1 },
  { unique: true },
);
masterDataSnapshotSchema.index({ workspace: 1, type: 1, status: 1 });
masterDataSnapshotSchema.index(
  { workspace: 1, status: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "uniq_active_snapshot_per_workspace_type",
  },
);

module.exports = mongoose.model("MasterDataSnapshot", masterDataSnapshotSchema);
module.exports.MASTER_DATA_TYPES = MASTER_DATA_TYPES;
