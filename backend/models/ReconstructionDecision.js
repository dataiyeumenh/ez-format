const mongoose = require("mongoose");

const reconstructionDecisionSchema = new mongoose.Schema(
  {
    run: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VoucherReconstructionRun",
      required: true,
      index: true,
    },
    draftStableId: { type: String, required: true, trim: true, maxlength: 128 },
    draftRevision: { type: Number, min: 1, required: true },
    operationType: {
      type: String,
      enum: [
        "set_field",
        "set_type",
        "split",
        "merge",
        "ignore_row",
        "approve",
        "acknowledge",
      ],
      required: true,
    },
    fieldPath: { type: String, trim: true, default: "", maxlength: 240 },
    beforeHash: { type: String, trim: true, default: "", maxlength: 128 },
    afterHash: { type: String, trim: true, default: "", maxlength: 128 },
    structuralRule: { type: mongoose.Schema.Types.Mixed, default: {} },
    sourceRows: { type: [Number], default: [] },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

reconstructionDecisionSchema.index({ run: 1, draftStableId: 1, draftRevision: 1 });

module.exports = mongoose.model("ReconstructionDecision", reconstructionDecisionSchema);
