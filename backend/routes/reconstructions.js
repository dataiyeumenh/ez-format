const path = require("node:path");
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
const {
  activateReconstructionProfile,
  createReconstructionRun,
  getReconstructionRun,
  listReconstructionRuns,
  saveReconstructionProfile,
} = require("../controllers/reconstructionController");
const {
  createConversionContextToken,
  verifyReconstructionContextToken,
} = require("../services/conversionContextService");
const {
  forwardBinary,
  forwardJson,
  forwardMultipart,
  isConverterGatewayUsageReady,
} = require("../services/converterGatewayService");

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.CONVERTER_MAX_FILE_BYTES || 20 * 1024 * 1024),
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

async function trustedReconstructionRun(req, requiredScope) {
  const token = String(
    req.headers["x-reconstruction-context"] || req.body?.context_token || "",
  ).trim();
  if (!token) {
    const error = new Error("Thiếu reconstruction context");
    error.statusCode = 401;
    throw error;
  }

  let claims;
  try {
    claims = verifyReconstructionContextToken(token, requiredScope);
  } catch (cause) {
    const error = new Error(cause.message);
    error.statusCode = 401;
    throw error;
  }
  if (
    String(claims.run_id || "") !== String(req.params.id || "") ||
    String(claims.user_id || "") !== String(req.user?._id || "")
  ) {
    const error = new Error("Reconstruction context không thuộc run này");
    error.statusCode = 403;
    throw error;
  }

  const run = mongoose.isValidObjectId(req.params.id)
    ? await VoucherReconstructionRun.findOne({
        _id: req.params.id,
        user: req.user._id,
        expiresAt: { $gt: new Date() },
      })
    : null;
  if (!run) {
    const error = new Error("Không tìm thấy phiên tái tạo chứng từ");
    error.statusCode = 404;
    throw error;
  }
  return { claims, run, token };
}

function gatewayContext(req, trusted, requiredScope) {
  const workspaceId = trusted.run.workspace
    ? String(trusted.run.workspace)
    : null;
  return createConversionContextToken({
    userId: req.user._id,
    workspaceId,
    ownerScope: workspaceId
      ? `workspace:${workspaceId}`
      : `user:${req.user._id}`,
    snapshotSetHash: trusted.run.snapshotSetHash || null,
    snapshotIds: [],
    masterDataRevision: Number(trusted.run.workspaceRevision || 0),
    conversionRunId: trusted.run.conversionRun,
    operationSessionId: trusted.run._id,
    targetTemplateId: trusted.run.targetTemplateId || "",
    scopes: [requiredScope],
  });
}

function operationBody(operation, body = {}) {
  if (operation === "draft") {
    return {
      expected_revision: Number(body.expected_revision || 0),
      operations: Array.isArray(body.operations) ? body.operations : [],
    };
  }
  if (operation === "split") {
    return {
      draft_id: String(body.draft_id || ""),
      expected_revision: Number(body.expected_revision || 0),
      source_rows: Array.isArray(body.source_rows) ? body.source_rows : [],
    };
  }
  if (operation === "merge") {
    return {
      draft_ids: Array.isArray(body.draft_ids) ? body.draft_ids.map(String) : [],
      expected_revisions:
        body.expected_revisions && typeof body.expected_revisions === "object"
          ? body.expected_revisions
          : {},
    };
  }
  if (["approve", "export"].includes(operation)) {
    return { acknowledge_warnings: body.acknowledge_warnings === true };
  }
  return {};
}

async function analyzeReconstruction(req, res) {
  const trusted = await trustedReconstructionRun(req, "analyze");
  const targetTemplateId = String(
    req.body?.target_template_id || trusted.run.targetTemplateId || "",
  ).slice(0, 128);
  const response = await forwardMultipart({
    path: "/api/v1/reconstructions/analyze",
    file: req.file,
    fields: {
      context_token: trusted.token,
      mode: String(req.body?.mode || trusted.run.mode || "auto").slice(0, 32),
      target_template_id: targetTemplateId,
    },
    contextToken: gatewayContext(req, trusted, "analyze"),
    requestId: req.requestId,
    extraHeaders: { "x-reconstruction-context": trusted.token },
  });
  return sendUpstream(response, res);
}

async function proxyReconstructionOperation(req, res, operation) {
  const requiredScope =
    operation === "export"
      ? "export"
      : operation === "approve"
        ? "approve"
        : "review";
  const trusted = await trustedReconstructionRun(req, requiredScope);
  const suffix =
    operation === "draft"
      ? `drafts/${encodeURIComponent(req.params.draftId)}`
      : operation;
  const request = {
    path: `/api/v1/reconstructions/${encodeURIComponent(req.params.id)}/${suffix}`,
    body: operationBody(operation, req.body),
    contextToken: gatewayContext(req, trusted, requiredScope),
    requestId: req.requestId,
    extraHeaders: {
      "x-reconstruction-context": trusted.token,
      "idempotency-key": req.headers["idempotency-key"],
    },
    method: operation === "draft" ? "PATCH" : "POST",
  };
  const response =
    operation === "export"
      ? await forwardBinary(request)
      : await forwardJson(request);
  return sendUpstream(response, res);
}

router.use(requireDb, protect);

const createBuckets = new Map();
function limitRunCreation(req, res, next) {
  const windowMs = 15 * 60 * 1000;
  const limit = Math.max(
    1,
    Number(process.env.RECONSTRUCTION_CREATE_LIMIT_PER_15_MINUTES || 20),
  );
  const key = String(req.user?._id || req.ip || "anonymous");
  const now = Date.now();
  const bucket = createBuckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    createBuckets.set(key, { count: 1, expiresAt: now + windowMs });
    return next();
  }
  if (bucket.count >= limit) {
    return res.status(429).json({
      success: false,
      message: "Bạn đã tạo quá nhiều phiên tái tạo. Vui lòng thử lại sau.",
    });
  }
  bucket.count += 1;
  return next();
}

router.get("/", listReconstructionRuns);
router.post("/", limitRunCreation, createReconstructionRun);
router.get("/:id", getReconstructionRun);
router.post("/:id/profiles", saveReconstructionProfile);
router.post("/profiles/:profileId/activate", activateReconstructionProfile);
if (isConverterGatewayUsageReady()) {
  router.post(
    "/:id/operations/analyze",
    upload.single("file"),
    asyncRoute(analyzeReconstruction),
  );
  const proxy = (operation) =>
    asyncRoute((req, res) => proxyReconstructionOperation(req, res, operation));
  router.patch("/:id/operations/drafts/:draftId", proxy("draft"));
  router.post("/:id/operations/split", proxy("split"));
  router.post("/:id/operations/merge", proxy("merge"));
  router.post("/:id/operations/validate", proxy("validate"));
  router.post("/:id/operations/approve", proxy("approve"));
  router.post("/:id/operations/export", proxy("export"));
}

module.exports = router;
