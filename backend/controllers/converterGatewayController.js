const path = require("node:path");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const ConversionRun = require("../models/ConversionRun");
const MasterDataSnapshot = require("../models/MasterDataSnapshot");
const StudentFileSession = require("../models/StudentFileSession");
const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
const {
  assertConversionContextBinding,
  createConversionContextToken,
  verifyConversionContextToken,
  verifyReconstructionContextToken,
  verifyStudentContextToken,
} = require("../services/conversionContextService");
const {
  assertCurrentConversionEntitlement,
} = require("../services/conversionEntitlementService");
const {
  chargeCompletedConversion,
} = require("../services/conversionCreditService");
const conversionArtifacts = require("../services/conversionArtifactService");
const {
  buildSnapshotSetHash,
  userCanAccessWorkspace,
} = require("../services/masterDataService");
const {
  forwardBinary,
  forwardJson,
  forwardMultipart,
  sanitizeUpstreamJson,
} = require("../services/converterGatewayService");
const conversionSessionStates = require("../services/conversionSessionStateService");

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
const GATEWAY_CONTEXT_TTL_SECONDS = 10 * 60;

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

function requestIdempotencyKey(req) {
  return (
    cleanText(req.headers?.["idempotency-key"], 256) ||
    cleanText(req.body?.idempotency_key || req.body?.idempotencyKey, 256) ||
    crypto.randomUUID()
  );
}

function suppliedIdempotencyKey(req) {
  return (
    cleanText(req.headers?.["idempotency-key"], 256) ||
    cleanText(req.body?.idempotency_key || req.body?.idempotencyKey, 256)
  );
}

function isSupportedExcelFile(file) {
  return Boolean(
    file?.originalname &&
      file?.buffer &&
      EXCEL_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()),
  );
}

function operationSessionExpiry() {
  const configured = Number(process.env.OPERATION_SESSION_TTL_SECONDS || 3600);
  const ttlSeconds = Number.isFinite(configured) ? Math.max(60, configured) : 3600;
  return new Date(Date.now() + ttlSeconds * 1000);
}

function analyzeSessionExpiry(payload, fallback) {
  const value = payload?.session?.expires_at || payload?.session?.expiresAt;
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed <= new Date() ? fallback : parsed;
}

function gatewayArtifactExpiry(env = process.env) {
  const configured = Number(env.CONVERTER_ARTIFACT_TTL_SECONDS || 3600);
  const ttlSeconds = Number.isFinite(configured) ? Math.max(60, configured) : 3600;
  return new Date(Date.now() + ttlSeconds * 1000);
}

function clientConversionContextToken(req) {
  return cleanText(
    req.headers?.["x-conversion-context"] ||
      req.body?.conversion_context_token ||
      req.body?.conversionContextToken,
    8192,
  );
}

async function loadWorkspaceScope(workspaceId, userId) {
  if (!workspaceId) {
    return {
      workspace: null,
      workspaceId: null,
      snapshotIds: [],
      snapshotSetHash: null,
      masterDataRevision: 0,
    };
  }
  if (!mongoose.isValidObjectId(workspaceId)) {
    throw httpError(403, "Conversion context workspace không hợp lệ");
  }
  const workspace = await AccountingWorkspace.findOne({
    _id: workspaceId,
    isActive: true,
  });
  if (!workspace || !userCanAccessWorkspace(workspace, userId)) {
    throw httpError(403, "Không có quyền sử dụng hồ sơ doanh nghiệp này");
  }
  const snapshotIds = (workspace.activeSnapshots || []).map((item) =>
    String(item.snapshot?._id || item.snapshot),
  );
  const snapshots = snapshotIds.length
    ? await MasterDataSnapshot.find({
        _id: { $in: snapshotIds },
        workspace: workspace._id,
        status: "active",
      })
    : [];
  return {
    workspace,
    workspaceId: String(workspace._id),
    snapshotIds: snapshots.map((snapshot) => String(snapshot._id)),
    snapshotSetHash: buildSnapshotSetHash(snapshots),
    masterDataRevision: Number(workspace.masterDataRevision || 0),
  };
}

