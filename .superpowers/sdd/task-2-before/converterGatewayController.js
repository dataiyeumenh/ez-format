const path = require("node:path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const ConversionRun = require("../models/ConversionRun");
const StudentFileSession = require("../models/StudentFileSession");
const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
const {
  verifyConversionContextToken,
  verifyReconstructionContextToken,
  verifyStudentContextToken,
} = require("../services/conversionContextService");
const { userCanAccessWorkspace } = require("../services/masterDataService");
const {
  forwardBinary,
  forwardJson,
  forwardMultipart,
} = require("../services/converterGatewayService");

const UNSAFE_CLIENT_KEYS = new Set([
  "userId",
  "user_id",
  "ownerScope",
  "owner_scope",
  "workspaceId",
  "workspace_id",
  "plan",
  "planId",
  "plan_id",
  "planCode",
  "plan_code",
  "conversionContextToken",
  "conversion_context_token",
  "studentContextToken",
  "student_context_token",
  "reconstructionContextToken",
  "reconstruction_context_token",
  "contextToken",
  "context_token",
]);
const EXCEL_EXTENSIONS = new Set([".xls", ".xlsx"]);
const STUDENT_BINARY_OPERATIONS = new Set([
  "anonymization/export",
  "internship-report",
]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizeGatewayBody(body = {}, { stripRows = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => !UNSAFE_CLIENT_KEYS.has(key) && !(stripRows && key === "rows"),
    ),
  );
}

function cleanText(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function isSupportedExcelFile(file) {
  return Boolean(
    file?.originalname &&
      file?.buffer &&
      EXCEL_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()),
  );
}

function contextSecret() {
  const secret = process.env.CONVERSION_CONTEXT_SECRET || process.env.JWT_SECRET;
  if (!secret) throw httpError(503, "CONVERSION_CONTEXT_SECRET chưa được cấu hình");
  return secret;
}

function clientConversionContextToken(req) {
  return cleanText(
    req.headers?.["x-conversion-context"] ||
      req.body?.conversion_context_token ||
      req.body?.conversionContextToken,
    8192,
  );
}

async function trustedConversionClaims(req) {
  const userId = cleanText(req.user?._id, 128);
  if (!userId) throw httpError(401, "Thiếu người dùng đã xác thực");
  const suppliedToken = clientConversionContextToken(req);
  let claims = {};
  if (suppliedToken) {
    try {
      claims = verifyConversionContextToken(suppliedToken);
    } catch (error) {
      throw httpError(401, error.message);
    }
    if (cleanText(claims.user_id, 128) !== userId) {
      throw httpError(403, "Conversion context không thuộc người dùng này");
    }
  }

  const workspaceId = cleanText(claims.workspace_id, 128) || null;
  let workspace = null;
  if (workspaceId) {
    if (!mongoose.isValidObjectId(workspaceId)) {
      throw httpError(403, "Conversion context workspace không hợp lệ");
    }
    workspace = await AccountingWorkspace.findOne({
      _id: workspaceId,
      isActive: true,
    });
    if (!workspace || !userCanAccessWorkspace(workspace, userId)) {
      throw httpError(403, "Không có quyền sử dụng hồ sơ doanh nghiệp này");
    }
  }
  const ownerScope = workspaceId ? `workspace:${workspaceId}` : `user:${userId}`;
  if (claims.owner_scope && claims.owner_scope !== ownerScope) {
    throw httpError(403, "Conversion context owner scope không hợp lệ");
  }
  return { claims, ownerScope, userId, workspace, workspaceId };
}

function assertBinding(claims, binding) {
  const checks = [
    ["target_template_id", binding.targetTemplateId, "Template"],
    ["upload_id", binding.uploadId, "Upload"],
    ["conversion_run_id", binding.conversionRunId, "Conversion run"],
    ["operation_session_id", binding.operationSessionId, "Operation session"],
  ];
  for (const [claimName, expected, label] of checks) {
    const supplied = cleanText(claims?.[claimName], 256);
    if (supplied && expected && supplied !== expected) {
      throw httpError(409, `${label} không khớp conversion context`);
    }
  }
}

function signGatewayContext(scope, binding = {}) {
  const normalizedBinding = {
    targetTemplateId: cleanText(binding.targetTemplateId, 128),
    uploadId: cleanText(binding.uploadId, 128),
    conversionRunId: cleanText(binding.conversionRunId, 128),
    operationSessionId: cleanText(binding.operationSessionId, 128),
  };
  assertBinding(scope.claims, normalizedBinding);
  return jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: scope.userId,
      owner_scope: scope.ownerScope,
      workspace_id: scope.workspaceId,
      snapshot_set_hash: scope.claims.snapshot_set_hash ?? null,
      snapshot_ids: Array.isArray(scope.claims.snapshot_ids)
        ? scope.claims.snapshot_ids.map(String)
        : [],
      master_data_revision: Number(scope.claims.master_data_revision || 0),
      target_template_id: normalizedBinding.targetTemplateId,
      upload_id: normalizedBinding.uploadId,
      conversion_run_id: normalizedBinding.conversionRunId,
      operation_session_id: normalizedBinding.operationSessionId,
      max_file_bytes: Number(process.env.CONVERTER_MAX_FILE_BYTES || 20971520),
      scopes: Array.isArray(binding.scopes) ? binding.scopes.map(String) : [],
    },
    contextSecret(),
    { expiresIn: "10m", algorithm: "HS256" },
  );
}

