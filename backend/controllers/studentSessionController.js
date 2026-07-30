const crypto = require("crypto");
const mongoose = require("mongoose");
const StudentFileSession = require("../models/StudentFileSession");
const StudentQuestionEvent = require("../models/StudentQuestionEvent");
const StudentActivity = require("../models/StudentActivity");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const { userCanAccessWorkspace } = require("../services/masterDataService");
const {
  createConversionContextToken,
  createStudentContextToken,
  verifyStudentContextToken,
} = require("../services/conversionContextService");
const { forwardJson } = require("../services/converterGatewayService");
const {
  buildOwnerScope,
  hashStudentQuestion,
  normalizeStudentQuestion,
} = require("../services/studentSessionService");

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const UNSAFE_METADATA_KEYS = new Set([
  "rawrows",
  "rows",
  "workbook",
  "workbookbytes",
  "rawbytes",
  "bytes",
]);
const STUDENT_TEMPLATE_IDS = new Set([
  "bsn_sales",
  "bsn_purchase",
  "misa_purchase_domestic",
  "sales_goods",
  "sales_service",
  "purchase_goods",
  "purchase_service",
]);
const SAFE_MAPPING_COUNT_KEYS = ["mapped", "default", "formula", "unresolved", "mixed"];
const SAFE_ISSUE_COUNT_KEYS = ["blocker", "warning", "info"];
const STUDENT_ANSWER_TYPES = new Set([
  "deterministic_file_query",
  "deterministic_explanation",
  "unsupported",
]);
const STUDENT_QUESTION_OUTCOMES = new Set([
  "supported",
  "unsupported",
  "ai_unavailable",
]);
const STUDENT_QUESTION_CATEGORIES = new Set([
  "file_summary",
  "locate_column",
  "locate_rows",
  "explain_mapping",
  "explain_issue",
  "aggregate_amount",
  "count_documents",
  "find_duplicates",
  "find_vat_mismatches",
  "required_actions_before_export",
  "concept_explanation",
  "unsupported_legal_or_business_judgment",
]);
const STUDENT_ACTIVITY_CONFIG = {
  accounting_map_reviewed: {
    scope: "accounting_map",
    skill: "accounting_mapping",
    summaryVi: "Đã rà soát sơ đồ hạch toán có bằng chứng.",
  },
  reconciliation_completed: {
    scope: "reconcile",
    skill: "vat_reconciliation",
    summaryVi: "Đã hoàn thành đối chiếu deterministic có bằng chứng.",
  },
  anonymized_export_created: {
    scope: "export",
    skill: "data_privacy",
    summaryVi: "Đã tạo bản sao workbook ẩn danh sau khi scanner đạt yêu cầu.",
  },
};
const UNSAFE_ACTIVITY_KEYS = new Set([
  "rows",
  "rawrows",
  "rawvalues",
  "values",
  "workbook",
  "workbookbytes",
  "bytes",
]);

function cleanFileName(value) {
  return String(value || "")
    .replace(/[\\/]/g, "")
    .trim()
    .slice(0, 255);
}

function cleanExtension(value) {
  const extension = String(value || "").trim().toLowerCase().replace(/^\.+/, "");
  return extension ? `.${extension.slice(0, 15)}` : "";
}

function cleanString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function studentContextScopesFromFlags(env = process.env) {
  const enabled = (name) => String(env[name] || "false").toLowerCase() === "true";
  if (!enabled("STUDENT_ASSISTANT_ENABLED")) return [];

  const scopes = [];
  if (enabled("STUDENT_FILE_EXPLAIN_ENABLED")) scopes.push("analyze", "explain");
  if (enabled("STUDENT_FILE_QA_ENABLED")) scopes.push("ask");
  if (enabled("STUDENT_ACCOUNTING_MAP_ENABLED")) scopes.push("accounting_map");
  if (enabled("STUDENT_RECONCILIATION_ENABLED")) scopes.push("reconcile");
  if (enabled("STUDENT_INTERNSHIP_ENABLED")) scopes.push("export");
  return scopes;
}