function sameStringSet(left, right) {
  return JSON.stringify((left || []).map(String).sort()) ===
    JSON.stringify((right || []).map(String).sort());
}

async function trustedConversionClaims(req, { requireRun = false } = {}) {
  const userId = cleanText(req.user?._id, 128);
  if (!userId) throw httpError(401, "Thiếu người dùng đã xác thực");
  const suppliedToken = clientConversionContextToken(req);
  if (requireRun && !suppliedToken) {
    throw httpError(401, "Thiếu conversion context cho export");
  }
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

  const claimedRunId = cleanText(claims.conversion_run_id, 128);
  let run = null;
  if (claimedRunId) {
    if (!mongoose.isValidObjectId(claimedRunId)) {
      throw httpError(404, "Không tìm thấy conversion run");
    }
    run = await ConversionRun.findOne({ _id: claimedRunId, user: req.user._id });
    if (!run) throw httpError(404, "Không tìm thấy conversion run");
  } else if (requireRun) {
    throw httpError(409, "Conversion context thiếu conversion run");
  }

  const workspaceId = run
    ? run.workspace
      ? String(run.workspace?._id || run.workspace)
      : null
    : cleanText(claims.workspace_id, 128) || null;
  const persisted = await loadWorkspaceScope(workspaceId, userId);
  if (run && cleanText(claims.workspace_id, 128) !== (workspaceId || "")) {
    throw httpError(409, "Workspace không khớp conversion run");
  }
  const canonicalSnapshotHash = run
    ? cleanText(run.snapshotSetHash, 128)
    : persisted.snapshotSetHash;
  if (run && workspaceId && canonicalSnapshotHash !== persisted.snapshotSetHash) {
    throw httpError(409, "Conversion run dùng snapshot workspace đã stale");
  }
  if (
    claims.snapshot_set_hash != null &&
    String(claims.snapshot_set_hash) !== String(canonicalSnapshotHash ?? "")
  ) {
    throw httpError(409, "Snapshot hash không khớp conversion run");
  }
  if (
    run &&
    Array.isArray(claims.snapshot_ids) &&
    !sameStringSet(claims.snapshot_ids, persisted.snapshotIds)
  ) {
    throw httpError(409, "Snapshot ids không khớp workspace hiện tại");
  }
  if (
    run &&
    claims.master_data_revision != null &&
    Number(claims.master_data_revision) !== persisted.masterDataRevision
  ) {
    throw httpError(409, "Master data revision đã stale");
  }
  const ownerScope = workspaceId ? `workspace:${workspaceId}` : `user:${userId}`;
  if (claims.owner_scope && claims.owner_scope !== ownerScope) {
    throw httpError(403, "Conversion context owner scope không hợp lệ");
  }
  return {
    claims: {
      ...claims,
      owner_scope: ownerScope,
      workspace_id: workspaceId,
      snapshot_set_hash: canonicalSnapshotHash,
      snapshot_ids: persisted.snapshotIds,
      master_data_revision: persisted.masterDataRevision,
    },
    ownerScope,
    run,
    userId,
    workspace: persisted.workspace,
    workspaceId,
  };
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
    conversionContextId: cleanText(
      binding.conversionContextId || scope.claims.conversion_context_id,
      128,
    ),
    targetTemplateId: cleanText(binding.targetTemplateId, 128),
    uploadId: cleanText(binding.uploadId, 128),
    conversionRunId: cleanText(binding.conversionRunId, 128),
    operationSessionId: cleanText(binding.operationSessionId, 128),
    aiMappingOptIn: binding.aiMappingOptIn === true,
  };
  assertBinding(scope.claims, normalizedBinding);
  return createConversionContextToken({
    userId: scope.userId,
    ownerScope: scope.ownerScope,
    workspaceId: scope.workspaceId,
    snapshotSetHash: scope.claims.snapshot_set_hash ?? null,
    snapshotIds: Array.isArray(scope.claims.snapshot_ids)
      ? scope.claims.snapshot_ids.map(String)
      : [],
    masterDataRevision: Number(scope.claims.master_data_revision || 0),
    conversionContextId: normalizedBinding.conversionContextId,
    targetTemplateId: normalizedBinding.targetTemplateId,
    uploadId: normalizedBinding.uploadId,
    conversionRunId: normalizedBinding.conversionRunId,
    operationSessionId: normalizedBinding.operationSessionId,
    aiMappingOptIn: normalizedBinding.aiMappingOptIn,
    maxFileBytes: Number(process.env.CONVERTER_MAX_FILE_BYTES || 20971520),
    scopes: Array.isArray(binding.scopes) ? binding.scopes.map(String) : [],
    expiresIn: "10m",
  });
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

