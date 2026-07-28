const mongoose = require("mongoose");

const converterRateLimitBucketSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, trim: true },
    operation: { type: String, required: true, trim: true },
    bucketStart: { type: Date, required: true },
    count: { type: Number, required: true, min: 0, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

converterRateLimitBucketSchema.index(
  { userId: 1, operation: 1, bucketStart: 1 },
  { unique: true },
);
converterRateLimitBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
  "ConverterRateLimitBucket",
  converterRateLimitBucketSchema,
);