function cleanStudentSessionPayload(body = {}) {
  const file = body.file || {};
  const payload = {
    file: {
      originalName: cleanFileName(file.originalName),
      sizeBytes: Number(file.sizeBytes),
      extension: cleanExtension(file.extension),
      contentHash: cleanString(file.contentHash, 256),
      rawRetained: false,
    },
    converterUploadId: cleanString(body.converterUploadId, 128),
    targetTemplateId: cleanString(body.targetTemplateId, 128),
    sourceSignatureHash: cleanString(body.sourceSignatureHash, 256),
  };
  const workspaceId = cleanString(body.workspaceId, 64);
  if (workspaceId) payload.workspaceId = workspaceId;
  return payload;
}

function sanitizeSummary(value) {
  if (value == null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) {
    return value.map(sanitizeSummary).filter((item) => item !== undefined);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSAFE_METADATA_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitizeSummary(item)])
      .filter(([, item]) => item !== undefined),
  );
}

function cleanNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function cleanCountMap(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cleaned = {};
  for (const key of allowedKeys) {
    const count = cleanNonNegativeNumber(value[key]);
    if (count !== undefined) cleaned[key] = count;
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function cleanAnalysisSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const summary = {};
  for (const key of [
    "dataRowCount",
    "documentCount",
    "recognizedColumns",
    "unresolvedColumns",
    "explanationCount",
  ]) {
    const cleaned = cleanNonNegativeNumber(value[key]);
    if (cleaned !== undefined) summary[key] = cleaned;
  }
  const mappingCounts = cleanCountMap(value.mappingCounts, SAFE_MAPPING_COUNT_KEYS);
  if (mappingCounts) summary.mappingCounts = mappingCounts;
  const issueCounts = cleanCountMap(value.issueCounts, SAFE_ISSUE_COUNT_KEYS);
  if (issueCounts) summary.issueCounts = issueCounts;
  const masterDataStatus = cleanString(value.masterDataStatus, 64);
  if (masterDataStatus) summary.masterDataStatus = masterDataStatus;
  const stateHash = cleanString(value.stateHash, 256);
  if (stateHash) summary.stateHash = stateHash;
  const readinessStatus = cleanString(value.readinessStatus, 64);
  if (readinessStatus) summary.readinessStatus = readinessStatus;
  return summary;
}

function cleanAnalysisCompletedPayload(body = {}) {
  const targetTemplateId = cleanString(body.targetTemplateId, 128);
  return {
    event: cleanString(body.event, 64),
    converterUploadId: cleanString(body.converterUploadId, 128),
    targetTemplateId: STUDENT_TEMPLATE_IDS.has(targetTemplateId) ? targetTemplateId : "",
    sourceSignatureHash: cleanString(body.sourceSignatureHash, 256),
    summary: cleanAnalysisSummary(body.summary),
    status: "analyzed",
  };
}

function cleanQuestionEventPayload(body = {}) {
  const legacyQuestion = normalizeStudentQuestion(body.question);
  const suppliedHash = cleanString(body.questionHash, 64).toLowerCase();
  const questionHash = /^[a-f0-9]{64}$/.test(suppliedHash)
    ? suppliedHash
    : legacyQuestion
      ? hashStudentQuestion(legacyQuestion)
      : "";
  const suppliedLength = cleanNonNegativeNumber(body.questionLength);
  const questionLength = legacyQuestion
    ? [...legacyQuestion].length
    : Math.min(2000, Math.floor(suppliedLength || 0));
  const category = cleanString(body.category, 64);
  const answerType = cleanString(body.answerType, 64);
  const outcome = cleanString(body.outcome, 64);
  const evidenceIds = Array.isArray(body.evidenceIds)
    ? body.evidenceIds
        .map((value) => cleanString(value, 128))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const evidenceCount = cleanNonNegativeNumber(body.evidenceCount);
  return {
    event: cleanString(body.event, 64),
    questionHash,
    questionLength,
    category: STUDENT_QUESTION_CATEGORIES.has(category) ? category : "",
    operation: body.operation === "ask" ? "ask" : "",
    answerType: STUDENT_ANSWER_TYPES.has(answerType) ? answerType : "",
    evidenceIds,
    evidenceCount: evidenceCount === undefined ? 0 : evidenceCount,
    outcome: STUDENT_QUESTION_OUTCOMES.has(outcome) ? outcome : "",
  };
}









function activityPayloadHasRawValues(value) {
  if (!value || typeof value !== "object") return false;
  if (Buffer.isBuffer(value)) return true;
  if (Array.isArray(value)) return value.some(activityPayloadHasRawValues);
  return Object.entries(value).some(
    ([key, item]) =>
      UNSAFE_ACTIVITY_KEYS.has(key.toLowerCase()) || activityPayloadHasRawValues(item),
  );
}

function cleanStudentActivityPayload(body = {}) {
  if (body.containsRawValues === true || activityPayloadHasRawValues(body)) return null;
  const eventType = cleanString(body.eventType, 64);
  const config = STUDENT_ACTIVITY_CONFIG[eventType];
  if (!config) return null;
  const evidenceCount = cleanNonNegativeNumber(body.evidenceCount);
  return {
    eventType,
    skill: config.skill,
    summaryVi: config.summaryVi,
    evidenceCount: evidenceCount === undefined ? 0 : evidenceCount,
    containsRawValues: false,
  };
}

function secureTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function serializeStudentSession(session) {
  return {
    id: String(session._id || session.id),
    workspaceId: session.workspaceId == null ? null : String(session.workspaceId),
    ownerScope: session.ownerScope,
    mode: session.mode,
    status: session.status,
    file: {
      originalName: session.file?.originalName || "",
      sizeBytes: Number(session.file?.sizeBytes || 0),
      extension: session.file?.extension || "",
      contentHash: session.file?.contentHash || "",
      rawRetained: false,
    },
    converterUploadId: session.converterUploadId || "",
    targetTemplateId: session.targetTemplateId || "",
    sourceSignatureHash: session.sourceSignatureHash || "",
    summary: sanitizeSummary(session.summary || {}),
    retentionExpiresAt: session.retentionExpiresAt || null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
  };
}



function serializeStudentActivity(activity) {
  return {
    id: String(activity._id || activity.id || ""),
    eventType: activity.eventType,
    skill: activity.skill,
    summaryVi: activity.summaryVi,
    evidenceCount: Number(activity.evidenceCount || 0),
    containsRawValues: false,
    createdAt: activity.createdAt || null,
  };
}



function sessionIsOwnedByUser(session, userId) {
  if (String(session.userId || "") !== String(userId || "")) return false;
  return session.ownerScope === buildOwnerScope({
    userId,
    workspaceId: session.workspaceId,
  });
}

function sessionIsExpired(session, now = new Date()) {
  if (["deleting", "expired", "deleted"].includes(session.status)) return true;
  const retentionExpiresAt = new Date(session.retentionExpiresAt).getTime();
  return !Number.isFinite(retentionExpiresAt) || retentionExpiresAt <= now.getTime();
}

function studentContextMatchesSession(claims, session) {
  return (
    String(claims.session_id || "") === String(session._id || session.id || "") &&
    String(claims.user_id || "") === String(session.userId || "") &&
    String(claims.owner_scope || "") === String(session.ownerScope || "") &&
    String(claims.workspace_id || "") === String(session.workspaceId || "")
  );
}

function verifySessionContext(req, session, res, requiredScope = "analyze") {
  const token = req.headers["x-student-context"];
  if (!token) {
    res.status(401).json({ success: false, message: "Thiếu student context" });
    return false;
  }
  try {
    const claims = verifyStudentContextToken(token, requiredScope);
    if (!studentContextMatchesSession(claims, session)) {
      res.status(403).json({ success: false, message: "Student context không thuộc phiên này" });
      return false;
    }
    return true;
  } catch (error) {
    res.status(401).json({ success: false, message: error.message });
    return false;
  }
}

async function findWorkspaceForUser(workspaceId, userId) {
  if (!mongoose.isValidObjectId(workspaceId)) return null;
  const workspace = await AccountingWorkspace.findOne({ _id: workspaceId, isActive: true });
  return workspace && userCanAccessWorkspace(workspace, userId) ? workspace : null;
}

async function findAccessibleSession(sessionId, userId) {
  if (!mongoose.isValidObjectId(sessionId)) return null;
  const session = await StudentFileSession.findOne({ _id: sessionId, userId });
  if (!session || !sessionIsOwnedByUser(session, userId)) return null;
  if (session.workspaceId && !(await findWorkspaceForUser(session.workspaceId, userId))) {
    return null;
  }
  return session;
}

function createContextToken(session) {
  return createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    workspaceId: session.workspaceId,
    allowedScopes: studentContextScopesFromFlags(),
    retentionExpiresAt: session.retentionExpiresAt,
  });
}