async function bindingForRequest(
  req,
  body,
  scope,
  { requirePersistedBinding = false } = {},
) {
  const claims = scope.claims || {};
  if (requirePersistedBinding) {
    const run = scope.run;
    if (!run) throw httpError(404, "Không tìm thấy conversion run");
    const persisted = {
      conversionContextId: cleanText(run.conversionContextId, 128),
      uploadId: cleanText(run.converterUploadId, 128),
      targetTemplateId: cleanText(run.targetTemplateId, 128),
      conversionRunId: cleanText(run._id, 128),
      operationSessionId: cleanText(run.operationSessionId, 128),
    };
    if (Object.values(persisted).some((value) => !value)) {
      throw httpError(409, "Conversion run binding chưa hoàn chỉnh");
    }
    const supplied = {
      conversionRunId: cleanText(
        body.conversion_run_id || body.conversionRunId || body.run_id || body.runId,
        128,
      ),
      uploadId: cleanText(body.upload_id || body.uploadId, 128),
      targetTemplateId: cleanText(
        body.target_template_id || body.targetTemplateId,
        128,
      ),
      operationSessionId: cleanText(body.session_id || body.sessionId, 128),
      conversionContextId: cleanText(
        body.conversion_context_id || body.conversionContextId,
        128,
      ),
    };
    for (const [name, expected] of Object.entries(persisted)) {
      if (supplied[name] && supplied[name] !== expected) {
        throw httpError(409, `${name} không khớp conversion run`);
      }
    }
    return { run, ...persisted };
  }
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
    conversionContextId: cleanText(run?.conversionContextId || claims.conversion_context_id, 128),
    uploadId: runUploadId || suppliedUploadId,
    targetTemplateId: runTemplateId || suppliedTemplateId,
    conversionRunId: cleanText(run?._id, 128),
    operationSessionId: cleanText(
      run?.operationSessionId ||
        body.session_id ||
        body.sessionId ||
        claims.operation_session_id,
      128,
    ),
  };
}

