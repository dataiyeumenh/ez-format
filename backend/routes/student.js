const path = require("node:path");
const express = require("express");
const multer = require("multer");
const requireDb = require("../middleware/requireDb");
const { protect } = require("../middleware/auth");
const StudentFileSession = require("../models/StudentFileSession");
const {
  createStudentSession,
  deleteStudentActivities,
  deleteStudentSession,
  getStudentActivities,
  getStudentAttempts,
  getStudentProgress,
  getStudentSession,
  refreshStudentContext,
  sessionIsExpired,
  studentContextMatchesSession,
} = require("../controllers/studentSessionController");
const {
  createConversionContextToken,
  verifyStudentContextToken,
} = require("../services/conversionContextService");
const {
  forwardBinary,
  forwardJson,
  forwardMultipart,
  isConverterGatewayUsageReady,
} = require("../services/converterGatewayService");

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(
      process.env.CONVERTER_MAX_FILE_BYTES || 20 * 1024 * 1024,
    ),
    files: 1,
  },
  fileFilter(_req, file, callback) {
    if ([".xls", ".xlsx"].includes(path.extname(file.originalname).toLowerCase())) {
      return callback(null, true);
    }
    const error = new Error("Chỉ hỗ trợ file .xls hoặc .xlsx");
    error.statusCode = 400;
    return callback(error);
  },
});
const BINARY_OPERATIONS = new Set([
  "anonymization/export",
  "internship-report",
]);

function sendUpstream(response, res) {
  for (const [name, value] of Object.entries(response.headers || {})) {
    res.setHeader(name, value);
  }
  if (Buffer.isBuffer(response.data)) {
    return res.status(response.status).send(response.data);
  }
  return res
    .status(response.status)
    .json(response.data == null ? {} : response.data);
}

function safeOperation(value) {
  const operation = String(value || "").replace(/^\/+|\/+$/g, "");
  const allowed =
    [
      "overview",
      "questions",
      "accounting-map",
      "reconciliation",
      "anonymization/preview",
      "anonymization/export",
      "internship-report",
    ].includes(operation) || /^source-rows\/\d+$/.test(operation);
  if (!allowed) {
    const error = new Error("Student operation không hợp lệ");
    error.statusCode = 404;
    throw error;
  }
  return operation;
}

function operationScope(operation) {
  if (operation === "questions" || operation.startsWith("source-rows/")) {
    return "ask";
  }
  if (operation === "accounting-map") return "accounting_map";
  if (operation === "reconciliation") return "reconcile";
  if (
    BINARY_OPERATIONS.has(operation) ||
    operation === "anonymization/preview"
  ) {
    return "export";
  }
  return "analyze";
}

function operationBody(operation, body = {}) {
  if (operation === "questions") {
    return { question: String(body.question || "").slice(0, 2000) };
  }
  if (operation.startsWith("anonymization/")) {
    return { full_document_numbers: body.full_document_numbers === true };
  }
  if (operation === "internship-report") {
    return {
      activity_ids: Array.isArray(body.activity_ids)
        ? body.activity_ids.map(String).slice(0, 100)
        : [],
      approved_notes: Array.isArray(body.approved_notes)
        ? body.approved_notes.map((value) => String(value).slice(0, 1000)).slice(0, 20)
        : [],
    };
  }
  return {};
}

async function trustedSession(req, requiredScope) {
  const token = String(req.headers["x-student-context"] || "").trim();
  if (!token) {
    const error = new Error("Thiếu student context");
    error.statusCode = 401;
    throw error;
  }

  let claims;
  try {
    claims = verifyStudentContextToken(token, requiredScope);
  } catch (cause) {
    const error = new Error(cause.message);
    error.statusCode = 401;
    throw error;
  }
  const session = await StudentFileSession.findOne({
    _id: req.params.id,
    userId: req.user._id,
    ownerScope: claims.owner_scope,
    workspaceId: claims.workspace_id || null,
  });
  if (!session || !studentContextMatchesSession(claims, session)) {
    const error = new Error("Student context không thuộc phiên này");
    error.statusCode = 403;
    throw error;
  }
  if (sessionIsExpired(session)) {
    const error = new Error("Phiên học đã hết hạn");
    error.statusCode = 410;
    throw error;
  }
  return { claims, session, token };
}