function studentPurgeFailure(cause) {
  const error = new Error("Student converter purge chưa hoàn tất");
  error.code = String(cause?.code || "STUDENT_PURGE_UNAVAILABLE").slice(0, 80);
  error.statusCode = 503;
  error.studentPurgeFailure = true;
  return error;
}

function assertStudentPurgeCompleted(result, session) {
  if (
    result?.success !== true ||
    String(result?.session_id || "") !== String(session._id) ||
    String(result?.upload_id || "") !== String(session.converterUploadId || "") ||
    result?.raw_upload_deleted !== true ||
    result?.operation_session_deleted !== true
  ) {
    const error = new Error("Converter purge response không đầy đủ");
    error.code = "STUDENT_PURGE_INCOMPLETE";
    throw error;
  }
  return result;
}

async function purgeStudentOperationSession(req, session, forward = forwardJson) {
  if (!session.converterUploadId) {
    return {
      success: true,
      session_id: String(session._id),
      upload_id: "",
      raw_upload_deleted: true,
      operation_session_deleted: true,
    };
  }
  const contextToken = createConversionContextToken({
    userId: session.userId,
    workspaceId: session.workspaceId || null,
    ownerScope: session.ownerScope,
    conversionRunId: `student:${session._id}`,
    operationSessionId: session._id,
    uploadId: session.converterUploadId,
    targetTemplateId: session.targetTemplateId || "student_session",
    scopes: ["analyze"],
    expiresIn: "2m",
  });
  const response = await forward({
    path: `/api/v1/student/sessions/${encodeURIComponent(String(session._id))}/purge`,
    method: "DELETE",
    body: {},
    contextToken,
    requestId: req.requestId || crypto.randomUUID(),
    extraHeaders: {
      "x-student-context": String(req.headers?.["x-student-context"] || ""),
    },
  });
  if (response?.status !== 200) {
    const error = new Error("Converter purge bị từ chối");
    error.code = "STUDENT_PURGE_REJECTED";
    throw error;
  }
  return response.data;
}

