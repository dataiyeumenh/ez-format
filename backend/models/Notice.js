const mongoose = require("mongoose");

const noticeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Tiêu đề thông báo là bắt buộc"],
      trim: true,
      maxlength: [120, "Tiêu đề không được quá 120 ký tự"],
    },
    description: {
      type: String,
      required: [true, "Nội dung thông báo là bắt buộc"],
      trim: true,
      maxlength: [1000, "Nội dung không được quá 1000 ký tự"],
    },
  },
  { timestamps: true },
);

noticeSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Notice", noticeSchema);
