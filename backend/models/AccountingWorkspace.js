const mongoose = require("mongoose");

const workspaceMemberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: {
      type: String,
      enum: ["owner", "editor", "reviewer", "viewer"],
      default: "viewer",
    },
  },
  { _id: false },
);

const activeSnapshotSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
    },
    snapshot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MasterDataSnapshot",
      required: true,
    },
  },
  { _id: false },
);

const accountingWorkspaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Tên doanh nghiệp là bắt buộc"],
      trim: true,
      maxlength: 160,
    },
    taxCode: {
      type: String,
      trim: true,
      default: "",
      maxlength: 32,
    },
    misaProduct: {
      type: String,
      enum: ["AMIS", "SME"],
      default: "AMIS",
    },
    accountingRegime: {
      type: String,
      enum: ["AUTO", "TT99", "TT200", "TT133"],
      default: "AUTO",
    },
    fiscalYearStartMonth: {
      type: Number,
      min: 1,
      max: 12,
      default: 1,
    },
    lockedThroughDate: {
      type: Date,
      default: null,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    members: {
      type: [workspaceMemberSchema],
      default: [],
    },
    activeSnapshots: {
      type: [activeSnapshotSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    masterDataRevision: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true },
);

accountingWorkspaceSchema.index({ owner: 1, name: 1 });
accountingWorkspaceSchema.index({ "members.user": 1, isActive: 1 });

module.exports = mongoose.model(
  "AccountingWorkspace",
  accountingWorkspaceSchema,
);
