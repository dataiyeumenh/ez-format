const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const { forwardJson, forwardMultipart, forwardBinary } = require("../services/converterGatewayService");
const {
  applyMisaImportRepairBulk,
  confirmMisaImportRepairMatch,
  createMisaImportRetryBatch,
  createMisaImportRepair,
  downloadMisaImportRetryBatch,
  issueMisaImportRepairHumanConfirmation,
  readMisaImportRepair,
  resolveMisaImportRepairIssue,
  setMisaImportRepairImportStatus,
  simulateMisaImportRepairBulk,
  submitMisaImportRepairSchema,
} = require("../controllers/misaImportRepairController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.CONVERTER_MAX_FILE_BYTES || 20 * 1024 * 1024), files: 1 },
  fileFilter(_req, file, callback) {
    if ([".xls", ".xlsx"].includes(path.extname(file.originalname).toLowerCase())) return callback(null, true);
    const error = new Error("Only .xls and .xlsx files are supported");
    error.statusCode = 400;
    return callback(error);
  },
});

function getConverterMaxFileBytes() {
  const configured = Number(process.env.CONVERTER_MAX_FILE_BYTES || 20 * 1024 * 1024);
  return Number.isFinite(configured) && configured > 0 ? configured : 20 * 1024 * 1024;
}

function boundedExcelUpload(req, res, next) {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: getConverterMaxFileBytes(), files: 1 },
    fileFilter(_req, file, callback) {
      if ([".xls", ".xlsx"].includes(path.extname(file.originalname).toLowerCase())) return callback(null, true);
      const error = new Error("Only .xls and .xlsx files are supported");
      error.statusCode = 400;
      return callback(error);
    },
  }).single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ success: false, message: `File exceeds ${getConverterMaxFileBytes()} bytes` });
    }
    return res.status(Number(error.statusCode) || 400).json({ success: false, message: error.message });
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function gatewayContext(req) {
  return String(req.headers["x-conversion-context"] || "").trim();
}

function sendUpstream(response, res) {
  for (const [name, value] of Object.entries(response.headers || {})) res.setHeader(name, value);
  if (Buffer.isBuffer(response.data)) return res.status(response.status).send(response.data);
  return res.status(response.status).json(response.data == null ? {} : response.data);
}

function mergeGatewayCapabilities(payload = {}, env = process.env, operations = {}) {
  const backendStudentEnabled =
    String(env.STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() === "true";
  return {
    ...payload,
    capabilities: {
      ...(payload.capabilities || {}),
      ...operations,
      studentAssistant: Boolean(
        backendStudentEnabled && payload.capabilities?.studentAssistant,
      ),
    },
    gateway: true,
    artifactStorage: "mongodb-gridfs",
  };
}

router.get("/capabilities", requireDb, protect, asyncRoute(async (req, res) => {
  const [health, operations] = await Promise.all([
    forwardJson({ path: "/healthz", method: "GET", requestId: req.requestId, requireContext: false }),
    forwardJson({ path: "/api/v1/capabilities", method: "GET", requestId: req.requestId, requireContext: false }),
  ]);
  const status = health.status >= 400 ? health.status : operations.status;
  return res.status(status).json(
    mergeGatewayCapabilities(health.data, process.env, operations.data),
  );
}));
router.get("/templates", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/templates", method: "GET", contextToken: gatewayContext(req), requestId: req.requestId, requireContext: false }), res)));
router.post("/uploads/analyze", requireDb, protect, upload.single("file"), asyncRoute(async (req, res) => sendUpstream(await forwardMultipart({ path: "/api/v1/uploads/analyze", file: req.file, fields: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/mappings/preview", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/mappings/preview", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/mappings/readiness", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/mappings/readiness", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/mappings/confirm", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/mappings/confirm", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/conversions/export", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardBinary({ path: "/api/v1/conversions/export", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/import-repairs", requireDb, protect, boundedExcelUpload, asyncRoute(createMisaImportRepair));
router.post("/import-repairs/:repairId/schema", requireDb, protect, asyncRoute(submitMisaImportRepairSchema));
router.get("/import-repairs/:repairId", requireDb, protect, asyncRoute(readMisaImportRepair));
router.post("/import-repairs/:repairId/human-confirmations", requireDb, protect, asyncRoute(issueMisaImportRepairHumanConfirmation));
router.post("/import-repairs/:repairId/issues/:issueId/confirm-match", requireDb, protect, asyncRoute(confirmMisaImportRepairMatch));
router.post("/import-repairs/:repairId/document-groups/:groupId/import-status", requireDb, protect, asyncRoute(setMisaImportRepairImportStatus));
router.post("/import-repairs/:repairId/issues/:issueId/resolve", requireDb, protect, asyncRoute(resolveMisaImportRepairIssue));
router.post("/import-repairs/:repairId/bulk-actions/simulate", requireDb, protect, asyncRoute(simulateMisaImportRepairBulk));
router.post("/import-repairs/:repairId/bulk-actions/apply", requireDb, protect, asyncRoute(applyMisaImportRepairBulk));
router.post("/import-repairs/:repairId/retry-batches", requireDb, protect, asyncRoute(createMisaImportRetryBatch));
router.get("/import-repairs/:repairId/retry-batches/:batchId/download", requireDb, protect, asyncRoute(downloadMisaImportRetryBatch));
router.post("/sessions", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/sessions", method: "POST", body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.get("/sessions/:id", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: `/api/v1/sessions/${encodeURIComponent(req.params.id)}`, method: "GET", contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.post("/sessions/:id/comparison-files", requireDb, protect, upload.single("file"), asyncRoute(async (req, res) => sendUpstream(await forwardMultipart({ path: `/api/v1/sessions/${encodeURIComponent(req.params.id)}/comparison-files`, file: req.file, fields: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.delete("/sessions/:id/comparison-files/:fileId", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: `/api/v1/sessions/${encodeURIComponent(req.params.id)}/comparison-files/${encodeURIComponent(req.params.fileId)}?${new URLSearchParams(req.query).toString()}`, method: "DELETE", contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.all("/sessions/:id/*", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: `/api/v1/sessions/${encodeURIComponent(req.params.id)}/${req.params[0]}`, method: req.method, body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));

module.exports = { mergeGatewayCapabilities, router };
