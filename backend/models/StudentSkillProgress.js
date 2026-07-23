const mongoose = require("mongoose");

const skillEvidenceSchema = new mongoose.Schema(
  {
    score: { type: Number, required: true, min: 0, max: 100 },
    evidenceCount: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const studentSkillProgressSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    skills: {
      type: Map,
      of: skillEvidenceSchema,
      default: {},
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("StudentSkillProgress", studentSkillProgressSchema);
