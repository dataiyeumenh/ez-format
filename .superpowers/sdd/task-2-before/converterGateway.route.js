const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const { converterRateLimit } = require("../middleware/converterRateLimit");
const {
  analyzeUpload,
  confirmMapping,
  exportConversion,
  getCapabilities,
  getSession,
  getTemplates,
  mutateSession,
  previewMapping,
  readinessMapping,
} = require("../controllers/converterGatewayController");

function isConverterGatewayUsageReady(env = process.env) {
  return (
    String(env.CONVERTER_PUBLIC_PROXY_ENABLED || "false").toLowerCase() ===
      "true" &&
    String(env.CONVERTER_GATEWAY_USAGE_READY || "false").toLowerCase() === "true"
  );
}

function getConverterMaxFileBytes() {
  const configured = Number(process.env.CONVERTER_MAX_FILE_BYTES || 20971520);
  return Number.isFinite(configured) && configured > 0 ? configured : 20971520;
}

function createUploadParser() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: getConverterMaxFileBytes(), files: 1 },
    fileFilter(_req, file, callback) {
      if ([".xls", ".xlsx"].includes(path.extname(file.originalname).toLowerCase())) {
        return callback(null, true);
      }
      const error = new Error("Chỉ hỗ trợ file .xls hoặc .xlsx");
      error.statusCode = 400;
      return callback(error);
    },
  });
}

function boundedExcelUpload(req, res, next) {
  createUploadParser().single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: `File vượt quá giới hạn ${getConverterMaxFileBytes()} bytes`,
      });
    }
    return res.status(Number(error.statusCode) || 400).json({
      success: false,
      message: error.message || "File upload không hợp lệ",
    });
  });
}

function asyncRoute(handler) {
  return function converterGatewayAsyncRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const router = express.Router();
router.get(
  "/capabilities",
  requireDb,
  protect,
  converterRateLimit("json"),
  asyncRoute(getCapabilities),
);
router.get(
  "/templates",
  requireDb,
  protect,
  converterRateLimit("json"),
  asyncRoute(getTemplates),
);
router.post(
  "/uploads/analyze",
  requireDb,
  protect,
  converterRateLimit("analyze"),
  boundedExcelUpload,
  asyncRoute(analyzeUpload),
);
router.post(
  "/mappings/preview",
  requireDb,
  protect,
  converterRateLimit("json"),
  asyncRoute(previewMapping),
);
router.post(
  "/mappings/readiness",
  requireDb,
  protect,
  converterRateLimit("json"),
  asyncRoute(readinessMapping),
);
router.post(
  "/mappings/confirm",
  requireDb,
  protect,
  converterRateLimit("json"),
  asyncRoute(confirmMapping),
);
router.post(
  "/conversions/export",
  requireDb,
  protect,
  converterRateLimit("export"),
  asyncRoute(exportConversion),
);
router.post(
  "/sessions",
  requireDb,
  protect,
  converterRateLimit("json"),
  asyncRoute(mutateSession),
);
router.get(
  "/sessions/:id",
  requireDb,
  protect,
  converterRateLimit("json"),
  asyncRoute(getSession),
);

module.exports = {
  boundedExcelUpload,
  getConverterMaxFileBytes,
  isConverterGatewayUsageReady,
  router,
};
