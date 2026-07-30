const mongoose = require("mongoose");

const studentQuestionEventSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StudentFileSession",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountingWorkspace",
      default: null,
      index: true,
    },
    ownerScope: { type: String, required: true, trim: true, index: true },
    questionHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    questionLength: { type: Number, required: true, min: 1, max: 2000 },
    category: {
      type: String,
      required: true,
      enum: [
        "file_summary",
        "locate_column",
        "locate_rows",
        "explain_mapping",
        "explain_issue",
        "aggregate_amount",
        "count_documents",
        "find_duplicates",
        "find_vat_mismatches",
        "required_actions_before_export",
        "concept_explanation",
        "unsupported_legal_or_business_judgment",
      ],
    },
    operation: { type: String, required: true, enum: ["ask"] },
    answerType: {
      type: String,
      required: true,
      enum: ["deterministic_file_query", "deterministic_explanation", "unsupported"],
    },
    evidenceIds: {
      type: [String],
      default: [],
      validate: {
        validator: (values) => values.length <= 20,
        message: "Evidence identifiers vượt quá giới hạn",
      },
    },
    evidenceCount: { type: Number, required: true, min: 0 },
    outcome: {
      type: String,
      required: true,
      enum: ["supported", "unsupported", "ai_unavailable"],
    },
    retentionExpiresAt: {
      type: Date,
      required: true,
      immutable: true,
      expires: 0,
    },
  },
  { timestamps: true },
);

studentQuestionEventSchema.index({ sessionId: 1, createdAt: -1 });

module.exports = mongoose.model("StudentQuestionEvent", studentQuestionEventSchema);