async function proxyJson(
  req,
  res,
  { path: converterPath, method = "POST", requiredScope },
) {
  try {
    if (!requiredScope) throw httpError(500, "Gateway route chưa cấu hình scope");
    const body = sanitizeGatewayBody(req.body);
    const scope = await trustedConversionClaims(req);
    const binding = await bindingForRequest(req, body, scope);
    const contextToken = signGatewayContext(scope, {
      ...binding,
      scopes: [requiredScope],
    });
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
  return proxyJson(req, res, {
    path: "/api/v1/capabilities",
    method: "GET",
    requiredScope: "status",
  });
}

async function getTemplates(req, res) {
  return proxyJson(req, res, {
    path: "/api/v1/templates",
    method: "GET",
    requiredScope: "status",
  });
}

function persistedAnalyzeBinding(run) {
  return {
    conversionContextId: cleanText(run?.conversionContextId, 128),
    targetTemplateId: cleanText(run?.targetTemplateId, 128),
    uploadId: cleanText(run?.converterUploadId, 128),
    conversionRunId: cleanText(run?._id, 128),
    operationSessionId: cleanText(run?.operationSessionId, 128),
  };
}

function analyzeRetryConflict(message = "Idempotency key không khớp conversion run") {
  return httpError(409, message);
}

function assertAnalyzeRetryMatches(run, { req, inputSha256, targetTemplateId, scope }) {
  if (String(run.user) !== String(req.user?._id)) {
    throw analyzeRetryConflict("Idempotency key đã được dùng cho conversion run khác");
  }
  if (String(run.inputSha256 || "") !== String(inputSha256)) {
    throw analyzeRetryConflict("Idempotency key không khớp nội dung file");
  }
  if (
    targetTemplateId &&
    String(run.targetTemplateId || "") !== String(targetTemplateId)
  ) {
    throw analyzeRetryConflict("Idempotency key không khớp template");
  }
  const persistedWorkspaceId = run.workspace
    ? String(run.workspace?._id || run.workspace)
    : null;
  if (persistedWorkspaceId !== (scope.workspaceId || null)) {
    throw analyzeRetryConflict("Idempotency key không khớp workspace");
  }
  if (
    run.snapshotSetHash &&
    String(run.snapshotSetHash) !== String(scope.claims.snapshot_set_hash || "")
  ) {
    throw analyzeRetryConflict("Idempotency key không khớp snapshot workspace");
  }
  if (["failed", "cancelled"].includes(String(run.status))) {
    throw analyzeRetryConflict("Conversion run không thể retry analyze");
  }
  const binding = persistedAnalyzeBinding(run);
  if (Object.values(binding).some((value) => !value)) {
    throw analyzeRetryConflict("Conversion run chưa có binding đầy đủ");
  }
  return binding;
}

const ANALYSIS_RAW_ROW_KEYS = new Set([
  "rows",
  "raw_rows",
  "rawRows",
  "source_rows",
  "sourceRows",
  "preview_rows",
  "previewRows",
]);

function stripAnalysisRawRows(value) {
  if (Array.isArray(value)) return value.map(stripAnalysisRawRows);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ANALYSIS_RAW_ROW_KEYS.has(key))
      .map(([key, item]) => [key, stripAnalysisRawRows(item)]),
  );
}

function sanitizedAnalyzePayload(payload) {
  const sanitized = stripAnalysisRawRows(sanitizeUpstreamJson(payload));
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : {};
}

function unavailableAnalyzeArtifact() {
  return httpError(410, "Kết quả analyze không còn khả dụng");
}

function assertStoredAnalyzePayload(payload, binding) {
  const uploadId = cleanText(
    payload?.upload_id || payload?.uploadId || payload?.upload?.id,
    128,
  );
  const targetTemplateId = cleanText(
    payload?.target_template_id || payload?.targetTemplateId,
    128,
  );
  const operationSessionId = cleanText(
    payload?.operation_session_id ||
      payload?.session_id ||
      payload?.session?.session_id ||
      payload?.session?.sessionId,
    128,
  );
  if (
    uploadId !== binding.uploadId ||
    targetTemplateId !== binding.targetTemplateId ||
    operationSessionId !== binding.operationSessionId
  ) {
    throw unavailableAnalyzeArtifact();
  }
}

async function sendAnalyzeRetry(res, scope, run, binding) {
  if (!run.analysisArtifactKey || !run.analysisSha256) {
    throw unavailableAnalyzeArtifact();
  }
  let stored;
  try {
    stored = await conversionArtifacts.getArtifact({
      sessionId: binding.operationSessionId,
      runId: binding.conversionRunId,
      ownerScope: scope.ownerScope,
      uploadId: binding.uploadId,
      targetTemplateId: binding.targetTemplateId,
      kind: "analysis",
      revision: 1,
    });
  } catch (error) {
    if ([404, 410].includes(Number(error?.statusCode))) {
      throw unavailableAnalyzeArtifact();
    }
    throw error;
  }
  if (
    stored.metadata.storageKey !== run.analysisArtifactKey ||
    stored.metadata.sha256 !== run.analysisSha256
  ) {
    throw unavailableAnalyzeArtifact();
  }
  const bytes = stored.content;
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw unavailableAnalyzeArtifact();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailableAnalyzeArtifact();
  }
  assertStoredAnalyzePayload(payload, binding);
  const contextToken = signGatewayContext(scope, {
    ...binding,
    scopes: ["analyze", "preview", "readiness", "confirm", "export"],
  });
  return res.status(200).json({
    ...payload,
    idempotent: true,
    contextToken,
    conversionRunId: String(run._id),
    runId: String(run._id),
  });
}

