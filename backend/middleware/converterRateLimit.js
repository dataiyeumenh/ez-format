const ConverterRateLimitBucket = require("../models/ConverterRateLimitBucket");

const DEFAULTS = Object.freeze({
  analyze: { limit: 10, windowMs: 10 * 60 * 1000 },
  json: { limit: 120, windowMs: 60 * 1000 },
  export: { limit: 10, windowMs: 10 * 60 * 1000 },
});

function positiveEnvInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rateLimitConfig(operation) {
  const normalized = String(operation || "json").trim().toLowerCase();
  if (normalized === "analyze") {
    return {
      limit: positiveEnvInt(
        "CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES",
        DEFAULTS.analyze.limit,
      ),
      windowMs: DEFAULTS.analyze.windowMs,
    };
  }
  if (normalized === "export") {
    return {
      limit: positiveEnvInt(
        "CONVERTER_EXPORT_LIMIT_PER_10_MINUTES",
        DEFAULTS.export.limit,
      ),
      windowMs: DEFAULTS.export.windowMs,
    };
  }
  return {
    limit: positiveEnvInt(
      "CONVERTER_OPERATION_LIMIT_PER_MINUTE",
      DEFAULTS.json.limit,
    ),
    windowMs: DEFAULTS.json.windowMs,
  };
}

function bucketStartFor(nowMs, windowMs) {
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

async function consumeConverterRateLimit({
  userId,
  operation,
  limit,
  windowMs,
  now = Date.now(),
}) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) throw new Error("Rate limit thiếu user");
  const normalizedOperation = String(operation || "json").trim() || "json";
  const effectiveLimit = Math.max(1, Number(limit) || 1);
  const effectiveWindowMs = Math.max(1000, Number(windowMs) || 60000);
  const bucketStart = bucketStartFor(now, effectiveWindowMs);
  const expiresAt = new Date(bucketStart.getTime() + effectiveWindowMs);
  const filter = {
    userId: normalizedUserId,
    operation: normalizedOperation,
    bucketStart,
  };

  let bucket;
  try {
    bucket = await ConverterRateLimitBucket.findOneAndUpdate(
      filter,
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    bucket = await ConverterRateLimitBucket.findOneAndUpdate(
      filter,
      { $inc: { count: 1 } },
      { new: true },
    );
  }

  const count = Number(bucket?.count);
  if (!bucket || !Number.isFinite(count) || count < 1) {
    throw new Error("Rate limit bucket update failed");
  }
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((expiresAt.getTime() - now) / 1000),
  );
  return {
    allowed: count <= effectiveLimit,
    count,
    limit: effectiveLimit,
    bucketStart,
    retryAfterSeconds,
  };
}

function converterRateLimit(operation, overrides = {}) {
  return async function converterRateLimitMiddleware(req, res, next) {
    try {
      const config = { ...rateLimitConfig(operation), ...overrides };
      const result = await consumeConverterRateLimit({
        userId: req.user?._id,
        operation,
        limit: config.limit,
        windowMs: config.windowMs,
      });
      if (result.allowed) return next();
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: "Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
        retryAfter: result.retryAfterSeconds,
      });
    } catch (_error) {
      return res.status(503).json({
        success: false,
        message: "Không thể xác minh giới hạn yêu cầu. Vui lòng thử lại sau.",
        requestId: req.requestId || "",
      });
    }
  };
}

module.exports = {
  DEFAULTS,
  bucketStartFor,
  consumeConverterRateLimit,
  converterRateLimit,
  rateLimitConfig,
};
