const mongoose = require("mongoose");

const websiteVisitSchema = new mongoose.Schema(
  {
    dateKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "Ngày truy cập không hợp lệ"],
    },
    count: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("WebsiteVisit", websiteVisitSchema);