async function analyzeUpload(req, res) {
  let run = null;
  let scope = null;
  let usageIdempotencyKey = "";
  let targetTemplateId = "";
  let inputSha256 = "";
  try {
    if (!isSupportedExcelFile(req.file)) {
      throw httpError(400, "Chỉ hỗ trợ file .xls hoặc .xlsx");
    }
    targetTemplateId = cleanText(
      req.body?.target_template_id || req.body?.targetTemplateId,
      128,
    );
    scope = await trustedConversionClaims(req);
    usageIdempotencyKey = requestIdempotencyKey(req);
    inputSha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const existingRun = await ConversionRun.findOne({
      usageIdempotencyKey,
    });
    if (existingRun) {
      const binding = assertAnalyzeRetryMatches(existingRun, {
        req,
        inputSha256,
        targetTemplateId,
        scope,
      });
      return await sendAnalyzeRetry(res, scope, existingRun, binding);
    }
    const entitlement = await assertCurrentConversionEntitlement({
      userId: req.user._id,
    });
    const operationSessionId = crypto.randomUUID();
    run = await ConversionRun.create({
      user: req.user._id,
      userNameSnapshot: entitlement.user.name || req.user.name || "",
      userEmailSnapshot: entitlement.user.email || req.user.email || "",
      fileName: path.basename(req.file.originalname).slice(0, 255),
      fileSizeBytes: Number(req.file.size || req.file.buffer.length),
      outputFormat: "MISA",
      status: "processing",
      targetTemplateId,
      conversionContextId: crypto.randomUUID(),
      operationSessionId,
      usageIdempotencyKey,
      inputSha256,
      workspace: scope.workspace?._id || null,
      workspaceNameSnapshot: scope.workspace?.name || "",
      snapshotSetHash: cleanText(scope.claims.snapshot_set_hash, 128),
      startedAt: new Date(),
    });
    const reservedUntil = operationSessionExpiry();
    await conversionSessionStates.reserveSessionState({
      sessionId: operationSessionId,
      runId: cleanText(run._id, 128),
      ownerScope: scope.ownerScope,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      targetTemplateId,
      expiresAt: reservedUntil,
    });
    const initialContextToken = signGatewayContext(scope, {
      targetTemplateId,
      conversionRunId: cleanText(run._id, 128),
      operationSessionId,
      conversionContextId: run.conversionContextId,
      aiMappingOptIn:
        req.body?.use_ai === "true" || req.body?.use_ai === true,
      scopes: ["analyze"],
    });
    const result = await forwardMultipart({
      path: "/api/v1/uploads/analyze",
      file: req.file,
      fields: {
        target_template_id: targetTemplateId,
        conversion_run_id: cleanText(run._id, 128),
        operation_session_id: operationSessionId,
        conversion_context_token: initialContextToken,
        use_ai: req.body?.use_ai === "true" || req.body?.use_ai === true,
      },
      contextToken: initialContextToken,
      requestId: req.requestId,
    });
    if (result.status >= 400) {
      run.status = "failed";
      run.usageState = "not_chargeable";
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
    const returnedOperationSessionId =
      cleanText(
        result.data?.operation_session_id || result.data?.session_id,
        128,
      ) ||
      cleanText(
        result.data?.session?.session_id || result.data?.session?.sessionId,
        128,
      );
    if (!uploadId) throw httpError(502, "Converter không trả về upload id");
    if (returnedOperationSessionId !== operationSessionId) {
      throw httpError(502, "Converter operation session không khớp conversion run");
    }
    if (targetTemplateId && resolvedTemplateId !== targetTemplateId) {
      throw httpError(502, "Converter template không khớp conversion run");
    }
    await conversionSessionStates.bindSessionUpload({
      sessionId: operationSessionId,
      runId: cleanText(run._id, 128),
      ownerScope: scope.ownerScope,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      targetTemplateId: resolvedTemplateId,
      uploadId,
      expiresAt: analyzeSessionExpiry(result.data, reservedUntil),
    });
    run.converterUploadId = uploadId;
    run.targetTemplateId = resolvedTemplateId;
    await run.save();
    const contextToken = signGatewayContext(scope, {
      conversionContextId: run.conversionContextId,
      targetTemplateId: resolvedTemplateId,
      uploadId,
      conversionRunId: cleanText(run._id, 128),
      operationSessionId,
      scopes: ["analyze", "preview", "readiness", "confirm", "export"],
    });
    const responseData = {
      ...sanitizedAnalyzePayload(result.data),
      upload_id: cleanText(
        result.data?.upload_id || result.data?.uploadId || result.data?.upload?.id,
        128,
      ) || uploadId,
      target_template_id: resolvedTemplateId,
      operation_session_id: operationSessionId,
      session: result.data?.session && typeof result.data.session === "object"
        ? { ...result.data.session, session_id: operationSessionId }
        : { session_id: operationSessionId },
      contextToken,
      conversionRunId: String(run._id),
      runId: String(run._id),
    };
    const analysisBytes = Buffer.from(JSON.stringify(responseData), "utf8");
    const analysisSha256 = crypto.createHash("sha256").update(analysisBytes).digest("hex");
    const analysisArtifact = await conversionArtifacts.putArtifact({
      sessionId: operationSessionId,
      runId: String(run._id),
      ownerScope: scope.ownerScope,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      uploadId,
      targetTemplateId: resolvedTemplateId,
      kind: "analysis",
      revision: 1,
      content: analysisBytes,
      contentType: "application/json",
      expiresAt: gatewayArtifactExpiry(),
      sha256: analysisSha256,
    });
    run.analysisArtifactKey = analysisArtifact.storageKey;
    run.analysisSha256 = analysisArtifact.sha256;
    result.data = responseData;
    await run.save();
    return sendGatewayResult(res, result);
  } catch (error) {
    if (error?.code === 11000 && usageIdempotencyKey) {
      const existingRun = await ConversionRun.findOne({
        usageIdempotencyKey,
      }).catch(() => null);
      if (existingRun) {
        try {
          const binding = assertAnalyzeRetryMatches(existingRun, {
            req,
            inputSha256,
            targetTemplateId,
            scope,
          });
          return await sendAnalyzeRetry(res, scope, existingRun, binding);
        } catch (retryError) {
          return sendGatewayError(req, res, retryError);
        }
      }
    }
    if (run && run.status === "processing") {
      run.status = "failed";
      run.usageState = "not_chargeable";
      run.errorMessage = cleanText(error.message, 1000);
      await run.save().catch(() => {});
    }
    return sendGatewayError(req, res, error);
  }
}

async function refreshRunContext(req, res) {
  try {
    const userId = cleanText(req.user?._id, 128);
    if (!userId) throw httpError(401, "Thiếu người dùng đã xác thực");
    const runId = cleanText(req.params?.runId, 128);
    if (!mongoose.isValidObjectId(runId)) {
      throw httpError(404, "Không tìm thấy conversion run");
    }
    const run = await ConversionRun.findOne({ _id: runId, user: req.user._id });
    if (!run) throw httpError(404, "Không tìm thấy conversion run");
    if (["failed", "cancelled"].includes(String(run.status))) {
      throw httpError(409, "Conversion run không thể cấp lại context");
    }

    const workspaceId = run.workspace
      ? String(run.workspace?._id || run.workspace)
      : null;
    const persisted = await loadWorkspaceScope(workspaceId, userId);
    const snapshotSetHash = cleanText(run.snapshotSetHash, 128);
    if (workspaceId && snapshotSetHash !== persisted.snapshotSetHash) {
      throw httpError(409, "Conversion run dùng snapshot workspace đã stale");
    }
    const ownerScope = workspaceId ? `workspace:${workspaceId}` : `user:${userId}`;
    const binding = {
      conversionContextId: cleanText(run.conversionContextId, 128),
      conversionRunId: cleanText(run._id, 128),
      operationSessionId: cleanText(run.operationSessionId, 128),
      uploadId: cleanText(run.converterUploadId, 128),
      targetTemplateId: cleanText(run.targetTemplateId, 128),
    };
    if (Object.values(binding).some((value) => !value)) {
      throw httpError(409, "Conversion run binding chưa hoàn chỉnh");
    }
    const supplied = {
      operationSessionId: cleanText(
        req.body?.operation_session_id || req.body?.operationSessionId ||
          req.body?.session_id || req.body?.sessionId,
        128,
      ),
      uploadId: cleanText(req.body?.upload_id || req.body?.uploadId, 128),
      targetTemplateId: cleanText(
        req.body?.target_template_id || req.body?.targetTemplateId,
        128,
      ),
    };
    if (Object.values(supplied).some((value) => !value)) {
      throw httpError(400, "Thiếu upload, template hoặc operation session binding");
    }
    for (const [field, expected] of Object.entries({
      operationSessionId: binding.operationSessionId,
      uploadId: binding.uploadId,
      targetTemplateId: binding.targetTemplateId,
    })) {
      if (supplied[field] !== expected) {
        throw httpError(409, `${field} không khớp conversion run`);
      }
    }
    await conversionSessionStates.assertSessionBinding({
      sessionId: binding.operationSessionId,
      runId: binding.conversionRunId,
      ownerScope,
      userId,
      workspaceId,
      targetTemplateId: binding.targetTemplateId,
      uploadId: binding.uploadId,
    });
    const scope = {
      claims: {
        owner_scope: ownerScope,
        workspace_id: workspaceId,
        snapshot_set_hash: workspaceId ? snapshotSetHash : null,
        snapshot_ids: persisted.snapshotIds,
        master_data_revision: persisted.masterDataRevision,
      },
      ownerScope,
      userId,
      workspaceId,
    };
    const contextToken = signGatewayContext(scope, {
      ...binding,
      scopes: ["export"],
    });
    return res.status(200).json({
      success: true,
      contextToken,
      conversionRunId: binding.conversionRunId,
      runId: binding.conversionRunId,
      uploadId: binding.uploadId,
      targetTemplateId: binding.targetTemplateId,
      operationSessionId: binding.operationSessionId,
      expiresInSeconds: GATEWAY_CONTEXT_TTL_SECONDS,
    });
  } catch (error) {
    return sendGatewayError(req, res, error);
  }
}

async function previewMapping(req, res) {
  return proxyJson(req, res, {
    path: "/api/v1/mappings/preview",
    requiredScope: "preview",
  });
}

async function readinessMapping(req, res) {
  return proxyJson(req, res, {
    path: "/api/v1/mappings/readiness",
    requiredScope: "readiness",
  });
}

async function confirmMapping(req, res) {
  return proxyJson(req, res, {
    path: "/api/v1/mappings/confirm",
    requiredScope: "confirm",
  });
}

async function mutateSession(req, res) {
  return proxyJson(req, res, {
    path: "/api/v1/mappings/session",
    requiredScope: "confirm",
  });
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
    requiredScope: "preview",
  });
}