function sendGatewayResult(res, result) {
  for (const header of ["content-type", "content-disposition", "retry-after"]) {
    if (result.headers?.[header]) res.setHeader(header, result.headers[header]);
  }
  res.status(result.status);
  if (Buffer.isBuffer(result.data)) return res.send(result.data);
  if (result.data == null) return res.send();
  return res.json(result.data);
}

function sendGatewayError(req, res, error) {
  const statusCode = Number(error.statusCode) || 500;
  return res.status(statusCode).json({
    success: false,
    message:
      statusCode >= 500 && ![502, 503, 504].includes(statusCode)
        ? "Không thể xử lý yêu cầu Converter"
        : error.message,
    requestId: req.requestId || "",
  });
}

async function findOwnedConversionRun(req, body, scope) {
  const runId = cleanText(
    body.conversion_run_id || body.conversionRunId || body.run_id || body.runId,
    128,
  );
  const uploadId = cleanText(body.upload_id || body.uploadId, 128);
  if (!runId && !uploadId) return null;
  const filter = {
    user: req.user._id,
    workspace: scope.workspaceId || null,
  };
  if (runId) {
    if (!mongoose.isValidObjectId(runId)) throw httpError(404, "Không tìm thấy conversion run");
    filter._id = runId;
  } else {
    filter.converterUploadId = uploadId;
  }
  const run = await ConversionRun.findOne(filter);
  if (!run) throw httpError(404, "Không tìm thấy conversion run");
  return run;
}

async function bindingForRequest(req, body, scope) {
  const claims = scope.claims || {};
  const suppliedRunId = cleanText(
    body.conversion_run_id ||
      body.conversionRunId ||
      body.run_id ||
      body.runId ||
      claims.conversion_run_id,
    128,
  );
  const suppliedUploadId = cleanText(
    body.upload_id || body.uploadId || claims.upload_id,
    128,
  );
  const run = await findOwnedConversionRun(
    req,
    {
      conversion_run_id: suppliedRunId,
      upload_id: suppliedUploadId,
    },
    scope,
  );
  const suppliedTemplateId = cleanText(
    body.target_template_id || body.targetTemplateId || claims.target_template_id,
    128,
  );
  const runUploadId = cleanText(run?.converterUploadId, 128);
  const runTemplateId = cleanText(run?.targetTemplateId, 128);
  if (runUploadId && suppliedUploadId && runUploadId !== suppliedUploadId) {
    throw httpError(409, "Upload không khớp conversion run");
  }
  if (runTemplateId && suppliedTemplateId && runTemplateId !== suppliedTemplateId) {
    throw httpError(409, "Template không khớp conversion run");
  }
  return {
    run,
    uploadId: runUploadId || suppliedUploadId,
    targetTemplateId: runTemplateId || suppliedTemplateId,
    conversionRunId: cleanText(run?._id, 128),
    operationSessionId: cleanText(
      body.session_id || body.sessionId || claims.operation_session_id,
      128,
    ),
  };
}