async function createStudentSession(req, res) {
  try {
    const payload = cleanStudentSessionPayload(req.body);
    if (!payload.file.originalName) {
      return res.status(400).json({ success: false, message: "Tên file là bắt buộc" });
    }
    if (!Number.isFinite(payload.file.sizeBytes) || payload.file.sizeBytes < 0) {
      return res.status(400).json({ success: false, message: "Kích thước file không hợp lệ" });
    }

    const workspace = payload.workspaceId
      ? await findWorkspaceForUser(payload.workspaceId, req.user._id)
      : null;
    if (payload.workspaceId && !workspace) {
      return res.status(403).json({
        success: false,
        message: "Không có quyền sử dụng hồ sơ doanh nghiệp này",
      });
    }

    const session = await StudentFileSession.create({
      ...payload,
      userId: req.user._id,
      workspaceId: workspace?._id || null,
      ownerScope: buildOwnerScope({ userId: req.user._id, workspaceId: workspace?._id }),
      retentionExpiresAt: new Date(Date.now() + DEFAULT_RETENTION_MS),
    });
    return res.status(201).json({
      success: true,
      session: serializeStudentSession(session),
      contextToken: createContextToken(session),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Không thể tạo phiên hỗ trợ", error: error.message });
  }
}

async function getStudentSession(req, res) {
  try {
    const session = await findAccessibleSession(req.params.id, req.user._id);
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }
    if (sessionIsExpired(session)) {
      return res.status(410).json({ success: false, message: "Phiên hỗ trợ đã hết hạn" });
    }
    if (!verifySessionContext(req, session, res)) return undefined;
    return res.json({ success: true, session: serializeStudentSession(session) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Không thể tải phiên hỗ trợ", error: error.message });
  }
}

async function deleteStudentSession(
  req,
  res,
  { purgeOperationSession = purgeStudentOperationSession } = {},
) {
  try {
    const session = await findAccessibleSession(req.params.id, req.user._id);
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }
    if (!verifySessionContext(req, session, res)) return undefined;
    let deletingSession = session;
    if (session.status !== "deleting") {
      deletingSession = await StudentFileSession.findOneAndUpdate(
        {
          _id: session._id,
          userId: session.userId,
          ownerScope: session.ownerScope,
          workspaceId: session.workspaceId || null,
          status: { $nin: ["deleting", "expired", "deleted"] },
        },
        { $set: { status: "deleting" } },
        { new: true },
      );
      if (!deletingSession) {
        return res.status(409).json({
          success: false,
          message: "Phiên hỗ trợ đang được xoá",
        });
      }
    }
    const metadataFilter = {
      sessionId: deletingSession._id,
      userId: deletingSession.userId,
      ownerScope: deletingSession.ownerScope,
      workspaceId: deletingSession.workspaceId || null,
    };
    try {
      const purgeResult = await purgeOperationSession(req, deletingSession);
      assertStudentPurgeCompleted(purgeResult, deletingSession);
    } catch (error) {
      throw studentPurgeFailure(error);
    }
    await StudentQuestionEvent.deleteMany(metadataFilter);
    await StudentActivity.deleteMany(metadataFilter);
    await deletingSession.deleteOne();
    return res.json({ success: true });
  } catch (error) {
    if (error?.studentPurgeFailure) {
      return res.status(503).json({
        success: false,
        message: "Không thể xác nhận đã purge dữ liệu Student tại converter",
        purge: { completed: false, code: error.code },
      });
    }
    return res.status(500).json({ success: false, message: "Không thể xoá phiên hỗ trợ", error: error.message });
  }
}

async function refreshStudentContext(req, res) {
  try {
    const session = await findAccessibleSession(req.params.id, req.user._id);
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }
    if (sessionIsExpired(session)) {
      return res.status(410).json({ success: false, message: "Phiên hỗ trợ đã hết hạn" });
    }
    return res.json({
      success: true,
      session: serializeStudentSession(session),
      contextToken: createContextToken(session),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Không thể làm mới context", error: error.message });
  }
}



async function getStudentActivities(req, res) {
  try {
    const session = await findAccessibleSession(req.params.id, req.user._id);
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }
    if (sessionIsExpired(session)) {
      return res.status(410).json({ success: false, message: "Phiên hỗ trợ đã hết hạn" });
    }
    if (!verifySessionContext(req, session, res, "export")) return undefined;
    const activities = await StudentActivity.find({
      sessionId: session._id,
      userId: session.userId,
      ownerScope: session.ownerScope,
      workspaceId: session.workspaceId || null,
    })
      .sort({ createdAt: -1 })
      .limit(200);
    return res.json({ success: true, activities: activities.map(serializeStudentActivity) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể tải lịch sử hoạt động",
      error: error.message,
    });
  }
}

async function deleteStudentActivities(req, res) {
  try {
    const session = await findAccessibleSession(req.params.id, req.user._id);
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }
    if (!verifySessionContext(req, session, res, "export")) return undefined;
    const result = await StudentActivity.deleteMany({
      sessionId: session._id,
      userId: session.userId,
      ownerScope: session.ownerScope,
      workspaceId: session.workspaceId || null,
    });
    return res.json({ success: true, deletedCount: Number(result.deletedCount || 0) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể xoá lịch sử hoạt động",
      error: error.message,
    });
  }
}



function verifyInternalStudentRequest(req, res, requiredScope) {
  const expectedServiceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
  if (!expectedServiceToken) {
    res.status(503).json({ success: false, message: "CONVERTER_SERVICE_TOKEN chưa được cấu hình" });
    return null;
  }
  if (!secureTokenEquals(req.headers["x-converter-service-token"], expectedServiceToken)) {
    res.status(401).json({ success: false, message: "Service token không hợp lệ" });
    return null;
  }
  const contextToken = req.headers["x-student-context"];
  if (!contextToken) {
    res.status(401).json({ success: false, message: "Thiếu student context" });
    return null;
  }
  let claims;
  try {
    claims = verifyStudentContextToken(contextToken, requiredScope);
  } catch (error) {
    res.status(401).json({ success: false, message: error.message });
    return null;
  }
  if (String(req.params.id || "") !== String(claims.session_id || "")) {
    res.status(403).json({ success: false, message: "Student context không thuộc phiên này" });
    return null;
  }
  if (!mongoose.isValidObjectId(claims.session_id)) {
    res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    return null;
  }
  return claims;
}

async function findActiveInternalSession(claims) {
  return StudentFileSession.findOne({
    _id: claims.session_id,
    userId: claims.user_id,
    ownerScope: claims.owner_scope,
    workspaceId: claims.workspace_id || null,
    retentionExpiresAt: { $gt: new Date() },
    status: { $nin: ["expired", "deleted", "deleting"] },
    converterUploadId: { $nin: ["", null] },
  });
}

async function discardMetadataWriteIfSessionClosed(claims, model, record) {
  if (await findActiveInternalSession(claims)) return false;
  await model.deleteOne({
    _id: record._id,
    sessionId: claims.session_id,
  });
  return true;
}

async function recordStudentActivity(req, res) {
  try {
    const payload = cleanStudentActivityPayload(req.body);
    if (!payload) {
      return res.status(400).json({ success: false, message: "Student activity không hợp lệ" });
    }
    const requiredScope = STUDENT_ACTIVITY_CONFIG[payload.eventType].scope;
    const claims = verifyInternalStudentRequest(req, res, requiredScope);
    if (!claims) return undefined;
    const session = await findActiveInternalSession(claims);
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ đang hoạt động" });
    }
    const activity = await StudentActivity.create({
      sessionId: session._id,
      userId: session.userId,
      workspaceId: session.workspaceId || null,
      ownerScope: session.ownerScope,
      retentionExpiresAt: session.retentionExpiresAt,
      ...payload,
    });
    if (
      await discardMetadataWriteIfSessionClosed(
        claims,
        StudentActivity,
        activity,
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Phiên hỗ trợ đã đóng trong khi ghi nhận activity",
      });
    }
    return res.status(201).json({ success: true, activity: serializeStudentActivity(activity) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể ghi nhận student activity",
      error: error.message,
    });
  }
}