async function exportConversion(req, res) {
  let persistedArtifact = null;
  let persistedProof = null;
  try {
    const body = sanitizeGatewayBody(req.body, { stripRows: true });
    const scope = await trustedConversionClaims(req, { requireRun: true });
    const binding = await bindingForRequest(req, body, scope, {
      requirePersistedBinding: true,
    });
    const idempotencyKey = suppliedIdempotencyKey(req);
    try {
      assertConversionContextBinding(scope.claims, {
        conversionContextId: binding.conversionContextId,
        conversionRunId: binding.conversionRunId,
        operationSessionId: binding.operationSessionId,
        uploadId: binding.uploadId,
        targetTemplateId: binding.targetTemplateId,
        userId: scope.userId,
        ownerScope: scope.ownerScope,
        requiredScope: "export",
      });
    } catch (error) {
      throw httpError(409, error.message);
    }
    if (
      binding.run.usageIdempotencyKey &&
      idempotencyKey &&
      binding.run.usageIdempotencyKey !== idempotencyKey
    ) {
      throw httpError(409, "Idempotency key không khớp conversion run");
    }

    if (binding.run.status === "completed" || binding.run.usageState === "charged") {
      if (
        binding.run.status !== "completed" ||
        binding.run.usageState !== "charged" ||
        !binding.run.exportArtifactKey ||
        !binding.run.outputSha256
      ) {
        throw httpError(409, "Conversion run có trạng thái artifact không hợp lệ");
      }
      persistedProof = {
        runId: binding.conversionRunId,
        artifactKey: binding.run.exportArtifactKey,
        outputSha256: binding.run.outputSha256,
      };
      let stored;
      try {
        stored = await conversionArtifacts.getArtifact({
          sessionId: binding.operationSessionId,
          runId: binding.conversionRunId,
          ownerScope: scope.ownerScope,
          uploadId: binding.uploadId,
          targetTemplateId: binding.targetTemplateId,
          kind: "output",
          revision: 1,
        });
      } catch (error) {
        if ([404, 410].includes(Number(error?.statusCode))) {
          throw httpError(410, "Artifact conversion không còn khả dụng");
        }
        throw error;
      }
      if (
        stored.metadata.storageKey !== persistedProof.artifactKey ||
        stored.metadata.sha256 !== persistedProof.outputSha256
      ) {
        throw httpError(410, "Artifact conversion không còn khả dụng");
      }
      persistedArtifact = stored.content;
      res.setHeader("Content-Type", "application/vnd.ms-excel");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="Import MISA.xls"',
      );
      res.setHeader("X-Export-Artifact-Key", binding.run.exportArtifactKey);
      res.setHeader("X-Input-SHA256", binding.run.inputSha256 || "");
      res.setHeader("X-Output-SHA256", binding.run.outputSha256 || "");
      return res.status(200).send(persistedArtifact);
    }
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
    if (!Buffer.isBuffer(result.data)) return sendGatewayResult(res, result);
    if (result.data.length === 0) {
      throw httpError(502, "Converter trả về artifact rỗng");
    }
    const outputSha256 = crypto.createHash("sha256").update(result.data).digest("hex");
    if (binding.run.outputSha256 && binding.run.outputSha256 !== outputSha256) {
      throw httpError(409, "Artifact export không khớp conversion run");
    }
    const storedArtifact = await conversionArtifacts.putArtifact({
      sessionId: binding.operationSessionId,
      runId: binding.conversionRunId,
      ownerScope: scope.ownerScope,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      uploadId: binding.uploadId,
      targetTemplateId: binding.targetTemplateId,
      kind: "output",
      revision: 1,
      content: result.data,
      contentType: "application/vnd.ms-excel",
      expiresAt: gatewayArtifactExpiry(),
      sha256: outputSha256,
    });
    const artifactKey = storedArtifact.storageKey;
    persistedProof = {
      runId: binding.conversionRunId,
      artifactKey,
      outputSha256,
    };
    const charge = await chargeCompletedConversion({
      runId: binding.conversionRunId,
      userId: scope.userId,
      idempotencyKey:
        binding.run.usageIdempotencyKey || idempotencyKey || binding.conversionRunId,
      artifactKey,
      outputSha256,
    });
    if (!charge?.run && !charge?.idempotent) {
      throw httpError(409, "Conversion usage result không hợp lệ");
    }
    res.setHeader("X-Export-Artifact-Key", charge.exportArtifactKey || artifactKey);
    res.setHeader("X-Input-SHA256", charge.inputSha256 || binding.run.inputSha256 || "");
    res.setHeader("X-Output-SHA256", charge.outputSha256 || outputSha256);
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
  refreshRunContext,
  sanitizeGatewayBody,
  sendGatewayResult,
  signGatewayContext,
};
