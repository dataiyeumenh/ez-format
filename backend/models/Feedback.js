const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userNameSnapshot: {
      type: String,
      trim: true,
      default: "",
    },
    userEmailSnapshot: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    category: {
      type: String,
      enum: ["bug", "feature", "ui", "other"],
      required: [true, "Loại góp ý là bắt buộc"],
    },
    message: {
      type: String,
      required: [true, "Nội dung góp ý là bắt buộc"],
      trim: true,
      maxlength: [2000, "Nội dung góp ý không được quá 2000 ký tự"],
    },
  },
  { timestamps: true },
);

feedbackSchema.index({ createdAt: -1 });
feedbackSchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.model("Feedback", feedbackSchema);
