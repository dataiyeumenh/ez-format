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
    question: { type: String, required: true, trim: true, maxlength: 2000 },
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
  },
  { timestamps: true },
);

studentQuestionEventSchema.index({ sessionId: 1, createdAt: -1 });

module.exports = mongoose.model("StudentQuestionEvent", studentQuestionEventSchema);
