const mongoose = require("mongoose");
const { HUMAN_CONFIRMATION_ACTIONS } = require("../constants/misaImportRepair");

const misaImportRepairConfirmationSchema = new mongoose.Schema(
  {
    repairSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MisaImportRepairSession",
      required: true,
      immutable: true,
      index: true,
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: "AccountingWorkspace", default: null, immutable: true, index: true },
    ownerScope: { type: String, required: true, trim: true, immutable: true, index: true },
    action: { type: String, enum: HUMAN_CONFIRMATION_ACTIONS, required: true, immutable: true },
    payloadHash: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    sessionVersion: { type: Number, required: true, immutable: true, min: 0 },
    tokenHash: { type: String, required: true, trim: true, lowercase: true, immutable: true, unique: true },
    issuedAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

misaImportRepairConfirmationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
misaImportRepairConfirmationSchema.index({ repairSession: 1, user: 1, action: 1, consumedAt: 1 });

module.exports = mongoose.models.MisaImportRepairConfirmation ||
  mongoose.model("MisaImportRepairConfirmation", misaImportRepairConfirmationSchema);