async function getInternalStudentActivities(req, res) {
  try {
    const claims = verifyInternalStudentRequest(req, res, "export");
    if (!claims) return undefined;
    const session = await findActiveInternalSession(claims);
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ đang hoạt động" });
    }
    const activities = await StudentActivity.find({
      sessionId: session._id,
      userId: session.userId,
      ownerScope: session.ownerScope,
      workspaceId: session.workspaceId || null,
    })
      .sort({ createdAt: 1 })
      .limit(200);
    return res.json({
      success: true,
      activities: activities.map((activity) => ({
        id: String(activity._id || activity.id || ""),
        event_type: activity.eventType,
        skill: activity.skill,
        summary: activity.summaryVi,
        evidence_count: Number(activity.evidenceCount || 0),
        resolved_issues: [],
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể tải student activity nội bộ",
      error: error.message,
    });
  }
}





async function recordStudentAnalysisCompleted(req, res) {
  try {
    const expectedServiceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
    if (!expectedServiceToken) {
      return res.status(503).json({
        success: false,
        message: "CONVERTER_SERVICE_TOKEN chưa được cấu hình",
      });
    }
    if (
      !secureTokenEquals(
        req.headers["x-converter-service-token"],
        expectedServiceToken,
      )
    ) {
      return res.status(401).json({ success: false, message: "Service token không hợp lệ" });
    }

    const contextToken = req.headers["x-student-context"];
    if (!contextToken) {
      return res.status(401).json({ success: false, message: "Thiếu student context" });
    }
    let claims;
    try {
      claims = verifyStudentContextToken(contextToken, "analyze");
    } catch (error) {
      return res.status(401).json({ success: false, message: error.message });
    }
    if (String(req.params.id || "") !== String(claims.session_id || "")) {
      return res.status(403).json({
        success: false,
        message: "Student context không thuộc phiên này",
      });
    }

    const payload = cleanAnalysisCompletedPayload(req.body);
    if (payload.event !== "analysis_completed") {
      return res.status(400).json({ success: false, message: "Student event không hợp lệ" });
    }
    if (
      !payload.converterUploadId ||
      !payload.targetTemplateId ||
      !payload.sourceSignatureHash
    ) {
      return res.status(400).json({
        success: false,
        message: "Metadata phân tích chưa đầy đủ",
      });
    }
    if (!mongoose.isValidObjectId(claims.session_id)) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }

    const sessionFilter = {
      _id: claims.session_id,
      userId: claims.user_id,
      ownerScope: claims.owner_scope,
      workspaceId: claims.workspace_id || null,
      retentionExpiresAt: { $gt: new Date() },
      status: { $nin: ["expired", "deleted", "deleting"] },
      $or: [
        { converterUploadId: "" },
        { converterUploadId: payload.converterUploadId },
        { converterUploadId: { $exists: false } },
        { converterUploadId: null },
      ],
    };
    const session = await StudentFileSession.findOneAndUpdate(
      sessionFilter,
      {
        $set: {
          converterUploadId: payload.converterUploadId,
          targetTemplateId: payload.targetTemplateId,
          sourceSignatureHash: payload.sourceSignatureHash,
          summary: payload.summary,
          status: "analyzed",
        },
      },
      { new: true, runValidators: true },
    );
    if (session) {
      return res.json({ success: true, session: serializeStudentSession(session) });
    }

    const existingSession = await StudentFileSession.findOne({
      _id: claims.session_id,
      userId: claims.user_id,
    });
    if (!existingSession || !studentContextMatchesSession(claims, existingSession)) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }
    if (sessionIsExpired(existingSession)) {
      return res.status(410).json({ success: false, message: "Phiên hỗ trợ đã hết hạn" });
    }
    if (
      existingSession.converterUploadId &&
      existingSession.converterUploadId !== payload.converterUploadId
    ) {
      return res.status(409).json({
        success: false,
        message: "Phiên hỗ trợ đã liên kết với upload khác",
      });
    }
    return res.status(409).json({
      success: false,
      message: "Phiên hỗ trợ đang được cập nhật",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật kết quả phân tích",
      error: error.message,
    });
  }
}

