const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const {
  bindConversionContextToUser,
  forwardJson,
  forwardMultipart,
  forwardBinary,
} = require("../services/converterGatewayService");
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

function gatewayContext(req, required = true) {
  return bindConversionContextToUser({
    contextToken: req.headers["x-conversion-context"],
    user: req.user,
    required,
  });
}

function sendUpstream(response, res) {
  for (const [name, value] of Object.entries(response.headers || {})) res.setHeader(name, value);
  if (Buffer.isBuffer(response.data)) return res.status(response.status).send(response.data);
  return res.status(response.status).json(response.data == null ? {} : response.data);
}

const DISABLED_OPERATION_CAPABILITIES = Object.freeze({
  mapping_profile_v2: false,
  anomaly_detection: false,
  bulk_correction: false,
  reconciliation: false,
  accounting_assistant: false,
  ai_explanation: false,
  limits: {
    comparison_files: 0,
    raw_ttl_minutes: 0,
    max_rows_per_file: 0,
  },
});

function mergeGatewayCapabilities(
  payload = {},
  env = process.env,
  operations = {},
  { gatewayAvailable = true } = {},
) {
  const backendStudentEnabled =
    String(env.STUDENT_ASSISTANT_ENABLED || "false").toLowerCase() === "true";
  if (!gatewayAvailable) {
    return {
      status: "unavailable",
      available: false,
      gateway: false,
      artifactStorage: null,
      misa_import_repair: {
        enabled: false,
        phase: 1,
        adapter: "manual_excel_v1",
        verified_adapter: false,
        auto_match: false,
        retry_unit: "document_group",
      },
      capabilities: {
        ...DISABLED_OPERATION_CAPABILITIES,
        studentAssistant: false,
        studentFileExplain: false,
      },
    };
  }
  return {
    ...payload,
    available: true,
    misa_import_repair: {
      enabled:
        String(env.MISA_IMPORT_REPAIR_ENABLED || "false").trim().toLowerCase() ===
        "true",
      phase: 1,
      adapter: "manual_excel_v1",
      verified_adapter: false,
      auto_match: false,
      retry_unit: "document_group",
    },
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

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_SUFFIX_RULES = [
  { method: "GET", pattern: /^revisions$/ },
  { method: "POST", pattern: /^revisions\/[1-9]\d*\/activate$/ },
  { method: "POST", pattern: /^anomalies\/detect$/ },
  { method: "GET", pattern: /^anomalies$/ },
  { method: "POST", pattern: /^anomalies\/[A-Za-z0-9_-]{1,128}\/review$/ },
  { method: "POST", pattern: /^corrections\/(?:propose|simulate)$/ },
  {
    method: "POST",
    pattern: /^corrections\/(?:apply|undo)$/,
    requiresIdempotencyKey: true,
  },
  { method: "POST", pattern: /^reconciliation\/run$/ },
  { method: "GET", pattern: /^reconciliation\/[A-Za-z0-9_-]{1,128}$/ },
  {
    method: "POST",
    pattern:
      /^reconciliation\/[A-Za-z0-9_-]{1,128}\/matches\/[A-Za-z0-9_-]{1,128}\/confirm$/,
  },
  { method: "POST", pattern: /^questions$/ },
];

function decodeSessionSuffix(value) {
  let decoded = String(value || "");
  for (let index = 0; index < 2; index += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.includes("//") ||
    decoded.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return decoded;
}

function resolveSessionProxyRoute({ method, sessionId, suffix = "" }) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedSessionId = String(sessionId || "").trim();
  if (!suffix) {
    if (normalizedMethod === "POST" && !normalizedSessionId) {
      return {
        method: "POST",
        path: "/api/v1/mappings/session",
        requiresIdempotencyKey: false,
      };
    }
    if (normalizedMethod === "GET" && SAFE_SESSION_SEGMENT.test(normalizedSessionId)) {
      return {
        method: "GET",
        path: `/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/revisions`,
        requiresIdempotencyKey: false,
      };
    }
    return null;
  }
  if (!SAFE_SESSION_SEGMENT.test(normalizedSessionId)) return null;
  const normalizedSuffix = decodeSessionSuffix(suffix);
  if (!normalizedSuffix) return null;
  const rule = SESSION_SUFFIX_RULES.find(
    (candidate) =>
      candidate.method === normalizedMethod &&
      candidate.pattern.test(normalizedSuffix),
  );
  if (!rule) return null;
  return {
    method: normalizedMethod,
    path: `/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/${normalizedSuffix}`,
    requiresIdempotencyKey: rule.requiresIdempotencyKey === true,
  };
}

function safeQueryString(query = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item != null) params.append(name, String(item));
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function createSessionProxyHandler({
  forward = forwardJson,
  contextForRequest = gatewayContext,
} = {}) {
  return async function sessionProxyHandler(req, res) {
    const route = resolveSessionProxyRoute({
      method: req.method,
      sessionId: req.params.id,
      suffix: req.params[0],
    });
    if (!route) {
      return res.status(404).json({ message: "Converter session route not found" });
    }
    const extraHeaders = {};
    if (route.requiresIdempotencyKey) {
      const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
      if (!idempotencyKey) {
        return res.status(400).json({ message: "Idempotency-Key is required" });
      }
      extraHeaders["idempotency-key"] = idempotencyKey;
    }
    const response = await forward({
      path: `${route.path}${safeQueryString(req.query)}`,
      method: route.method,
      body: req.body,
      contextToken: contextForRequest(req),
      requestId: req.requestId,
      extraHeaders,
    });
    return sendUpstream(response, res);
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
router.get("/templates", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: "/api/v1/templates", method: "GET", contextToken: gatewayContext(req, false), requestId: req.requestId, requireContext: false }), res)));
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
router.post("/sessions", requireDb, protect, asyncRoute(async (req, res) => {
  const route = resolveSessionProxyRoute({ method: "POST" });
  return sendUpstream(await forwardJson({ path: route.path, method: route.method, body: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res);
}));
router.get("/sessions/:id", requireDb, protect, asyncRoute(async (req, res) => {
  const route = resolveSessionProxyRoute({ method: "GET", sessionId: req.params.id });
  if (!route) return res.status(404).json({ message: "Converter session route not found" });
  return sendUpstream(await forwardJson({ path: route.path, method: route.method, contextToken: gatewayContext(req), requestId: req.requestId }), res);
}));
router.post("/sessions/:id/comparison-files", requireDb, protect, upload.single("file"), asyncRoute(async (req, res) => sendUpstream(await forwardMultipart({ path: `/api/v1/sessions/${encodeURIComponent(req.params.id)}/comparison-files`, file: req.file, fields: req.body, contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.delete("/sessions/:id/comparison-files/:fileId", requireDb, protect, asyncRoute(async (req, res) => sendUpstream(await forwardJson({ path: `/api/v1/sessions/${encodeURIComponent(req.params.id)}/comparison-files/${encodeURIComponent(req.params.fileId)}?${new URLSearchParams(req.query).toString()}`, method: "DELETE", contextToken: gatewayContext(req), requestId: req.requestId }), res)));
router.all("/sessions/:id/*", requireDb, protect, asyncRoute(createSessionProxyHandler()));

module.exports = {
  createSessionProxyHandler,
  mergeGatewayCapabilities,
  resolveSessionProxyRoute,
  router,
};