async function proxyJson(req, res, { path: converterPath, method = "POST" }) {
  try {
    const body = sanitizeGatewayBody(req.body);
    const scope = await trustedConversionClaims(req);
    const binding = await bindingForRequest(req, body, scope);
    const contextToken = signGatewayContext(scope, binding);
    const result = await forwardJson({
      path: converterPath,
      method,
      body: { ...body, conversion_context_token: contextToken },
      contextToken,
      requestId: req.requestId,
    });
    return sendGatewayResult(res, result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function getCapabilities(req, res) {
  return proxyJson(req, res, { path: "/api/v1/capabilities", method: "GET" });
}

async function getTemplates(req, res) {
  return proxyJson(req, res, { path: "/api/v1/templates", method: "GET" });
}

async function analyzeUpload(req, res) {
  let run = null;
  try {
    if (!isSupportedExcelFile(req.file)) {
      throw httpError(400, "Chỉ hỗ trợ file .xls hoặc .xlsx");
    }
    const targetTemplateId = cleanText(
      req.body?.target_template_id || req.body?.targetTemplateId,
      128,
    );
    const scope = await trustedConversionClaims(req);
    run = await ConversionRun.create({
      user: req.user._id,
      userNameSnapshot: req.user.name || "",
      userEmailSnapshot: req.user.email || "",
      fileName: path.basename(req.file.originalname).slice(0, 255),
      fileSizeBytes: Number(req.file.size || req.file.buffer.length),
      outputFormat: "MISA",
      status: "processing",
      targetTemplateId,
      workspace: scope.workspace?._id || null,
      workspaceNameSnapshot: scope.workspace?.name || "",
      snapshotSetHash: cleanText(scope.claims.snapshot_set_hash, 128),
      startedAt: new Date(),
    });
    const initialContextToken = signGatewayContext(scope, {
      targetTemplateId,
      conversionRunId: cleanText(run._id, 128),
      scopes: ["analyze"],
    });
    const result = await forwardMultipart({
      path: "/api/v1/uploads/analyze",
      file: req.file,
      fields: {
        target_template_id: targetTemplateId,
        conversion_context_token: initialContextToken,
        use_ai: req.body?.use_ai === "true" || req.body?.use_ai === true,
      },
      contextToken: initialContextToken,
      requestId: req.requestId,
    });
    if (result.status >= 400) {
      run.status = "failed";
      run.errorMessage = cleanText(
        result.data?.detail?.message || result.data?.detail || result.data?.message,
        1000,
      );
      await run.save();
      return sendGatewayResult(res, result);
    }

    const uploadId = cleanText(
      result.data?.upload_id || result.data?.uploadId || result.data?.upload?.id,
      128,
    );
    const resolvedTemplateId = cleanText(
      result.data?.target_template_id || targetTemplateId,
      128,
    );
    const operationSessionId = cleanText(
      result.data?.operation_session_id || result.data?.session_id,
      128,
    );
    run.converterUploadId = uploadId;
    run.targetTemplateId = resolvedTemplateId;
    await run.save();
    const contextToken = signGatewayContext(scope, {
      targetTemplateId: resolvedTemplateId,
      uploadId,
      conversionRunId: cleanText(run._id, 128),
      operationSessionId,
      scopes: ["analyze", "preview", "readiness", "confirm", "export"],
    });
    result.data = {
      ...(result.data || {}),
      contextToken,
      conversionRunId: String(run._id),
      runId: String(run._id),
    };
    return sendGatewayResult(res, result);
  } catch (error) {
    if (run && run.status === "processing") {
      run.status = "failed";
      run.errorMessage = cleanText(error.message, 1000);
      await run.save().catch(() => {});
    }
    return sendGatewayError(req, res, error);
  }
}

async function previewMapping(req, res) {
  return proxyJson(req, res, { path: "/api/v1/mappings/preview" });
}

async function readinessMapping(req, res) {
  return proxyJson(req, res, { path: "/api/v1/mappings/readiness" });
}

async function confirmMapping(req, res) {
  return proxyJson(req, res, { path: "/api/v1/mappings/confirm" });
}

async function mutateSession(req, res) {
  return proxyJson(req, res, { path: "/api/v1/mappings/session" });
}

async function getSession(req, res) {
  if (!clientConversionContextToken(req)) {
    return sendGatewayError(
      req,
      res,
      httpError(401, "Thiếu conversion context cho operation session"),
    );
  }
  req.body = { ...(req.body || {}), session_id: req.params.id };
  return proxyJson(req, res, {
    path: `/api/v1/sessions/${encodeURIComponent(req.params.id)}/revisions`,
    method: "GET",
  });
}

async function exportConversion(req, res) {
  try {
    const body = sanitizeGatewayBody(req.body, { stripRows: true });
    const scope = await trustedConversionClaims(req);
    const binding = await bindingForRequest(req, body, scope);
    const contextToken = signGatewayContext(scope, {
      ...binding,
      scopes: ["export"],
    });
    const result = await forwardBinary({
      path: "/api/v1/conversions/export",
      body: { ...body, conversion_context_token: contextToken },
      contextToken,
      requestId: req.requestId,
    });
    return sendGatewayResult(res, result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

function safeOperationPath(value) {
  const normalized = String(value || "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || !/^[a-z0-9_/-]+$/i.test(normalized)) {
    throw httpError(400, "Converter operation không hợp lệ");
  }
  return normalized;
}

function suppliedStudentToken(req) {
  return cleanText(
    req.headers?.["x-student-context"] ||
      req.body?.context_token ||
      req.body?.student_context_token,
    8192,
  );
}

async function trustedStudentSession(req, requiredScope) {
  const token = suppliedStudentToken(req);
  if (!token) throw httpError(401, "Thiếu student context");
  let claims;
  try {
    claims = verifyStudentContextToken(token, requiredScope);
  } catch (error) {
    throw httpError(401, error.message);
  }
  if (
    String(claims.session_id || "") !== String(req.params.id || "") ||
    String(claims.user_id || "") !== String(req.user?._id || "")
  ) {
    throw httpError(403, "Student context không thuộc phiên này");
  }
  const session = mongoose.isValidObjectId(req.params.id)
    ? await StudentFileSession.findOne({
        _id: req.params.id,
        userId: req.user._id,
        ownerScope: claims.owner_scope,
        workspaceId: claims.workspace_id || null,
        retentionExpiresAt: { $gt: new Date() },
        status: { $nin: ["expired", "deleted"] },
      })
    : null;
  if (!session) throw httpError(404, "Không tìm thấy phiên hỗ trợ đang hoạt động");
  return { claims, session, token };
}

function scopeFromStudent(req, trusted) {
  return {
    claims: {
      snapshot_set_hash: trusted.claims.snapshot_set_hash || null,
      snapshot_ids: [],
      master_data_revision: 0,
    },
    ownerScope: trusted.claims.owner_scope,
    userId: String(req.user._id),
    workspace: null,
    workspaceId: trusted.claims.workspace_id || null,
  };
}

async function analyzeStudentSession(req, res) {
  try {
    if (!isSupportedExcelFile(req.file)) throw httpError(400, "Chỉ hỗ trợ file .xls hoặc .xlsx");
    const trusted = await trustedStudentSession(req, "analyze");
    const targetTemplateId = cleanText(
      req.body?.target_template_id || trusted.session.targetTemplateId,
      128,
    );
    const contextToken = signGatewayContext(scopeFromStudent(req, trusted), {
      targetTemplateId,
      uploadId: cleanText(trusted.session.converterUploadId, 128),
      conversionRunId: `student:${trusted.session._id}`,
      operationSessionId: String(trusted.session._id),
      scopes: ["analyze"],
    });
    const result = await forwardMultipart({
      path: "/api/v1/student/sessions/analyze",
      file: req.file,
      fields: {
        context_token: trusted.token,
        target_template_id: targetTemplateId,
      },
      contextToken,
      requestId: req.requestId,
      extraHeaders: { "x-student-context": trusted.token },
    });
    return sendGatewayResult(res, result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function proxyStudentOperation(req, res) {
  try {
    const operation = safeOperationPath(
      req.params[0] || String(req.path || "").split("/operations/")[1],
    );
    const requiredScope = operation === "questions"
      ? "ask"
      : operation === "accounting-map"
        ? "accounting_map"
        : operation === "reconciliation"
          ? "reconcile"
          : STUDENT_BINARY_OPERATIONS.has(operation) ||
              operation === "anonymization/preview"
            ? "export"
            : "analyze";
    const trusted = await trustedStudentSession(req, requiredScope);
    const contextToken = signGatewayContext(scopeFromStudent(req, trusted), {
      targetTemplateId: cleanText(trusted.session.targetTemplateId, 128),
      uploadId: cleanText(trusted.session.converterUploadId, 128),
      conversionRunId: `student:${trusted.session._id}`,
      operationSessionId: String(trusted.session._id),
      scopes: [requiredScope],
    });
    const upstreamMethod = [
      "overview",
      "accounting-map",
      "reconciliation",
    ].includes(operation) || operation.startsWith("source-rows/")
      ? "GET"
      : "POST";
    const request = {
      path: `/api/v1/student/sessions/${encodeURIComponent(req.params.id)}/${operation}`,
      body: sanitizeGatewayBody(req.body, {
        stripRows: STUDENT_BINARY_OPERATIONS.has(operation),
      }),
      contextToken,
      requestId: req.requestId,
      extraHeaders: { "x-student-context": trusted.token },
      method: upstreamMethod,
    };
    const result = STUDENT_BINARY_OPERATIONS.has(operation)
      ? await forwardBinary(request)
      : await forwardJson(request);
    return sendGatewayResult(res, result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

function suppliedReconstructionToken(req) {
  return cleanText(
    req.headers?.["x-reconstruction-context"] || req.body?.context_token,
    8192,
  );
}

async function trustedReconstructionRun(req, requiredScope) {
  const token = suppliedReconstructionToken(req);
  if (!token) throw httpError(401, "Thiếu reconstruction context");
  let claims;
  try {
    claims = verifyReconstructionContextToken(token, requiredScope);
  } catch (error) {
    throw httpError(401, error.message);
  }
  if (
    String(claims.run_id || "") !== String(req.params.id || "") ||
    String(claims.user_id || "") !== String(req.user?._id || "")
  ) {
    throw httpError(403, "Reconstruction context không thuộc run này");
  }
  const run = mongoose.isValidObjectId(req.params.id)
    ? await VoucherReconstructionRun.findOne({
        _id: req.params.id,
        user: req.user._id,
        expiresAt: { $gt: new Date() },
      })
    : null;
  if (!run) throw httpError(404, "Không tìm thấy phiên tái tạo chứng từ");
  return { claims, run, token };
}

function scopeFromReconstruction(req, trusted) {
  const workspaceId = trusted.run.workspace ? String(trusted.run.workspace) : null;
  return {
    claims: {
      snapshot_set_hash: trusted.run.snapshotSetHash || null,
      snapshot_ids: [],
      master_data_revision: Number(trusted.run.workspaceRevision || 0),
    },
    ownerScope: workspaceId ? `workspace:${workspaceId}` : `user:${req.user._id}`,
    userId: String(req.user._id),
    workspace: null,
    workspaceId,
  };
}

async function analyzeReconstruction(req, res) {
  try {
    if (!isSupportedExcelFile(req.file)) throw httpError(400, "Chỉ hỗ trợ file .xls hoặc .xlsx");
    const trusted = await trustedReconstructionRun(req, "analyze");
    const contextToken = signGatewayContext(scopeFromReconstruction(req, trusted), {
      targetTemplateId: cleanText(
        req.body?.target_template_id || trusted.run.targetTemplateId,
        128,
      ),
      conversionRunId: String(trusted.run.conversionRun),
      operationSessionId: String(trusted.run._id),
      scopes: ["analyze"],
    });
    const result = await forwardMultipart({
      path: "/api/v1/reconstructions/analyze",
      file: req.file,
      fields: {
        context_token: trusted.token,
        mode: cleanText(req.body?.mode || trusted.run.mode, 32),
        target_template_id: cleanText(
          req.body?.target_template_id || trusted.run.targetTemplateId,
          128,
        ),
      },
      contextToken,
      requestId: req.requestId,
      extraHeaders: { "x-reconstruction-context": trusted.token },
    });
    return sendGatewayResult(res, result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function proxyReconstructionOperation(req, res) {
  try {
    const operation = safeOperationPath(
      req.params[0] || String(req.path || "").split("/operations/")[1],
    );
    const requiredScope = operation === "export" ? "export" : "review";
    const trusted = await trustedReconstructionRun(req, requiredScope);
    const contextToken = signGatewayContext(scopeFromReconstruction(req, trusted), {
      targetTemplateId: cleanText(trusted.run.targetTemplateId, 128),
      conversionRunId: String(trusted.run.conversionRun),
      operationSessionId: String(trusted.run._id),
      scopes: [requiredScope],
    });
    const upstreamMethod = operation.startsWith("drafts/") ? "PATCH" : "POST";
    const request = {
      path: `/api/v1/reconstructions/${encodeURIComponent(req.params.id)}/${operation}`,
      body: sanitizeGatewayBody(req.body, { stripRows: operation === "export" }),
      contextToken,
      requestId: req.requestId,
      extraHeaders: {
        "x-reconstruction-context": trusted.token,
        "idempotency-key": req.headers?.["idempotency-key"],
      },
      method: upstreamMethod,
    };
    const result = operation === "export"
      ? await forwardBinary(request)
      : await forwardJson(request);
    return sendGatewayResult(res, result);
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

module.exports = {
  analyzeReconstruction,
  analyzeStudentSession,
  analyzeUpload,
  confirmMapping,
  exportConversion,
  getCapabilities,
  getSession,
  getTemplates,
  isSupportedExcelFile,
  mutateSession,
  previewMapping,
  proxyReconstructionOperation,
  proxyStudentOperation,
  readinessMapping,
  sanitizeGatewayBody,
  sendGatewayResult,
  signGatewayContext,
};