async function recordStudentQuestionEvent(req, res) {
  try {
    const expectedServiceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
    if (!expectedServiceToken) {
      return res.status(503).json({
        success: false,
        message: "CONVERTER_SERVICE_TOKEN chưa được cấu hình",
      });
    }
    if (
      !secureTokenEquals(
        req.headers["x-converter-service-token"],
        expectedServiceToken,
      )
    ) {
      return res.status(401).json({ success: false, message: "Service token không hợp lệ" });
    }

    const contextToken = req.headers["x-student-context"];
    if (!contextToken) {
      return res.status(401).json({ success: false, message: "Thiếu student context" });
    }
    let claims;
    try {
      claims = verifyStudentContextToken(contextToken, "ask");
    } catch (error) {
      return res.status(401).json({ success: false, message: error.message });
    }
    if (String(req.params.id || "") !== String(claims.session_id || "")) {
      return res.status(403).json({
        success: false,
        message: "Student context không thuộc phiên này",
      });
    }
    if (!mongoose.isValidObjectId(claims.session_id)) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ" });
    }

    const payload = cleanQuestionEventPayload(req.body);
    if (
      payload.event !== "question_answered" ||
      !payload.questionHash ||
      !payload.questionLength ||
      !payload.category ||
      !payload.operation ||
      !payload.answerType ||
      !payload.outcome ||
      payload.evidenceCount < payload.evidenceIds.length
    ) {
      return res.status(400).json({
        success: false,
        message: "Student question event không hợp lệ",
      });
    }

    const session = await StudentFileSession.findOne({
      _id: claims.session_id,
      userId: claims.user_id,
      ownerScope: claims.owner_scope,
      workspaceId: claims.workspace_id || null,
      retentionExpiresAt: { $gt: new Date() },
      status: { $nin: ["expired", "deleted", "deleting"] },
      converterUploadId: { $nin: ["", null] },
    });
    if (!session) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phiên hỗ trợ đang hoạt động" });
    }

    const event = await StudentQuestionEvent.create({
      sessionId: session._id,
      userId: session.userId,
      workspaceId: session.workspaceId || null,
      ownerScope: session.ownerScope,
      questionHash: payload.questionHash,
      questionLength: payload.questionLength,
      category: payload.category,
      operation: payload.operation,
      answerType: payload.answerType,
      evidenceIds: payload.evidenceIds,
      evidenceCount: payload.evidenceCount,
      outcome: payload.outcome,
      retentionExpiresAt: session.retentionExpiresAt,
    });
    if (
      await discardMetadataWriteIfSessionClosed(
        claims,
        StudentQuestionEvent,
        event,
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Phiên hỗ trợ đã đóng trong khi ghi nhận câu hỏi",
      });
    }
    return res.status(202).json({
      success: true,
      event: {
        id: String(event._id),
        answerType: event.answerType,
        evidenceCount: event.evidenceCount,
        outcome: event.outcome,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể ghi nhận câu hỏi student",
      error: error.message,
    });
  }
}

