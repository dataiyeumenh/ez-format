const mongoose = require("mongoose");

const noticeReadStateSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    readThrough: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

noticeReadStateSchema.index({ user: 1 }, { unique: true });

module.exports = mongoose.model("NoticeReadState", noticeReadStateSchema);