function gatewayContext(req, trusted, requiredScope) {
  return createConversionContextToken({
    userId: req.user._id,
    workspaceId: trusted.claims.workspace_id || null,
    ownerScope: trusted.claims.owner_scope,
    snapshotSetHash: trusted.claims.snapshot_set_hash || null,
    conversionRunId: `student:${trusted.session._id}`,
    operationSessionId: trusted.session._id,
    uploadId: trusted.session.converterUploadId || "",
    targetTemplateId: trusted.session.targetTemplateId || "",
    scopes: [requiredScope],
  });
}

async function analyzeStudentSession(req, res) {
  const trusted = await trustedSession(req, "analyze");
  const targetTemplateId = String(
    req.body?.target_template_id || trusted.session.targetTemplateId || "",
  ).slice(0, 128);
  const response = await forwardMultipart({
    path: "/api/v1/student/sessions/analyze",
    file: req.file,
    fields: {
      context_token: trusted.token,
      target_template_id: targetTemplateId,
    },
    contextToken: gatewayContext(req, trusted, "analyze"),
    requestId: req.requestId,
    extraHeaders: { "x-student-context": trusted.token },
  });
  return sendUpstream(response, res);
}

async function proxyStudentOperation(req, res, requestedOperation) {
  const operation = safeOperation(requestedOperation);
  const requiredScope = operationScope(operation);
  const trusted = await trustedSession(req, requiredScope);
  if (!trusted.session.converterUploadId) {
    const error = new Error("Phiên hỗ trợ chưa có converter upload");
    error.statusCode = 409;
    throw error;
  }
  const request = {
    path: `/api/v1/student/sessions/${encodeURIComponent(req.params.id)}/${operation}`,
    body: operationBody(operation, req.body),
    contextToken: gatewayContext(req, trusted, requiredScope),
    requestId: req.requestId,
    extraHeaders: { "x-student-context": trusted.token },
    method: req.method,
  };
  const response = BINARY_OPERATIONS.has(operation)
    ? await forwardBinary(request)
    : await forwardJson(request);
  return sendUpstream(response, res);
}

router.use(requireDb, protect);
router.post("/sessions", asyncRoute(createStudentSession));
router.get("/sessions/:id", asyncRoute(getStudentSession));
router.get("/sessions/:id/attempts", asyncRoute(getStudentAttempts));
router.get("/sessions/:id/activity", asyncRoute(getStudentActivities));
router.get("/progress", asyncRoute(getStudentProgress));
router.delete("/sessions/:id/activity", asyncRoute(deleteStudentActivities));
router.delete("/sessions/:id", asyncRoute(deleteStudentSession));
router.post("/sessions/:id/context", asyncRoute(refreshStudentContext));
if (isConverterGatewayUsageReady()) {
  router.post(
    "/sessions/:id/analyze",
    upload.single("file"),
    asyncRoute(analyzeStudentSession),
  );
  const proxy = (operation) =>
    asyncRoute((req, res) => proxyStudentOperation(req, res, operation(req)));
  router.get("/sessions/:id/operations/overview", proxy(() => "overview"));
  router.post("/sessions/:id/operations/questions", proxy(() => "questions"));
  router.get(
    "/sessions/:id/operations/source-rows/:worksheetRow",
    proxy((req) => `source-rows/${req.params.worksheetRow}`),
  );
  router.get(
    "/sessions/:id/operations/accounting-map",
    proxy(() => "accounting-map"),
  );
  router.get(
    "/sessions/:id/operations/reconciliation",
    proxy(() => "reconciliation"),
  );
  router.post(
    "/sessions/:id/operations/anonymization/preview",
    proxy(() => "anonymization/preview"),
  );
  router.post(
    "/sessions/:id/operations/anonymization/export",
    proxy(() => "anonymization/export"),
  );
  router.post(
    "/sessions/:id/operations/internship-report",
    proxy(() => "internship-report"),
  );
}

module.exports = router;