async function checkStudentSessionActive(req, res) {
  try {
    const expectedServiceToken = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
    if (!expectedServiceToken) {
      return res.status(503).json({
        success: false,
        message: "CONVERTER_SERVICE_TOKEN chưa được cấu hình",
      });
    }
    if (
      !secureTokenEquals(
        req.headers["x-converter-service-token"],
        expectedServiceToken,
      )
    ) {
      return res.status(401).json({ success: false, message: "Service token không hợp lệ" });
    }

    const contextToken = req.headers["x-student-context"];
    if (!contextToken) {
      return res.status(401).json({ success: false, message: "Thiếu student context" });
    }
    let claims;
    try {
      const requestedScope = cleanString(req.query?.scope, 64) || "ask";
      if (!["ask", "accounting_map", "reconcile", "export"].includes(requestedScope)) {
        return res.status(400).json({ success: false, message: "Student scope không hợp lệ" });
      }
      claims = verifyStudentContextToken(contextToken, requestedScope);
    } catch (error) {
      return res.status(401).json({ success: false, message: error.message });
    }
    if (String(req.params.id || "") !== String(claims.session_id || "")) {
      return res.status(403).json({
        success: false,
        message: "Student context không thuộc phiên này",
      });
    }
    if (!mongoose.isValidObjectId(claims.session_id)) {
      return res.status(410).json({ success: false, message: "Phiên hỗ trợ không còn hoạt động" });
    }

    const session = await StudentFileSession.findById(claims.session_id);
    if (!session) {
      return res.status(410).json({ success: false, message: "Phiên hỗ trợ không còn hoạt động" });
    }
    if (!studentContextMatchesSession(claims, session)) {
      return res.status(403).json({
        success: false,
        message: "Student context không khớp owner hoặc workspace của phiên",
      });
    }
    if (sessionIsExpired(session)) {
      return res.status(410).json({ success: false, message: "Phiên hỗ trợ đã hết hạn" });
    }
    const uploadId = cleanString(req.query?.uploadId, 128);
    if (
      !uploadId ||
      !session.converterUploadId ||
      String(session.converterUploadId) !== uploadId
    ) {
      return res.status(409).json({
        success: false,
        message: "Phiên hỗ trợ chưa liên kết đúng converter upload",
      });
    }
    return res.json({
      success: true,
      active: true,
      sessionId: String(session._id),
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: "Không thể kiểm tra trạng thái phiên hỗ trợ",
      error: error.message,
    });
  }
}

module.exports = {
  checkStudentSessionActive,
  cleanAnalysisCompletedPayload,
  cleanQuestionEventPayload,
  cleanStudentActivityPayload,
  cleanStudentSessionPayload,
  createContextToken,
  createStudentSession,
  deleteStudentSession,
  deleteStudentActivities,
  getInternalStudentActivities,
  getStudentActivities,
  getStudentSession,
  purgeStudentOperationSession,
  recordStudentAnalysisCompleted,
  recordStudentActivity,
  recordStudentQuestionEvent,
  refreshStudentContext,
  serializeStudentSession,
  sessionIsExpired,
  sessionIsOwnedByUser,
  studentContextMatchesSession,
  studentContextScopesFromFlags,
};
