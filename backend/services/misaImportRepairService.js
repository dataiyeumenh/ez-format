const crypto = require("node:crypto");
const { compose, Transform } = require("node:stream");
const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const ConversionRun = require("../models/ConversionRun");
const MisaImportIssue = require("../models/MisaImportIssue");
const MisaImportRepairSession = require("../models/MisaImportRepairSession");
const MisaImportRepairConfirmation = require("../models/MisaImportRepairConfirmation");
const MisaRetryBatch = require("../models/MisaRetryBatch");
const {
  ARTIFACT_TYPES,
  HUMAN_CONFIRMATION_ACTIONS,
  IMPORT_STATUSES,
  MATCH_STATUSES,
  REPAIR_STATUSES,
  RESOLUTION_SCOPES,
  RESOLUTION_STATUSES,
} = require("../constants/misaImportRepair");
const conversionArtifacts = require("./conversionArtifactService");
const { validateManifestBinding } = require("./misaManifestService");
const { createConversionContextToken } = require("./conversionContextService");
const {
  forwardBinary,
  forwardJson,
  forwardMultipart,
  isConverterTimeoutError,
} = require("./converterGatewayService");
const { userCanAccessWorkspace } = require("./masterDataService");

const MAX_CANDIDATES = 5;
const MAX_BULK_ISSUES = 500;
const MAX_SIMULATION_EXAMPLES = 20;
const ISSUE_BATCH_SIZE = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const HUMAN_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_IMPORT_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_OUTPUT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MANIFEST_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
const RETRY_CONFIRMATION_STATEMENT = "Toàn bộ chứng từ này chưa được MISA nhập";
const ALLOWED_TRANSFORMS = new Set([
  "set_value",
  "trim_text",
  "normalize_date",
  "normalize_decimal",
  "replace_code",
]);
const LOCATOR_FIELDS = [
  "document_number",
  "invoice_number",
  "invoice_symbol",
  "document_date",
  "partner_code",
  "item_code",
  "amount",
];
const SUMMARY_FIELDS = [
  "totalIssues",
  "unmatchedIssues",
  "ambiguousIssues",
  "confirmedIssues",
  "unresolvedIssues",
  "unknownDocumentGroups",
  "failedDocumentGroups",
];
const IMPORT_STATUS_VALUES = new Set(["unknown", "failed", "imported"]);
const IMPORT_RESULT_COLUMN_ROLES = new Set([
  "technical_message",
  "source_row_number",
  "document_number",
  "invoice_number",
  "invoice_symbol",
  "document_date",
  "partner_code",
  "item_code",
  "amount",
]);
const FORBIDDEN_RESPONSE_TOKENS = [
  "base64",
  "binary",
  "blob",
  "buffer",
  "bytes",
  "filebytes",
  "rawcontent",
  "rawbytes",
  "rawworkbook",
  "workbookbytes",
];
const AUDIT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const AUDIT_MATCH_STATUSES = new Set(MATCH_STATUSES);
const AUDIT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIT_OBJECT_ID = /^[0-9a-f]{24}$/i;
const AUDIT_ID_FIELDS = new Set(["repairId", "conversionRunId", "workspaceId", "retryBatchId"]);
const AUDIT_OPERATIONS = new Set([
  "bulk_apply",
  "confirm_match",
  "retry_create",
  "create",
  "retry_download",
  "confirmation_issue",
  "read",
  "issue_resolve",
  "import_status",
  "bulk_simulate",
  "schema",
  "sweep",
]);
const AUDIT_OUTCOMES = new Set(["completed", "rejected", "failed", "skipped"]);
const METRIC_REASONS = new Set([
  "none",
  "disabled",
  "validation",
  "not_found",
  "expired",
  "conflict",
  "upstream",
  "internal",
]);
const METRIC_STATUSES = new Set(["success", "client_error", "server_error"]);

function validAuditId(value) {
  const normalized = String(value == null ? "" : value).trim();
  return AUDIT_OBJECT_ID.test(normalized) || AUDIT_UUID.test(normalized)
    ? normalized
    : "";
}

function auditIdentifier(field, value, maxLength = 256) {
  const normalized = text(value, maxLength);
  if (field === "requestId") return AUDIT_UUID.test(normalized) ? normalized : "";
  if (field === "artifactType") return ARTIFACT_TYPES.includes(normalized) ? normalized : "";
  if (field === "adapterId") return normalized === "manual_excel_v1" ? normalized : "";
  if (AUDIT_ID_FIELDS.has(field)) return validAuditId(normalized);
  if (field === "event") {
    const parts = normalized.split(".");
    return parts.length === 3 &&
      parts[0] === "misa_import_repair" &&
      AUDIT_OPERATIONS.has(parts[1]) &&
      AUDIT_OUTCOMES.has(parts[2])
      ? normalized
      : "";
  }
  return AUDIT_IDENTIFIER.test(normalized) ? normalized : "";
}

function auditCount(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0
    ? Math.min(normalized, 1_000_000_000)
    : 0;
}

function sanitizeMatchStatusCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([status]) => AUDIT_MATCH_STATUSES.has(status))
      .map(([status, count]) => [status, auditCount(count)]),
  );
}

function buildMisaImportRepairAuditEvent(input = {}) {
  const event = {};
  for (const field of [
    "requestId",
    "event",
    "repairId",
    "conversionRunId",
    "workspaceId",
    "adapterId",
    "artifactType",
  ]) {
    if (!Object.hasOwn(input, field)) continue;
    event[field] = auditIdentifier(field, input[field]);
  }
  if (Object.hasOwn(input, "issueCount")) event.issueCount = auditCount(input.issueCount);
  if (Object.hasOwn(input, "matchStatusCounts")) {
    event.matchStatusCounts = sanitizeMatchStatusCounts(input.matchStatusCounts);
  }
  if (Object.hasOwn(input, "retryBatchId")) {
    event.retryBatchId = auditIdentifier("retryBatchId", input.retryBatchId);
  }
  if (Object.hasOwn(input, "durationMs")) event.durationMs = auditCount(input.durationMs);
  if (Object.hasOwn(input, "statusCode")) event.statusCode = auditCount(input.statusCode);
  return event;
}

const metricSeries = {
  counters: new Map(),
  histograms: new Map(),
};
const METRIC_LABEL_NAMES = ["operation", "outcome", "reason", "status"];
const HISTOGRAM_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function metricSeriesKey(labels) {
  return [labels.operation, labels.outcome, labels.reason, labels.status].join("|");
}

const defaultMetricSink = {
  counter(name, value, labels) {
    const key = `${name}|${metricSeriesKey(labels)}`;
    metricSeries.counters.set(key, (metricSeries.counters.get(key) || 0) + value);
  },
  histogram(name, value, labels) {
    const key = `${name}|${metricSeriesKey(labels)}`;
    const current = metricSeries.histograms.get(key) || {
      count: 0,
      sum: 0,
      buckets: Array(HISTOGRAM_BUCKETS.length).fill(0),
    };
    current.count += 1;
    current.sum += value;
    HISTOGRAM_BUCKETS.forEach((boundary, index) => {
      if (value <= boundary) current.buckets[index] += 1;
    });
    metricSeries.histograms.set(key, current);
  },
};

function metricLabel(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function createMisaImportRepairMetrics({ sink = defaultMetricSink } = {}) {
  return {
    record({ operation, outcome, reason, status, durationMs }) {
      const labels = {
        operation: metricLabel(operation, AUDIT_OPERATIONS, "unknown"),
        outcome: metricLabel(outcome, AUDIT_OUTCOMES, "failed"),
        reason: metricLabel(reason, METRIC_REASONS, "internal"),
        status: metricLabel(status, METRIC_STATUSES, "server_error"),
      };
      sink.counter("misa_import_repair_requests_total", 1, labels);
      sink.histogram(
        "misa_import_repair_duration_ms",
        auditCount(durationMs),
        labels,
      );
    },
  };
}

let activeMetrics = createMisaImportRepairMetrics();

function setMisaImportRepairMetrics(metrics) {
  const previous = activeMetrics;
  activeMetrics = metrics || createMisaImportRepairMetrics();
  return () => {
    activeMetrics = previous;
  };
}

function emitMisaImportRepairMetric(input) {
  try {
    activeMetrics.record(input);
  } catch {}
}

function getMisaImportRepairMetricSnapshot() {
  return {
    counters: Object.fromEntries(metricSeries.counters),
    histograms: Object.fromEntries(metricSeries.histograms),
  };
}

function prometheusLabelText(values) {
  return METRIC_LABEL_NAMES
    .map((name) => `${name}="${values[name]}"`)
    .join(",");
}

function metricSeriesLabels(key) {
  const [, ...values] = key.split("|");
  return Object.fromEntries(METRIC_LABEL_NAMES.map((name, index) => [name, values[index]]));
}

function renderMisaImportRepairPrometheusMetrics() {
  const lines = [
    "# HELP misa_import_repair_requests_total MISA import repair requests by bounded outcome labels.",
    "# TYPE misa_import_repair_requests_total counter",
  ];
  for (const [key, value] of metricSeries.counters) {
    const labels = metricSeriesLabels(key);
    lines.push(`misa_import_repair_requests_total{${prometheusLabelText(labels)}} ${value}`);
  }
  lines.push(
    "# HELP misa_import_repair_duration_ms MISA import repair request duration in milliseconds.",
    "# TYPE misa_import_repair_duration_ms histogram",
  );
  for (const [key, value] of metricSeries.histograms) {
    const labels = metricSeriesLabels(key);
    HISTOGRAM_BUCKETS.forEach((boundary, index) => {
      lines.push(
        `misa_import_repair_duration_ms_bucket{${prometheusLabelText({ ...labels, le: boundary })},le="${boundary}"} ${value.buckets[index]}`,
      );
    });
    lines.push(
      `misa_import_repair_duration_ms_bucket{${prometheusLabelText(labels)},le="+Inf"} ${value.count}`,
      `misa_import_repair_duration_ms_count{${prometheusLabelText(labels)}} ${value.count}`,
      `misa_import_repair_duration_ms_sum{${prometheusLabelText(labels)}} ${value.sum}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function emitMisaImportRepairAuditEvent(input, { logger = console } = {}) {
  const event = buildMisaImportRepairAuditEvent(input);
  try {
    logger.info?.(JSON.stringify(event));
  } catch {}
  return event;
}

function repairError(statusCode, message, code = "MISA_IMPORT_REPAIR_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function text(value, maxLength = 256) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

function strictText(value, maxLength, label, code = "INVALID_REPAIR_PAYLOAD") {
  const raw = String(value == null ? "" : value).trim();
  if (raw.length > maxLength) throw repairError(422, `${label} quá dài`, code);
  return raw;
}

function objectId(value, label, code = "REPAIR_NOT_FOUND") {
  const normalized = text(value, 128);
  if (!mongoose.isValidObjectId(normalized)) {
    throw repairError(404, `${label} không tồn tại`, code);
  }
  return normalized;
}

function expectedVersion(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw repairError(409, "expected_version không khớp phiên sửa lỗi", "STALE_REPAIR_VERSION");
  }
  return parsed;
}

function repairExpiry(env = process.env, now = new Date()) {
  const configured = Number(env.CONVERTER_ARTIFACT_TTL_SECONDS || 3600);
  const seconds = Number.isFinite(configured) ? Math.max(60, configured) : 3600;
  return new Date(now.getTime() + seconds * 1000);
}

function ownerScopeForRun(run, userId) {
  const workspaceId = run?.workspace ? String(run.workspace?._id || run.workspace) : "";
  return {
    workspaceId: workspaceId || null,
    ownerScope: workspaceId ? `workspace:${workspaceId}` : `user:${String(userId)}`,
  };
}

function plain(value) {
  return value && typeof value.toObject === "function" ? value.toObject() : value;
}

function canonicalPayloadKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenResponseName(key) {
  const normalized = canonicalPayloadKey(key);
  return FORBIDDEN_RESPONSE_TOKENS.some((token) => normalized.includes(token));
}

function primitiveCell(value, maxLength = 4096) {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, maxLength);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

function sanitizeCellRow(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((cell) => primitiveCell(cell) ?? null);
  }
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return undefined;
  const row = {};
  for (const [key, cell] of Object.entries(value)) {
    if (isForbiddenResponseName(key)) continue;
    const sanitized = primitiveCell(cell);
    if (sanitized !== undefined) row[String(key).slice(0, 256)] = sanitized;
  }
  return row;
}

function sanitizeRepairPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) {
    return null;
  }
  const field = primitiveCell(value.field, 256);
  const patchValue = primitiveCell(value.value);
  if (
    typeof field !== "string" || !field.trim() ||
    isForbiddenResponseName(field) ||
    patchValue === undefined
  ) return null;
  return { field: field.trim(), value: patchValue };
}

function sanitizeInspectionPayload(payload) {
  const sourceRows = Array.isArray(payload.sample_rows) ? payload.sample_rows : [];
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  return {
    sheet_name: primitiveCell(payload.sheet_name, 128) || "",
    header_row: payload.header_row,
    headers: payload.headers
      .filter((header) => typeof header === "string")
      .slice(0, 100)
      .map((header) => header.slice(0, 256)),
    sample_rows: sourceRows
      .slice(0, 20)
      .map(sanitizeCellRow)
      .filter((row) => row !== undefined),
    warnings: warnings.slice(0, 100).map((warning) => {
      if (typeof warning === "string") return warning.slice(0, 1000);
      if (!warning || typeof warning !== "object" || Array.isArray(warning)) return undefined;
      const result = {};
      for (const key of ["code", "message", "severity"]) {
        if (isForbiddenResponseName(key)) continue;
        const cell = primitiveCell(warning[key], 1000);
        if (cell !== undefined) result[key] = cell;
      }
      return result;
    }).filter((warning) => warning !== undefined),
    candidates: candidates.slice(0, 20).map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
      return {
        sheet_name: primitiveCell(candidate.sheet_name, 128) || "",
        header_row: Number.isSafeInteger(candidate.header_row) ? candidate.header_row : null,
        headers: Array.isArray(candidate.headers)
          ? candidate.headers.filter((header) => typeof header === "string").slice(0, 100)
          : [],
      };
    }).filter((candidate) => candidate !== undefined),
    selection_ambiguous: payload.selection_ambiguous === true,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createRequestFingerprint({ conversionRunId, artifactType, uploadSha256 }) {
  return sha256(Buffer.from(JSON.stringify({
    artifactType,
    conversionRunId: String(conversionRunId),
    uploadSha256,
  }), "utf8"));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function assertHumanAction(body = {}) {
  const actor = text(body.actor || body.source, 32).toLowerCase();
  if (body.ai_generated === true || actor === "ai") {
    throw repairError(403, "AI không được phép xác nhận hoặc sửa dữ liệu", "AI_MUTATION_FORBIDDEN");
  }
}

function validateResolutionPatch(body = {}) {
  assertHumanAction(body);
  const patch = body.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Buffer.isBuffer(patch)) {
    throw repairError(422, "Patch sửa lỗi không hợp lệ", "INVALID_REPAIR_PATCH");
  }
  const allowedKeys = new Set(["field", "value", "transform", "from", "to"]);
  if (Object.keys(patch).some((key) => !allowedKeys.has(key))) {
    throw repairError(422, "Patch không cho phép biểu thức hoặc mutation lồng nhau", "INVALID_REPAIR_PATCH");
  }
  const field = text(patch.field, 256);
  const transform = text(patch.transform || "set_value", 64);
  if (!field || !ALLOWED_TRANSFORMS.has(transform)) {
    throw repairError(422, "Transform sửa lỗi không được hỗ trợ", "INVALID_REPAIR_PATCH");
  }
  const result = { field, value: patch.value, transform };
  for (const key of ["value", "from", "to"]) {
    const value = patch[key];
    if (value && typeof value === "object") {
      throw repairError(422, "Patch không cho phép mutation lồng nhau", "INVALID_REPAIR_PATCH");
    }
    if (typeof value === "string" && value.trimStart().startsWith("=")) {
      throw repairError(422, "Patch không cho phép công thức", "INVALID_REPAIR_PATCH");
    }
    if (key !== "value" && Object.hasOwn(patch, key)) result[key] = value;
  }
  if (transform === "replace_code" && (!Object.hasOwn(result, "from") || !Object.hasOwn(result, "to"))) {
    throw repairError(422, "replace_code yêu cầu from và to", "INVALID_REPAIR_PATCH");
  }
  return result;
}

function assertRetryGate({ groups, issues, readiness, acknowledgeWarnings = false }) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw repairError(409, "Thiếu document group để retry", "RETRY_GROUP_MISSING");
  }
  if (groups.some((group) =>
    String(group?.status || group?.importStatus) !== "failed" || group?.userConfirmed !== true)) {
    throw repairError(409, "Document group có trạng thái unknown, mixed hoặc chưa xác nhận", "RETRY_STATUS_BLOCKED");
  }
  if (!Array.isArray(issues) || issues.some((issue) =>
    String(issue?.matchStatus) !== "confirmed" ||
    issue?.userConfirmedMatch !== true ||
    String(issue?.resolution?.status) !== "resolved")) {
    throw repairError(409, "Còn issue mơ hồ, chưa match hoặc chưa resolved", "RETRY_ISSUE_BLOCKED");
  }
  const summary = readiness?.summary || {};
  if (Number(summary.fatal || 0) > 0 || Number(summary.blocker || 0) > 0) {
    throw repairError(422, "Readiness còn deterministic blocker", "RETRY_READINESS_BLOCKED");
  }
  if (Number(summary.warning || 0) > 0 && !acknowledgeWarnings) {
    throw repairError(409, "Cần xác nhận readiness warnings", "RETRY_WARNING_ACK_REQUIRED");
  }
  return true;
}

function warningAcknowledgement(body = {}) {
  const snake = body?.acknowledge_warnings;
  const camel = body?.acknowledgeWarnings;
  for (const value of [snake, camel]) {
    if (value !== undefined && typeof value !== "boolean") {
      throw repairError(422, "acknowledge_warnings phải là boolean", "INVALID_RETRY_PAYLOAD");
    }
  }
  if (snake !== undefined && camel !== undefined && snake !== camel) {
    throw repairError(422, "acknowledge_warnings aliases không khớp", "INVALID_RETRY_PAYLOAD");
  }
  return snake ?? camel ?? false;
}

function assertResolutionReadiness(readiness, acknowledgeWarnings = false) {
  const summary = readiness?.summary || {};
  if (Number(summary.fatal || 0) > 0 || Number(summary.blocker || 0) > 0) {
    throw repairError(422, "Cách sửa còn deterministic blocker", "RESOLUTION_READINESS_BLOCKED");
  }
  if (Number(summary.warning || 0) > 0 && acknowledgeWarnings !== true) {
    throw repairError(409, "Cần xác nhận cảnh báo của cách sửa", "RESOLUTION_WARNING_ACK_REQUIRED");
  }
  return true;
}

function validateReadinessPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidConverterResponse();
  const summary = payload.summary;
  if (!summary || typeof summary !== "object") throw invalidConverterResponse();
  const normalized = {};
  for (const severity of ["fatal", "blocker", "warning", "info"]) {
    const count = Number(summary[severity] || 0);
    if (!Number.isSafeInteger(count) || count < 0) throw invalidConverterResponse();
    normalized[severity] = count;
  }
  return {
    status: text(payload.status, 64),
    summary: normalized,
    issues: Array.isArray(payload.issues) ? payload.issues.slice(0, 500) : [],
    examples: Array.isArray(payload.examples)
      ? payload.examples.slice(0, MAX_SIMULATION_EXAMPLES)
      : [],
    selectedDocumentGroupCount: Number(payload.selected_document_group_count || 0),
    selectedRowCount: Number(payload.selected_row_count || 0),
  };
}

function readinessIssueResponse(issue) {
  const source = issue && typeof issue === "object" && !Array.isArray(issue) ? issue : {};
  const severity = ["fatal", "blocker", "warning", "info"].includes(String(source.severity))
    ? String(source.severity)
    : "info";
  const rowNumberValue = Number(source.row_number ?? source.rowNumber);
  return {
    severity,
    code: primitiveCell(source.code, 128) || "",
    message: primitiveCell(source.message, 512) || "",
    field: primitiveCell(source.field, 256) || "",
    rowNumber: Number.isSafeInteger(rowNumberValue) && rowNumberValue >= 1
      ? rowNumberValue
      : null,
  };
}

function retryReadinessHash(body = {}, { required = false } = {}) {
  const snake = body?.readiness_hash;
  const camel = body?.readinessHash;
  const normalized = [snake, camel].map((value) => {
    if (value === undefined || value === null || value === "") return null;
    const result = strictText(value, 64, "readiness_hash", "INVALID_RETRY_PAYLOAD").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(result)) {
      throw repairError(422, "readiness_hash không hợp lệ", "INVALID_RETRY_PAYLOAD");
    }
    return result;
  });
  if (normalized[0] && normalized[1] && normalized[0] !== normalized[1]) {
    throw repairError(422, "readiness_hash aliases không khớp", "INVALID_RETRY_PAYLOAD");
  }
  const result = normalized[0] || normalized[1];
  if (required && !result) {
    throw repairError(422, "readiness_hash là bắt buộc", "READINESS_PREFLIGHT_REQUIRED");
  }
  return result;
}

function selectedIssueIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_ISSUES) {
    throw repairError(422, `Bulk action chỉ hỗ trợ 1-${MAX_BULK_ISSUES} issues`, "INVALID_BULK_SELECTION");
  }
  const ids = value.map((item) => objectId(item, "Issue", "ISSUE_NOT_FOUND"));
  if (new Set(ids).size !== ids.length) {
    throw repairError(422, "Bulk action không cho phép issue trùng lặp", "INVALID_BULK_SELECTION");
  }
  return ids;
}

function patchOutputRow(issue) {
  const groupId = String(issue.confirmedDocumentGroupId || "");
  const numbers = [];
  for (const candidate of issue.candidates || []) {
    if (String(candidate.documentGroupId || "") !== groupId) continue;
    try {
      const evidence = JSON.parse(String(candidate.evidence || "{}"));
      const number = Number(evidence.output_row_number);
      if (Number.isSafeInteger(number) && number > 0) numbers.push(number);
    } catch {}
  }
  const unique = [...new Set(numbers)];
  return unique.length === 1 ? unique[0] : null;
}

function converterPatch(issue, patchOverride = null, manifest = null) {
  const source = patchOverride || issue?.resolution?.patch || {};
  const corePatch = Object.fromEntries(
    ["field", "value", "transform", "from", "to"]
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
  const patch = validateResolutionPatch({ patch: corePatch });
  const outputRowNumber = patchOutputRow(issue);
  if (!outputRowNumber && manifest) {
    const group = (manifest.document_groups || []).find((item) =>
      String(item.document_group_id || "") === String(issue.confirmedDocumentGroupId || ""));
    if (!group) {
      throw repairError(409, "Issue không thuộc trusted document group", "PATCH_TARGET_AMBIGUOUS");
    }
    if (Number(group.line_count || 0) !== 1) {
      throw repairError(409, "Không xác định duy nhất output row cần sửa", "PATCH_TARGET_AMBIGUOUS");
    }
  }
  return {
    document_group_id: String(issue.confirmedDocumentGroupId || ""),
    ...(outputRowNumber ? { output_row_number: outputRowNumber } : {}),
    ...patch,
  };
}

function assertIdempotentReplay(existing, requestFingerprint) {
  if (text(existing?.requestFingerprint, 64).toLowerCase() !== requestFingerprint) {
    throw repairError(409, "Idempotency key đã được dùng cho yêu cầu khác", "IDEMPOTENCY_KEY_REUSED");
  }
  return existing;
}

function manifestBinding(run, targetTemplateId) {
  if (
    Number(run?.manifestSchemaVersion) !== 1 ||
    !text(run?.manifestArtifactKey, 512) ||
    !/^[a-f0-9]{64}$/.test(text(run?.manifestSha256, 64).toLowerCase())
  ) {
    throw repairError(409, "Conversion run chưa có manifest provenance", "MANIFEST_MISSING");
  }
  return {
    conversionRunId: String(run._id),
    exportBatchId: `export-${run._id}`,
    targetTemplateId,
    rawFileHash: text(run.manifestRawFileSha256, 64).toLowerCase(),
    mappingProfileId: text(run.manifestMappingProfileId, 256),
    mappingProfileVersion: run.manifestMappingProfileVersion,
    mappingProfileStateHash: text(run.manifestMappingProfileStateHash, 64).toLowerCase(),
  };
}

function positiveByteLimit(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function artifactObjectId(metadata) {
  return text(metadata?.gridFsObjectId, 512);
}

function validateStoredArtifact(stored, binding, maxBytes, now = () => new Date()) {
  const metadata = stored?.metadata;
  const expiresAt = new Date(metadata?.expiresAt);
  if (
    !metadata ||
    !artifactObjectId(metadata) ||
    !/^[a-f0-9]{64}$/.test(text(metadata.sha256, 64).toLowerCase()) ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes < 0 ||
    metadata.sizeBytes > maxBytes ||
    !text(metadata.mime, 256) ||
    metadata.status !== "available" ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now()
  ) {
    throw repairError(409, "Artifact metadata không hợp lệ", "ARTIFACT_METADATA_INVALID");
  }
  for (const field of ["ownerScope", "userId", "runId", "sessionId", "uploadId", "targetTemplateId"]) {
    if (String(metadata[field] ?? "") !== String(binding[field] ?? "")) {
      throw repairError(409, "Artifact binding không khớp", "ARTIFACT_BINDING_MISMATCH");
    }
  }
  if (
    Object.hasOwn(binding, "workspaceId") &&
    String(metadata.workspaceId ?? "") !== String(binding.workspaceId ?? "")
  ) {
    throw repairError(409, "Artifact binding không khớp", "ARTIFACT_BINDING_MISMATCH");
  }
  if (metadata.kind && metadata.kind !== binding.kind) {
    throw repairError(409, "Artifact binding không khớp", "ARTIFACT_BINDING_MISMATCH");
  }
  if (!stored.content || typeof stored.content.pipe !== "function") {
    throw repairError(503, "Artifact stream không khả dụng", "ARTIFACT_STREAM_UNAVAILABLE");
  }
  return metadata;
}

function boundedVerifiedArtifactStream(stored, binding, maxBytes, now) {
  const metadata = validateStoredArtifact(stored, binding, maxBytes, now);
  const digest = crypto.createHash("sha256");
  let sizeBytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > metadata.sizeBytes || sizeBytes > maxBytes) {
        callback(repairError(413, "Artifact vượt giới hạn kích thước", "ARTIFACT_TOO_LARGE"));
        return;
      }
      digest.update(bytes);
      callback(null, bytes);
    },
    flush(callback) {
      if (sizeBytes !== metadata.sizeBytes || digest.digest("hex") !== metadata.sha256) {
        callback(repairError(409, "Artifact checksum không khớp", "ARTIFACT_CHECKSUM_MISMATCH"));
        return;
      }
      callback();
    },
  });
  return compose(stored.content, verifier);
}

async function readArtifactBuffer(stored, binding, maxBytes, now) {
  const chunks = [];
  let sizeBytes = 0;
  for await (const chunk of boundedVerifiedArtifactStream(stored, binding, maxBytes, now)) {
    const bytes = Buffer.from(chunk);
    sizeBytes += bytes.length;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, sizeBytes);
}

async function verifyArtifactStream(stored, binding, maxBytes, now) {
  for await (const _chunk of boundedVerifiedArtifactStream(stored, binding, maxBytes, now)) {
    // Full consumption verifies the GridFS stream without retaining artifact bytes.
  }
}

async function getBoundArtifact({ artifacts, run, ownerScope, userId, kind, repairId = null }) {
  const binding = {
    sessionId: repairId || text(run.operationSessionId, 256),
    runId: String(run._id),
    ownerScope,
    userId: String(userId),
    uploadId: text(run.converterUploadId, 256),
    targetTemplateId: text(run.targetTemplateId, 256),
    kind,
    revision: 1,
  };
  const stored = await artifacts.getArtifact(binding);
  return { stored, binding };
}

async function loadOwnedRun({ Run, Workspace, runId, userId }) {
  if (!mongoose.isValidObjectId(String(runId || ""))) {
    throw repairError(404, "Conversion run không tồn tại", "RUN_NOT_FOUND");
  }
  const run = await Run.findOne({ _id: runId, user: userId });
  if (!run) throw repairError(404, "Conversion run không tồn tại", "RUN_NOT_FOUND");
  if (String(run.status) !== "completed" || !run.exportArtifactKey || !run.outputSha256) {
    throw repairError(409, "Conversion run chưa có output hoàn tất", "RUN_NOT_READY");
  }
  const { workspaceId, ownerScope } = ownerScopeForRun(run, userId);
  let workspace = null;
  if (workspaceId) {
    workspace = await Workspace.findOne({ _id: workspaceId, isActive: true });
    if (!workspace || !userCanAccessWorkspace(workspace, userId)) {
      throw repairError(404, "Conversion run không tồn tại", "RUN_NOT_FOUND");
    }
  }
  return { run, workspace, workspaceId, ownerScope };
}

async function loadManifest({ artifacts, run, ownerScope, userId, now }) {
  const binding = manifestBinding(run, text(run.targetTemplateId, 256));
  let stored;
  let artifactBinding;
  try {
    ({ stored, binding: artifactBinding } = await getBoundArtifact({
      artifacts, run, ownerScope, userId, kind: "manifest",
    }));
  } catch (error) {
    if (Number(error?.statusCode) === 410) {
      throw repairError(410, "Manifest conversion không còn khả dụng", "MANIFEST_EXPIRED");
    }
    if (Number(error?.statusCode) === 404) {
      throw repairError(409, "Manifest conversion bị thiếu", "MANIFEST_MISSING");
    }
    throw error;
  }
  if (
    artifactObjectId(stored.metadata) !== String(run.manifestArtifactKey) ||
    stored.metadata.sha256 !== run.manifestSha256
  ) {
    throw repairError(409, "Manifest conversion không khớp conversion run", "MANIFEST_BINDING_MISMATCH");
  }
  let manifest;
  try {
    const content = await readArtifactBuffer(
      stored,
      artifactBinding,
      positiveByteLimit("CONVERTER_MAX_MANIFEST_BYTES", DEFAULT_MANIFEST_ARTIFACT_MAX_BYTES),
      now,
    );
    manifest = JSON.parse(content.toString("utf8"));
    validateManifestBinding(manifest, binding);
  } catch (error) {
    if (error?.statusCode === 409) throw error;
    throw repairError(409, "Manifest conversion không hợp lệ", "MANIFEST_BINDING_MISMATCH");
  }
  return { manifest, stored, binding };
}

async function assertOutputArtifact({ artifacts, run, ownerScope, userId, now }) {
  try {
    const { stored, binding } = await getBoundArtifact({
      artifacts, run, ownerScope, userId, kind: "output",
    });
    if (
      artifactObjectId(stored.metadata) !== String(run.exportArtifactKey) ||
      stored.metadata.sha256 !== run.outputSha256
    ) {
      throw repairError(410, "Artifact conversion không còn khả dụng", "OUTPUT_EXPIRED");
    }
    await verifyArtifactStream(
      stored,
      binding,
      positiveByteLimit("CONVERTER_MAX_OUTPUT_BYTES", DEFAULT_OUTPUT_ARTIFACT_MAX_BYTES),
      now,
    );
    return stored;
  } catch (error) {
    if ([404, 410].includes(Number(error?.statusCode))) {
      throw repairError(410, "Artifact conversion không còn khả dụng", "OUTPUT_EXPIRED");
    }
    throw error;
  }
}

function createContextToken({ createToken, run, userId, workspaceId, ownerScope, scopes }) {
  return createToken({
    userId,
    workspaceId,
    ownerScope,
    snapshotSetHash: run.snapshotSetHash || null,
    snapshotIds: [],
    masterDataRevision: 0,
    conversionContextId: text(run.conversionContextId, 128),
    conversionRunId: String(run._id),
    operationSessionId: text(run.operationSessionId, 256),
    uploadId: text(run.converterUploadId, 256),
    targetTemplateId: text(run.targetTemplateId, 256),
    maxFileBytes: Number(process.env.CONVERTER_MAX_FILE_BYTES || 20971520),
    scopes,
    expiresIn: "10m",
  });
}

function normalizedValue(value) {
  return value == null ? "" : String(value);
}

function normalizedSourceRowNumber(value) {
  if (value == null || value === "") return null;
  const normalized = Number(String(value).trim());
  return Number.isSafeInteger(normalized) && normalized >= 1 && normalized <= 1_048_576
    ? normalized
    : null;
}

function normalizeLocator(locator = {}) {
  const source = locator && typeof locator === "object" ? locator : {};
  return {
    sourceRowNumber: normalizedSourceRowNumber(source.source_row_number),
    documentNumber: normalizedValue(source.document_number),
    invoiceNumber: normalizedValue(source.invoice_number),
    invoiceSymbol: normalizedValue(source.invoice_symbol),
    documentDate: normalizedValue(source.document_date),
    partnerCode: normalizedValue(source.partner_code),
    itemCode: normalizedValue(source.item_code),
    amount: normalizedValue(source.amount),
    lineFingerprint: null,
  };
}

function businessFields(locator = {}) {
  return Object.fromEntries(
    LOCATOR_FIELDS
      .filter((field) => locator[field] !== undefined && locator[field] !== null && locator[field] !== "")
      .map((field) => [field, locator[field]]),
  );
}

function manifestLocator(row) {
  const locator = row?.locator && typeof row.locator === "object" ? row.locator : {};
  return Object.fromEntries(LOCATOR_FIELDS.map((field) => [field, locator[field] == null ? "" : locator[field]]));
}

function buildIssueMatch(issue, manifest) {
  const locator = issue?.locator && typeof issue.locator === "object" ? issue.locator : {};
  const fields = businessFields(locator);
  const rows = Array.isArray(manifest?.rows) ? manifest.rows : [];
  const matches = Object.keys(fields).length && (fields.document_number || fields.invoice_number)
    ? rows.filter((row) => {
        const candidate = manifestLocator(row);
        return Object.entries(fields).every(([field, value]) => candidate[field] === value);
      })
    : [];
  const isUnique = matches.length === 1;
  const candidates = matches.slice(0, MAX_CANDIDATES).map((row) => ({
    documentGroupId: text(row.document_group_id, 256),
    method: "exact_business_key",
    evidence: JSON.stringify({
      matched_fields: Object.keys(fields),
      export_row_id: text(row.export_row_id, 256),
      output_row_number: Number(row.output_row_number) || null,
    }),
  }));
  return {
    normalizedLocator: normalizeLocator(locator),
    candidates,
    matchStatus: isUnique ? "suggested" : matches.length > 1 ? "ambiguous" : "unmatched",
  };
}

function manifestGroupEvidence(group, manifest) {
  const rowNumbers = Array.isArray(group?.output_row_numbers)
    ? group.output_row_numbers.filter((value) => Number.isSafeInteger(value) && value >= 1).slice(0, 20)
    : [];
  const groupId = text(group?.document_group_id, 256);
  const row = (Array.isArray(manifest?.rows) ? manifest.rows : []).find(
    (candidate) => String(candidate?.document_group_id || "") === groupId,
  );
  const locator = row?.locator && typeof row.locator === "object" ? row.locator : {};
  return {
    documentNumber: text(locator.document_number, 256),
    invoiceNumber: text(locator.invoice_number, 256),
    invoiceSymbol: text(locator.invoice_symbol, 256),
    documentDate: text(locator.document_date, 64),
    partnerCode: text(locator.partner_code, 256),
    lineCount: Math.min(Math.max(Number(group?.line_count) || rowNumbers.length, 0), 10_000),
    outputRowNumbers: rowNumbers,
  };
}

function issueDocument(issue, { repair, manifest, expiresAt }) {
  const match = buildIssueMatch(issue, manifest);
  return {
    repairSession: repair._id,
    ownerScope: repair.ownerScope,
    workspace: repair.workspace || null,
    issueKey: text(issue?.issue_key, 256),
    artifactRowNumber: Number.isSafeInteger(Number(issue?.artifact_row_number))
      ? Number(issue.artifact_row_number)
      : null,
    technicalMessage: text(issue?.technical_message, 1000),
    normalizedLocator: match.normalizedLocator,
    category: text(issue?.category, 128),
    severity: text(issue?.severity, 32),
    candidates: match.candidates,
    matchStatus: match.matchStatus,
    expiresAt,
  };
}

function summaryFromIssues(issues, documentGroupStatuses = []) {
  const summary = {
    totalIssues: issues.length,
    unmatchedIssues: 0,
    ambiguousIssues: 0,
    confirmedIssues: 0,
    unresolvedIssues: 0,
    unknownDocumentGroups: 0,
    failedDocumentGroups: 0,
  };
  for (const issue of issues) {
    if (issue.matchStatus === "unmatched") summary.unmatchedIssues += 1;
    if (issue.matchStatus === "ambiguous") summary.ambiguousIssues += 1;
    if (issue.matchStatus === "confirmed") summary.confirmedIssues += 1;
    if (!issue.resolution || issue.resolution.status === "unresolved") summary.unresolvedIssues += 1;
  }
  for (const group of documentGroupStatuses) {
    if (group.status === "unknown") summary.unknownDocumentGroups += 1;
    if (group.status === "failed") summary.failedDocumentGroups += 1;
  }
  return summary;
}

function documentGroupResponse(group) {
  const evidence = plain(group?.evidence) || {};
  const normalizedEvidence = {
    documentNumber: primitiveCell(evidence.documentNumber, 256) || "",
    invoiceNumber: primitiveCell(evidence.invoiceNumber, 256) || "",
    invoiceSymbol: primitiveCell(evidence.invoiceSymbol, 256) || "",
    documentDate: primitiveCell(evidence.documentDate, 64) || "",
    partnerCode: primitiveCell(evidence.partnerCode, 256) || "",
    lineCount: Number.isSafeInteger(evidence.lineCount) && evidence.lineCount >= 0
      ? evidence.lineCount
      : 0,
    outputRowNumbers: Array.isArray(evidence.outputRowNumbers)
      ? evidence.outputRowNumbers.filter((value) => Number.isSafeInteger(value) && value >= 1).slice(0, 20)
      : [],
  };
  const hasEvidence = normalizedEvidence.documentNumber || normalizedEvidence.invoiceNumber ||
    normalizedEvidence.invoiceSymbol ||
    normalizedEvidence.documentDate || normalizedEvidence.partnerCode ||
    normalizedEvidence.lineCount > 0 || normalizedEvidence.outputRowNumbers.length > 0;
  return {
    documentGroupId: primitiveCell(group?.documentGroupId, 256) || "",
    status: IMPORT_STATUS_VALUES.has(group?.status) ? group.status : "unknown",
    userConfirmed: group?.userConfirmed === true,
    confirmedBy: group?.confirmedBy ? String(group.confirmedBy) : null,
    confirmedAt: group?.confirmedAt instanceof Date ? group.confirmedAt.toISOString() : null,
    ...(hasEvidence ? { evidence: normalizedEvidence } : {}),
  };
}

function sessionResponse(session, documentGroups = null) {
  const value = plain(session) || {};
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    const number = Number(value.summary?.[field]);
    if (Number.isSafeInteger(number) && number >= 0) summary[field] = number;
  }
  const documentGroupStatuses = (Array.isArray(documentGroups)
    ? documentGroups
    : Array.isArray(value.documentGroupStatuses) ? value.documentGroupStatuses : [])
    .map(documentGroupResponse);
  return {
    repairId: String(value._id || ""),
    status: REPAIR_STATUSES.includes(value.status) ? value.status : "failed",
    version: Number.isSafeInteger(value.version) && value.version >= 0 ? value.version : 0,
    artifactType: ARTIFACT_TYPES.includes(value.artifactType) ? value.artifactType : "failed_rows",
    adapter: { id: "manual_excel_v1", version: 1, verified: false },
    summary,
    documentGroupStatuses,
    expiresAt: value.expiresAt instanceof Date ? value.expiresAt.toISOString() : null,
  };
}

function issueResponse(issue) {
  const value = plain(issue) || {};
  const locator = plain(value.normalizedLocator) || {};
  const resolution = plain(value.resolution) || {};
  return {
    _id: value._id ? String(value._id) : "",
    issueKey: primitiveCell(value.issueKey, 256) || "",
    artifactRowNumber: Number.isSafeInteger(value.artifactRowNumber) && value.artifactRowNumber >= 1
      ? value.artifactRowNumber
      : null,
    technicalMessage: primitiveCell(value.technicalMessage, 1000) || "",
    normalizedLocator: {
      sourceRowNumber: Number.isSafeInteger(locator.sourceRowNumber) && locator.sourceRowNumber >= 1
        ? locator.sourceRowNumber
        : null,
      documentNumber: primitiveCell(locator.documentNumber, 256) || "",
      invoiceNumber: primitiveCell(locator.invoiceNumber, 256) || "",
      invoiceSymbol: primitiveCell(locator.invoiceSymbol, 256) || "",
      documentDate: primitiveCell(locator.documentDate, 64) || "",
      partnerCode: primitiveCell(locator.partnerCode, 256) || "",
      itemCode: primitiveCell(locator.itemCode, 256) || "",
      amount: primitiveCell(locator.amount, 128) || "",
      lineFingerprint: /^[a-f0-9]{64}$/.test(String(locator.lineFingerprint || "").toLowerCase())
        ? String(locator.lineFingerprint).toLowerCase()
        : null,
    },
    category: primitiveCell(value.category, 128) || "",
    severity: primitiveCell(value.severity, 32) || "",
    candidates: (value.candidates || []).slice(0, MAX_CANDIDATES).map((candidateValue) => {
      const candidate = plain(candidateValue) || {};
      return {
        documentGroupId: primitiveCell(candidate.documentGroupId, 256) || "",
        method: primitiveCell(candidate.method, 128) || "",
        evidence: primitiveCell(candidate.evidence, 4096) || "",
      };
    }),
    matchStatus: MATCH_STATUSES.includes(value.matchStatus) ? value.matchStatus : "unmatched",
    confirmedDocumentGroupId: primitiveCell(value.confirmedDocumentGroupId, 256) || "",
    userConfirmedMatch: value.userConfirmedMatch === true,
    confirmedBy: value.confirmedBy ? String(value.confirmedBy) : null,
    confirmedAt: value.confirmedAt instanceof Date ? value.confirmedAt.toISOString() : null,
    resolution: {
      status: RESOLUTION_STATUSES.includes(resolution.status) ? resolution.status : "unresolved",
      scope: RESOLUTION_SCOPES.includes(resolution.scope) ? resolution.scope : "once",
      patch: sanitizeRepairPayload(resolution.patch),
      resolvedBy: resolution.resolvedBy ? String(resolution.resolvedBy) : null,
      resolvedAt: resolution.resolvedAt instanceof Date ? resolution.resolvedAt.toISOString() : null,
    },
    expiresAt: value.expiresAt instanceof Date ? value.expiresAt.toISOString() : null,
    createdAt: value.createdAt instanceof Date ? value.createdAt.toISOString() : null,
    updatedAt: value.updatedAt instanceof Date ? value.updatedAt.toISOString() : null,
  };
}

function invalidConverterResponse() {
  return repairError(502, "Converter trả về phản hồi không hợp lệ", "INVALID_CONVERTER_RESPONSE");
}

function validateInspectionPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidConverterResponse();
  }
  const adapter = payload.adapter;
  if (
    !adapter ||
    adapter.id !== "manual_excel_v1" ||
    adapter.verified !== false ||
    payload.status !== "needs_schema_mapping" ||
    payload.artifact_type !== "unknown" ||
    typeof payload.sheet_name !== "string" ||
    !payload.sheet_name.trim() ||
    !Number.isSafeInteger(payload.header_row) ||
    payload.header_row < 1 ||
    !Array.isArray(payload.headers) ||
    payload.headers.length === 0 ||
    !payload.headers.every((header) => typeof header === "string" && header.trim()) ||
    (payload.sample_rows != null && !Array.isArray(payload.sample_rows)) ||
    (payload.warnings != null && !Array.isArray(payload.warnings)) ||
    (payload.candidates != null && !Array.isArray(payload.candidates))
  ) {
    throw invalidConverterResponse();
  }
  return payload;
}

function validateNormalizedIssuesPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.issues)) {
    throw invalidConverterResponse();
  }
  for (const issue of payload.issues) {
    if (
      !issue ||
      typeof issue !== "object" ||
      Array.isArray(issue) ||
      typeof issue.issue_key !== "string" ||
      !issue.issue_key.trim() ||
      !Number.isSafeInteger(issue.artifact_row_number) ||
      issue.artifact_row_number < 1 ||
      typeof issue.technical_message !== "string" ||
      !issue.technical_message.trim() ||
      !issue.locator ||
      typeof issue.locator !== "object" ||
      Array.isArray(issue.locator) ||
      typeof issue.category !== "string" ||
      !["blocker", "warning", "info"].includes(issue.severity)
    ) {
      throw invalidConverterResponse();
    }
  }
  if (payload.requires_user_confirmation !== true || payload.retry_allowed !== false) {
    throw invalidConverterResponse();
  }
  return payload.issues;
}

function normalizeImportResultColumns(columns) {
  if (!columns || typeof columns !== "object" || Array.isArray(columns)) {
    throw repairError(422, "Schema mapping không hợp lệ", "INVALID_SCHEMA_MAPPING");
  }
  const normalized = {};
  const selectedHeaders = new Set();
  for (const [role, header] of Object.entries(columns)) {
    if (!IMPORT_RESULT_COLUMN_ROLES.has(role) || (header != null && typeof header !== "string")) {
      throw repairError(422, "Schema mapping không hợp lệ", "INVALID_SCHEMA_MAPPING");
    }
    const value = strictText(header, 256, role, "INVALID_SCHEMA_MAPPING");
    if (!value) continue;
    if (selectedHeaders.has(value)) {
      throw repairError(422, "Mỗi cột chỉ được map cho một vai trò", "INVALID_SCHEMA_MAPPING");
    }
    selectedHeaders.add(value);
    normalized[role] = value;
  }
  if (!normalized.technical_message) {
    throw repairError(422, "Schema mapping bắt buộc technical_message", "INVALID_SCHEMA_MAPPING");
  }
  return normalized;
}

function parseInspection(payload) {
  const value = sanitizeInspectionPayload(validateInspectionPayload(payload));
  return {
    sheetName: text(value.sheet_name || value.sheetName, 128),
    headerRow: Number(value.header_row || value.headerRow) || null,
    headers: Array.isArray(value.headers) ? value.headers.slice(0, 100) : [],
    sampleRows: Array.isArray(value.sample_rows || value.sampleRows)
      ? (value.sample_rows || value.sampleRows).slice(0, 20)
      : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 100) : [],
    candidates: Array.isArray(value.candidates) ? value.candidates.slice(0, 20) : [],
    selectionAmbiguous: value.selection_ambiguous === true || value.selectionAmbiguous === true,
  };
}

function upstreamFailure(result, fallbackStatus) {
  const status = Number(result?.status) || 502;
  const message = text(result?.data?.detail || result?.data?.message || "Converter không thể xử lý yêu cầu", 512);
  if (status === 504) throw repairError(503, "Converter phản hồi quá thời gian", "CONVERTER_TIMEOUT");
  if (status === 422 && fallbackStatus) throw repairError(fallbackStatus, message, "INVALID_IMPORT_WORKBOOK");
  throw repairError(status >= 500 ? 503 : status, message, "CONVERTER_REJECTED");
}

function ownershipFilter(repair, userId) {
  return {
    _id: repair._id,
    user: userId,
    workspace: repair.workspace || null,
    ownerScope: repair.ownerScope,
  };
}

function issueOwnershipFilter(repair) {
  return {
    repairSession: repair._id,
    workspace: repair.workspace || null,
    ownerScope: repair.ownerScope,
  };
}

function encodeWorkspaceCursor(kind, value, version) {
  return Buffer.from(JSON.stringify({ kind, value: String(value), version })).toString("base64url");
}

function decodeWorkspaceCursor(cursor, kind, version, { objectIdValue = false } = {}) {
  if (!cursor) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    throw repairError(422, "cursor không hợp lệ", "INVALID_CURSOR");
  }
  if (
    !decoded ||
    decoded.kind !== kind ||
    decoded.version !== version ||
    typeof decoded.value !== "string" ||
    !decoded.value
  ) {
    throw repairError(
      decoded?.version !== version ? 409 : 422,
      decoded?.version !== version ? "Repair session đã thay đổi trong khi phân trang" : "cursor không hợp lệ",
      decoded?.version !== version ? "STALE_REPAIR_VERSION" : "INVALID_CURSOR",
    );
  }
  if (objectIdValue && !mongoose.isValidObjectId(decoded.value)) {
    throw repairError(422, "cursor không hợp lệ", "INVALID_CURSOR");
  }
  return decoded.value;
}

function activeIssueFilter(repair) {
  return {
    ...issueOwnershipFilter(repair),
    schemaGenerationId: repair.activeSchemaGenerationId || null,
  };
}

function isUnsupportedTransaction(error) {
  const message = String(error?.message || "");
  return Number(error?.code) === 20 &&
    /transaction numbers are only allowed|replica set member or mongos|transactions are not supported/i.test(message);
}

async function runAtomicMutation(startSession, transactional, standalone) {
  if (typeof startSession !== "function") return standalone();
  let session;
  try {
    session = await startSession();
    let result;
    await session.withTransaction(async () => {
      result = await transactional(session);
    });
    return result;
  } catch (error) {
    if (isUnsupportedTransaction(error)) return standalone();
    throw error;
  } finally {
    if (session) await session.endSession();
  }
}

function rollbackFailure(message, cause) {
  const error = repairError(500, message, "REPAIR_ROLLBACK_FAILED");
  error.cause = cause;
  return error;
}

function createMisaImportRepairService(overrides = {}) {
  const usesInjectedPersistence = Boolean(overrides.RepairSession || overrides.Issue);
  const deps = {
    Run: ConversionRun,
    Workspace: AccountingWorkspace,
    RepairSession: MisaImportRepairSession,
    HumanConfirmation: MisaImportRepairConfirmation,
    Issue: MisaImportIssue,
    RetryBatch: MisaRetryBatch,
    artifacts: conversionArtifacts,
    forwardBinary,
    forwardJson,
    forwardMultipart,
    createToken: createConversionContextToken,
    now: () => new Date(),
    startSession: usesInjectedPersistence ? null : () => mongoose.startSession(),
    ...overrides,
  };

  function normalizeConfirmationAction(value) {
    const action = strictText(value, 64, "confirmation action", "INVALID_CONFIRMATION_ACTION");
    if (!HUMAN_CONFIRMATION_ACTIONS.includes(action)) {
      throw repairError(422, "confirmation action không hợp lệ", "INVALID_CONFIRMATION_ACTION");
    }
    return action;
  }

  function suppliedConfirmationToken(body, token) {
    const supplied = strictText(
      token || body?.human_confirmation_token || body?.humanConfirmationToken,
      512,
      "human confirmation token",
      "HUMAN_CONFIRMATION_REQUIRED",
    );
    if (!supplied) {
      throw repairError(403, "Human confirmation token là bắt buộc", "HUMAN_CONFIRMATION_REQUIRED");
    }
    return supplied;
  }

  function trustedStateCommitment(repair) {
    return {
      repair_session_id: String(repair._id),
      operation_session_id: text(repair.operationSessionId, 256),
      manifest_sha256: text(repair.manifestSha256, 64).toLowerCase(),
      template_hash: text(repair.templateHash, 64).toLowerCase(),
      raw_file_hash: text(repair.rawFileHash, 64).toLowerCase(),
      active_schema_generation_id: text(repair.activeSchemaGenerationId, 256),
    };
  }

  function basicConfirmationPayload({ action, repair, body, issueId, groupId }) {
    const expected = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    const state = trustedStateCommitment(repair);
    if (action === "confirm_match") {
      return {
        action,
        expected_version: expected,
        issue_id: objectId(issueId || body?.issue_id || body?.issueId, "Issue", "ISSUE_NOT_FOUND"),
        document_group_id: strictText(
          body?.document_group_id || body?.documentGroupId,
          256,
          "document_group_id",
          "INVALID_MATCH",
        ),
        trusted_state_hash: hashCanonical(state),
      };
    }
    if (action === "set_import_status") {
      return {
        action,
        expected_version: expected,
        document_group_id: strictText(groupId || body?.document_group_id || body?.documentGroupId, 256, "document_group_id", "GROUP_NOT_FOUND"),
        status: strictText(body?.status || body?.import_status, 32, "import status", "INVALID_IMPORT_STATUS").toLowerCase(),
        confirmation: strictText(body?.confirmation, 128, "confirmation", "IMPORT_STATUS_CONFIRMATION_REQUIRED"),
        trusted_state_hash: hashCanonical(state),
      };
    }
    if (action === "resolve_issue") {
      const scope = strictText(body?.scope || "once", 64, "resolution scope", "INVALID_RESOLUTION_SCOPE");
      if (!RESOLUTION_SCOPES.includes(scope)) {
        throw repairError(422, "Resolution scope không hợp lệ", "INVALID_RESOLUTION_SCOPE");
      }
      return {
        action,
        expected_version: expected,
        issue_id: objectId(issueId || body?.issue_id || body?.issueId, "Issue", "ISSUE_NOT_FOUND"),
        scope,
        patch: validateResolutionPatch({ patch: body.patch }),
        acknowledge_warnings: warningAcknowledgement(body),
        trusted_state_hash: hashCanonical(state),
      };
    }
    if (action === "bulk_apply") {
      const issueIds = selectedIssueIds(body?.issue_ids || body?.issueIds).sort();
      const scope = strictText(body?.scope || "once", 64, "resolution scope", "INVALID_RESOLUTION_SCOPE");
      if (!RESOLUTION_SCOPES.includes(scope)) {
        throw repairError(422, "Resolution scope không hợp lệ", "INVALID_RESOLUTION_SCOPE");
      }
      const simulationHashValue = strictText(
        body?.simulation_hash || body?.simulationHash,
        64,
        "simulation_hash",
        "SIMULATION_HASH_MISMATCH",
      ).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(simulationHashValue)) {
        throw repairError(409, "simulation_hash không hợp lệ", "SIMULATION_HASH_MISMATCH");
      }
      return {
        action,
        expected_version: expected,
        issue_ids: issueIds,
        scope,
        patch: validateResolutionPatch({ patch: body.patch }),
        simulation_hash: simulationHashValue,
        acknowledge_warnings: warningAcknowledgement(body),
        trusted_state_hash: hashCanonical(state),
      };
    }
    throw repairError(422, "confirmation action không hỗ trợ payload này", "INVALID_CONFIRMATION_ACTION");
  }

  function retryManifestCommitment(manifest) {
    return {
      schema_version: manifest.schema_version,
      conversion_id: manifest.conversion_id,
      target_template_id: manifest.target_template_id,
      template_hash: manifest.template_hash,
      raw_file_hash: manifest.raw_file_hash,
      mapping_profile_id: manifest.mapping_profile_id,
      mapping_profile_version: manifest.mapping_profile_version,
      mapping_profile_state_hash: manifest.mapping_profile_state_hash,
      validation_ruleset_version: manifest.validation_ruleset_version,
    };
  }

  function invalidRetryAlias(label) {
    throw repairError(422, `${label} aliases không khớp`, "INVALID_RETRY_PAYLOAD");
  }

  function normalizeRetryGroups(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_ISSUES) {
      throw repairError(422, "document_group_ids không hợp lệ", "INVALID_RETRY_GROUPS");
    }
    const normalized = value.map((item) => strictText(item, 256, "document_group_id", "INVALID_RETRY_GROUPS"));
    if (normalized.some((item) => !item) || new Set(normalized).size !== normalized.length) {
      throw repairError(422, "document_group_ids trống hoặc trùng lặp", "INVALID_RETRY_GROUPS");
    }
    return normalized.sort();
  }

  async function canonicalRetryRequest({ repair, userId, body, expected }) {
    const snakeGroups = body?.document_group_ids;
    const camelGroups = body?.documentGroupIds;
    const normalizedSnakeGroups = snakeGroups === undefined ? null : normalizeRetryGroups(snakeGroups);
    const normalizedCamelGroups = camelGroups === undefined ? null : normalizeRetryGroups(camelGroups);
    if (
      normalizedSnakeGroups &&
      normalizedCamelGroups &&
      canonicalJson(normalizedSnakeGroups) !== canonicalJson(normalizedCamelGroups)
    ) {
      invalidRetryAlias("document_group_ids");
    }
    const normalizedGroups = normalizedSnakeGroups || normalizedCamelGroups;
    if (!normalizedGroups) {
      throw repairError(422, "document_group_ids không hợp lệ", "INVALID_RETRY_GROUPS");
    }
    const snakeExpected = body?.expected_version;
    const camelExpected = body?.expectedVersion;
    if (
      snakeExpected !== undefined &&
      camelExpected !== undefined &&
      expectedVersion(snakeExpected) !== expectedVersion(camelExpected)
    ) {
      invalidRetryAlias("expected_version");
    }
    const snakeAcknowledgement = body?.acknowledge_warnings;
    const camelAcknowledgement = body?.acknowledgeWarnings;
    for (const value of [snakeAcknowledgement, camelAcknowledgement]) {
      if (value !== undefined && typeof value !== "boolean") {
        throw repairError(422, "acknowledge_warnings phải là boolean", "INVALID_RETRY_PAYLOAD");
      }
    }
    if (
      snakeAcknowledgement !== undefined &&
      camelAcknowledgement !== undefined &&
      snakeAcknowledgement !== camelAcknowledgement
    ) {
      invalidRetryAlias("acknowledge_warnings");
    }
    const acknowledgeWarnings = snakeAcknowledgement ?? camelAcknowledgement ?? false;
    const readinessHash = retryReadinessHash(body);
    const completeGroups = (repair.documentGroupStatuses || [])
      .map(plain)
      .sort((left, right) => String(left.documentGroupId).localeCompare(String(right.documentGroupId)));
    if (
      completeGroups.length === 0 ||
      completeGroups.some((group) =>
        !["failed", "imported"].includes(String(group.status)) || group.userConfirmed !== true)
    ) {
      throw repairError(409, "Còn document group chưa xác nhận trạng thái", "RETRY_STATUS_BLOCKED");
    }
    const failedGroupIds = completeGroups
      .filter((group) => group.status === "failed")
      .map((group) => String(group.documentGroupId))
      .sort();
    if (canonicalJson(normalizedGroups) !== canonicalJson(failedGroupIds)) {
      throw repairError(409, "Retry phải gồm đúng các document group thất bại", "RETRY_STATUS_BLOCKED");
    }
    const documentGroupStatuses = Object.fromEntries(
      completeGroups.map((group) => [String(group.documentGroupId), String(group.status)]),
    );
    const statusByGroup = new Map(completeGroups.map((item) => [String(item.documentGroupId), item]));
    const groups = normalizedGroups.map((groupId) => {
      const group = statusByGroup.get(groupId);
      if (!group) throw repairError(409, "Document group bị thiếu trạng thái", "RETRY_STATUS_BLOCKED");
      return group;
    });
    const trusted = await trustedRepairScope(repair, userId);
    const issues = await allActiveIssues(repair);
    const selectedSet = new Set(normalizedGroups);
    const effectiveResolutions = issues
      .filter((issue) => selectedSet.has(String(issue.confirmedDocumentGroupId)))
      .map((issue) => ({
        issue_id: String(issue._id),
        patch: converterPatch(issue, null, trusted.manifestResult.manifest),
      }))
      .sort((left, right) => left.issue_id.localeCompare(right.issue_id));
    const manifestBinding = retryManifestCommitment(trusted.manifestResult.manifest);
    const state = {
      ...trustedStateCommitment(repair),
      manifest_sha256: text(trusted.manifestResult.stored.metadata.sha256, 64).toLowerCase(),
      manifest_binding: manifestBinding,
      effective_resolutions: effectiveResolutions,
    };
    const canonical = {
      action: "retry_export",
      expected_version: expected,
      selected_document_group_ids: normalizedGroups,
      document_group_statuses: documentGroupStatuses,
      acknowledge_warnings: acknowledgeWarnings,
      ...(readinessHash ? { readiness_hash: readinessHash } : {}),
      effective_resolutions: effectiveResolutions,
      trusted_manifest: manifestBinding,
      trusted_state_hash: hashCanonical(state),
    };
    return {
      canonical,
      requestFingerprint: hashCanonical(canonical),
      groups,
      trusted,
      patches: effectiveResolutions.map((item) => item.patch),
    };
  }

  async function canonicalConfirmationPayload({ action, repair, userId, body, issueId, groupId }) {
    const normalizedAction = normalizeConfirmationAction(action);
    if (normalizedAction !== "retry_export") {
      const canonical = basicConfirmationPayload({
        action: normalizedAction,
        repair,
        body,
        issueId,
        groupId,
      });
      return { canonical, requestFingerprint: hashCanonical(canonical) };
    }
    const expected = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    return canonicalRetryRequest({ repair, userId, body, expected });
  }

  async function issueHumanConfirmation({ userId, repairId, action, body, issueId, groupId, requestId }) {
    const repair = await loadRepair(repairId, userId);
    const normalizedAction = normalizeConfirmationAction(action);
    const requestedVersion = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    if (repair.version !== requestedVersion) {
      throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    }
    const canonical = await canonicalConfirmationPayload({
      action: normalizedAction,
      repair,
      userId,
      body: body || {},
      issueId,
      groupId,
    });
    if (normalizedAction === "retry_export") {
      const suppliedHash = retryReadinessHash(body, { required: true });
      const preflight = await retryPreflight({
        repair,
        canonical,
        acknowledgeWarnings: canonical.canonical.acknowledge_warnings,
        requestId,
      });
      assertCurrentReadinessHash(suppliedHash, preflight.response.hash);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const now = deps.now();
    const confirmation = new deps.HumanConfirmation({
      repairSession: repair._id,
      user: userId,
      workspace: repair.workspace || null,
      ownerScope: repair.ownerScope,
      action: normalizedAction,
      payloadHash: canonical.requestFingerprint,
      sessionVersion: requestedVersion,
      tokenHash: sha256(Buffer.from(token, "utf8")),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + HUMAN_CONFIRMATION_TTL_MS),
    });
    await confirmation.save();
    return {
      token,
      action: normalizedAction,
      payloadHash: canonical.requestFingerprint,
      expiresAt: confirmation.expiresAt,
    };
  }

  async function consumeHumanConfirmation({ userId, repair, action, payloadHash, body, token }) {
    const supplied = suppliedConfirmationToken(body, token);
    const consumed = await deps.HumanConfirmation.findOneAndUpdate(
      {
        repairSession: repair._id,
        user: userId,
        workspace: repair.workspace || null,
        ownerScope: repair.ownerScope,
        action: normalizeConfirmationAction(action),
        payloadHash,
        sessionVersion: repair.version,
        tokenHash: sha256(Buffer.from(supplied, "utf8")),
        consumedAt: null,
        expiresAt: { $gt: deps.now() },
      },
      { $set: { consumedAt: deps.now() } },
      { new: true },
    );
    if (!consumed) {
      throw repairError(403, "Human confirmation token không hợp lệ, đã dùng hoặc hết hạn", "HUMAN_CONFIRMATION_REQUIRED");
    }
    return consumed;
  }

  async function recoverStaleMutation(repair, userId) {
    const mutationId = text(repair.pendingMutationId, 256);
    if (!mutationId) return repair;
    const startedAt = new Date(repair.pendingMutationStartedAt);
    const leaseMs = 2 * 60 * 1000;
    const isRecovering = Boolean(text(repair.pendingRecoveryId, 256));
    if (!isRecovering && (!Number.isFinite(startedAt.getTime()) || deps.now() - startedAt < leaseMs)) {
      throw repairError(409, "Repair session đang được cập nhật", "REPAIR_MUTATION_IN_PROGRESS");
    }
    const recoveryId = text(repair.pendingRecoveryId, 256) || crypto.randomUUID();
    if (!isRecovering) {
      const claimed = await deps.RepairSession.findOneAndUpdate(
        {
          ...ownershipFilter(repair, userId),
          version: repair.version,
          pendingMutationId: mutationId,
          pendingRecoveryId: null,
        },
        { $set: { pendingRecoveryId: recoveryId } },
        { new: true },
      );
      if (!claimed) {
        throw repairError(409, "Repair session đang được cập nhật", "REPAIR_MUTATION_IN_PROGRESS");
      }
    }

    if (repair.pendingMutationType === "schema") {
      await deps.Issue.deleteMany({
        ...issueOwnershipFilter(repair),
        schemaGenerationId: mutationId,
      });
    } else if (repair.pendingMutationType === "confirm" && mutationId.startsWith("resolution:")) {
      const pendingIssues = await deps.Issue.find({
        ...activeIssueFilter(repair),
        mutationId,
      });
      for (const pendingIssue of pendingIssues || []) {
        const rolledBack = await deps.Issue.findOneAndUpdate(
          { _id: pendingIssue._id, ...activeIssueFilter(repair), mutationId },
          {
            $set: {
            resolution: plain(pendingIssue.mutationPreviousResolution) || {
              status: "unresolved", scope: "once", patch: null,
            },
            mutationId: null,
            mutationPreviousMatchStatus: null,
            mutationPreviousResolution: null,
            },
          },
          { new: true },
        );
        if (!rolledBack) {
          throw rollbackFailure("Không thể rollback issue resolution", new Error("pending issue changed"));
        }
      }
    } else if (repair.pendingMutationType === "confirm" && mutationId.startsWith("retry:")) {
      const pendingBatch = await deps.RetryBatch.findOne({
        repairSession: repair._id,
        ownerScope: repair.ownerScope,
        workspace: repair.workspace || null,
        mutationId,
      });
      if (pendingBatch) {
        const sequence = Number(pendingBatch.readinessSummary?.sequence);
        const run = await deps.Run.findOne({ _id: repair.conversionRun, user: userId });
        try {
          if (Number.isSafeInteger(sequence) && sequence > 0 && run) {
            try {
              await deps.artifacts.deleteArtifact({
                sessionId: String(repair._id),
                runId: String(repair.conversionRun),
                ownerScope: repair.ownerScope,
                userId,
                workspaceId: repair.workspace ? String(repair.workspace?._id || repair.workspace) : null,
                uploadId: text(run.converterUploadId, 256),
                targetTemplateId: text(repair.targetTemplateId, 256),
                kind: "retry_output",
                revision: sequence,
              });
            } catch (error) {
              if (![404, 410].includes(Number(error?.statusCode))) throw error;
            }
          }
          await deps.RetryBatch.deleteOne({ _id: pendingBatch._id, mutationId });
        } catch (error) {
          if (typeof deps.RetryBatch.findOneAndUpdate === "function") {
            await deps.RetryBatch.findOneAndUpdate(
              { _id: pendingBatch._id, mutationId },
              {
                $set: {
                  status: "failed",
                  recoveryState: "cleanup_required",
                  recoveryError: String(error?.message || error),
                },
              },
              { new: true },
            );
          }
          throw rollbackFailure("Không thể reconcile retry mutation", error);
        }
      }
    } else if (repair.pendingMutationType === "confirm") {
      const pendingIssue = await deps.Issue.findOne({
        ...activeIssueFilter(repair),
        mutationId,
      });
      if (pendingIssue) {
        const previousStatus = String(pendingIssue.mutationPreviousMatchStatus || "");
        if (!["suggested", "ambiguous", "unmatched"].includes(previousStatus)) {
          throw rollbackFailure("Không thể xác định trạng thái match trước mutation", new Error("missing previous status"));
        }
        const rolledBack = await deps.Issue.findOneAndUpdate(
          { _id: pendingIssue._id, ...activeIssueFilter(repair), mutationId },
          { $set: {
            matchStatus: previousStatus,
            confirmedDocumentGroupId: "",
            userConfirmedMatch: false,
            confirmedBy: null,
            confirmedAt: null,
            mutationId: null,
            mutationPreviousMatchStatus: null,
          } },
          { new: true },
        );
        if (!rolledBack) {
          throw rollbackFailure("Không thể rollback match confirmation", new Error("pending issue changed"));
        }
      }
    } else {
      throw rollbackFailure("Mutation type không hợp lệ", new Error("unknown pending mutation"));
    }

    const released = await deps.RepairSession.findOneAndUpdate(
      {
        ...ownershipFilter(repair, userId),
        version: repair.version,
        pendingMutationId: mutationId,
        pendingRecoveryId: recoveryId,
      },
      { $unset: {
        pendingMutationId: 1,
        pendingMutationType: 1,
        pendingMutationStartedAt: 1,
        pendingRecoveryId: 1,
      } },
      { new: true },
    );
    if (!released) {
      throw rollbackFailure("Không thể hoàn tất mutation recovery", new Error("recovery ownership changed"));
    }
    return released;
  }

  async function loadRepair(repairId, userId) {
    if (!mongoose.isValidObjectId(String(repairId || ""))) {
      throw repairError(404, "Repair session không tồn tại", "REPAIR_NOT_FOUND");
    }
    const repair = await deps.RepairSession.findOne({ _id: repairId, user: userId });
    if (!repair) throw repairError(404, "Repair session không tồn tại", "REPAIR_NOT_FOUND");
    const workspaceId = repair.workspace ? String(repair.workspace?._id || repair.workspace) : null;
    if (workspaceId) {
      const workspace = await deps.Workspace.findOne({ _id: workspaceId, isActive: true });
      if (!workspace || !userCanAccessWorkspace(workspace, userId)) {
        throw repairError(404, "Repair session không tồn tại", "REPAIR_NOT_FOUND");
      }
      if (
        repair.ownerScope !== `workspace:${workspaceId}` ||
        String(repair.workspace?._id || repair.workspace) !== workspaceId
      ) {
        throw repairError(404, "Repair session không tồn tại", "REPAIR_NOT_FOUND");
      }
    } else if (repair.ownerScope && repair.ownerScope !== `user:${String(userId)}`) {
      throw repairError(404, "Repair session không tồn tại", "REPAIR_NOT_FOUND");
    }
    if (new Date(repair.expiresAt) <= deps.now()) {
      throw repairError(410, "Repair session đã hết hạn", "REPAIR_EXPIRED");
    }
    return recoverStaleMutation(repair, userId);
  }

  async function createSession({ userId, runId, file, artifactType, idempotencyKey, requestId }) {
    if (!file?.buffer) throw repairError(400, "Thiếu file Excel", "INVALID_UPLOAD");
    if (!/\.(xls|xlsx)$/i.test(text(file.originalname, 255))) {
      throw repairError(400, "Chỉ hỗ trợ file .xls hoặc .xlsx", "INVALID_UPLOAD");
    }
    if (!["precheck_result", "failed_rows", "unrecognized"].includes(artifactType)) {
      throw repairError(422, "artifactType không hợp lệ", "INVALID_ARTIFACT_TYPE");
    }
    const scope = await loadOwnedRun({ Run: deps.Run, Workspace: deps.Workspace, runId, userId });
    const manifestResult = await loadManifest({
      artifacts: deps.artifacts,
      run: scope.run,
      ownerScope: scope.ownerScope,
      userId,
      now: deps.now,
    });
    const outputArtifact = await assertOutputArtifact({
      artifacts: deps.artifacts,
      run: scope.run,
      ownerScope: scope.ownerScope,
      userId,
      now: deps.now,
    });

    const normalizedKey = text(idempotencyKey, 256) || undefined;
    const uploadSha256 = sha256(file.buffer);
    const requestFingerprint = createRequestFingerprint({
      conversionRunId: scope.run._id,
      artifactType,
      uploadSha256,
    });
    const idempotencyFilter = normalizedKey ? {
      user: userId,
      ownerScope: scope.ownerScope,
      idempotencyKey: normalizedKey,
    } : null;
    if (normalizedKey) {
      const existing = await deps.RepairSession.findOne(idempotencyFilter);
      if (existing) {
        assertIdempotentReplay(existing, requestFingerprint);
        return { session: existing, idempotent: true, inspection: null };
      }
    }
    const existingRunSession = await deps.RepairSession.findOne({
      conversionRun: scope.run._id,
      user: userId,
      workspace: scope.workspaceId,
      ownerScope: scope.ownerScope,
    });
    if (existingRunSession) {
      throw repairError(409, "Conversion run đã có repair session", "REPAIR_ALREADY_EXISTS");
    }

    const configuredExpiry = repairExpiry(process.env, deps.now());
    const prerequisiteExpiries = [
      manifestResult.stored?.metadata?.expiresAt,
      outputArtifact?.metadata?.expiresAt,
    ]
      .map((value) => new Date(value))
      .filter((value) => Number.isFinite(value.getTime()));
    const expiresAt = new Date(Math.min(
      configuredExpiry.getTime(),
      ...prerequisiteExpiries.map((value) => value.getTime()),
    ));
    if (expiresAt <= deps.now()) {
      throw repairError(410, "Artifact conversion không còn khả dụng", "OUTPUT_EXPIRED");
    }
    const sessionInput = {
      user: userId,
      workspace: scope.workspaceId,
      conversionRun: scope.run._id,
      ownerScope: scope.ownerScope,
      requestFingerprint,
      uploadSha256,
      operationSessionId: text(scope.run.operationSessionId, 256),
      targetTemplateId: text(scope.run.targetTemplateId, 256),
      misaProduct: "SME",
      misaVersion: text(manifestResult.manifest.misa_version, 128),
      templateHash: text(manifestResult.manifest.template_hash, 64),
      rawFileHash: text(manifestResult.manifest.raw_file_hash, 64),
      manifestArtifactKey: artifactObjectId(manifestResult.stored.metadata),
      manifestSha256: manifestResult.stored.metadata.sha256,
      artifactType,
      status: "uploaded",
      version: 1,
      expiresAt,
    };
    if (normalizedKey) sessionInput.idempotencyKey = normalizedKey;
    const session = new deps.RepairSession(sessionInput);
    const artifact = await deps.artifacts.putArtifact({
      sessionId: String(session._id),
      runId: String(scope.run._id),
      ownerScope: scope.ownerScope,
      userId,
      workspaceId: scope.workspaceId,
      uploadId: text(scope.run.converterUploadId, 256),
      targetTemplateId: text(scope.run.targetTemplateId, 256),
      kind: "import_result",
      revision: 1,
      bytes: file.buffer,
      sha256: uploadSha256,
      sizeBytes: file.buffer.length,
      mime: file.mimetype || "application/octet-stream",
      expiresAt,
    });
    session.errorArtifactKey = artifactObjectId(artifact);
    session.errorSha256 = artifact.sha256;

    async function cleanupImportArtifact() {
      try {
        await deps.artifacts.deleteArtifact({
          sessionId: String(session._id),
          runId: String(scope.run._id),
          ownerScope: scope.ownerScope,
          userId,
          workspaceId: scope.workspaceId,
          uploadId: text(scope.run.converterUploadId, 256),
          targetTemplateId: text(scope.run.targetTemplateId, 256),
          kind: "import_result",
          revision: 1,
        });
      } catch (error) {
        throw rollbackFailure("Không thể thu hồi import artifact sau lỗi", error);
      }
    }

    let result;
    try {
      const contextToken = createContextToken({
        createToken: deps.createToken,
        run: scope.run,
        userId,
        workspaceId: scope.workspaceId,
        ownerScope: scope.ownerScope,
        scopes: ["import_repair"],
      });
      result = await deps.forwardMultipart({
        path: "/api/v1/import-results/analyze",
        file,
        contextToken,
        requestId,
      });
    } catch (error) {
      await cleanupImportArtifact();
      if (isConverterTimeoutError(error)) {
        throw repairError(503, "Converter phản hồi quá thời gian", "CONVERTER_TIMEOUT");
      }
      throw error;
    }
    if (result?.status >= 400) {
      await cleanupImportArtifact();
      upstreamFailure(result, 400);
    }
    let inspection;
    try {
      inspection = parseInspection(result?.data);
    } catch (error) {
      await cleanupImportArtifact();
      throw error;
    }
    session.status = "needs_schema_mapping";
    try {
      await session.save();
    } catch (error) {
      await cleanupImportArtifact();
      if (error?.code === 11000 && idempotencyFilter) {
        const existing = await deps.RepairSession.findOne(idempotencyFilter);
        if (existing) {
          assertIdempotentReplay(existing, requestFingerprint);
          return { session: existing, idempotent: true, inspection: null };
        }
      }
      throw error;
    }
    return {
      session,
      idempotent: false,
      inspection: {
        ...inspection,
        adapter: { id: "manual_excel_v1", version: 1, verified: false },
        status: "needs_schema_mapping",
      },
    };
  }

  async function submitSchema({ userId, repairId, body, requestId }) {
    assertHumanAction(body);
    const repair = await loadRepair(repairId, userId);
    const version = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    if (repair.version !== version) throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    const sheetName = text(body?.sheet_name, 128);
    const headerRow = Number(body?.header_row);
    if (!sheetName || !Number.isSafeInteger(headerRow) || headerRow < 1) {
      throw repairError(422, "Schema mapping không hợp lệ", "INVALID_SCHEMA_MAPPING");
    }
    const columns = normalizeImportResultColumns(body?.columns);
    const scope = await loadOwnedRun({ Run: deps.Run, Workspace: deps.Workspace, runId: repair.conversionRun, userId });
    if (
      String(scope.run._id) !== String(repair.conversionRun) ||
      scope.ownerScope !== repair.ownerScope ||
      String(scope.workspaceId || "") !== String(repair.workspace?._id || repair.workspace || "")
    ) {
      throw repairError(404, "Repair session không tồn tại", "REPAIR_NOT_FOUND");
    }
    const manifestResult = await loadManifest({
      artifacts: deps.artifacts,
      run: scope.run,
      ownerScope: repair.ownerScope,
      userId,
      now: deps.now,
    });
    const { stored: artifact, binding: artifactBinding } = await getBoundArtifact({
      artifacts: deps.artifacts,
      run: { ...plain(scope.run), _id: scope.run._id, operationSessionId: String(repair._id) },
      ownerScope: repair.ownerScope,
      userId,
      kind: "import_result",
      repairId: String(repair._id),
    });
    if (
      artifactObjectId(artifact.metadata) !== String(repair.errorArtifactKey) ||
      artifact.metadata.sha256 !== repair.errorSha256
    ) {
      throw repairError(
        409,
        "Import artifact không khớp repair session",
        "IMPORT_ARTIFACT_BINDING_MISMATCH",
      );
    }
    const artifactContent = await readArtifactBuffer(
      artifact,
      artifactBinding,
      positiveByteLimit("CONVERTER_MAX_FILE_BYTES", DEFAULT_IMPORT_ARTIFACT_MAX_BYTES),
      deps.now,
    );
    const contextToken = createContextToken({
      createToken: deps.createToken,
      run: scope.run,
      userId,
      workspaceId: scope.workspaceId,
      ownerScope: repair.ownerScope,
      scopes: ["import_repair"],
    });
    let result;
    try {
      result = await deps.forwardMultipart({
        path: "/api/v1/import-results/normalize",
        file: {
          buffer: artifactContent,
          originalname: `import-result.${String(artifact.metadata.mime).includes("openxmlformats") ? "xlsx" : "xls"}`,
          mimetype: artifact.metadata.mime,
        },
        fields: { mapping_json: JSON.stringify({ sheet_name: sheetName, header_row: headerRow, columns }) },
        contextToken,
        requestId,
      });
    } catch (error) {
      if (isConverterTimeoutError(error)) {
        throw repairError(503, "Converter phản hồi quá thời gian", "CONVERTER_TIMEOUT");
      }
      throw error;
    }
    if (result?.status >= 400) upstreamFailure(result, 422);
    const normalizedIssues = validateNormalizedIssuesPayload(result?.data);
    const expiresAt = new Date(repair.expiresAt);
    const schemaGenerationId = crypto.randomUUID();
    const docs = normalizedIssues.map((issue) => ({
      ...issueDocument(issue, {
        repair,
        manifest: manifestResult.manifest,
        expiresAt,
      }),
      schemaGenerationId,
    }));
    const groups = (manifestResult.manifest.document_groups || []).map((group) => ({
      documentGroupId: text(group.document_group_id, 256),
      status: "unknown",
      userConfirmed: false,
      confirmedBy: null,
      confirmedAt: null,
      evidence: manifestGroupEvidence(group, manifestResult.manifest),
    }));
    const summary = summaryFromIssues(docs, groups);
    const issueFilter = issueOwnershipFilter(repair);
    const sessionFilter = {
      ...ownershipFilter(repair, userId),
      version,
      status: "needs_schema_mapping",
      pendingMutationId: null,
      pendingRecoveryId: null,
    };

    async function persistInTransaction(session) {
      await deps.Issue.deleteMany(issueFilter, { session });
      for (let index = 0; index < docs.length; index += ISSUE_BATCH_SIZE) {
        await deps.Issue.insertMany(
          docs.slice(index, index + ISSUE_BATCH_SIZE),
          { ordered: true, session },
        );
      }
      const updated = await deps.RepairSession.findOneAndUpdate(
        sessionFilter,
        {
          $set: {
            status: "needs_match_review",
            summary,
            documentGroupStatuses: groups,
            activeSchemaGenerationId: schemaGenerationId,
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!updated) {
        throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
      }
      return updated;
    }

    async function persistStandalone() {
      const mutationId = schemaGenerationId;
      const reserved = await deps.RepairSession.findOneAndUpdate(
        sessionFilter,
        { $set: {
          pendingMutationId: mutationId,
          pendingMutationType: "schema",
          pendingMutationStartedAt: deps.now(),
        } },
        { new: true },
      );
      if (!reserved) {
        throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
      }
      try {
        await deps.Issue.deleteMany(issueFilter);
        for (let index = 0; index < docs.length; index += ISSUE_BATCH_SIZE) {
          await deps.Issue.insertMany(docs.slice(index, index + ISSUE_BATCH_SIZE), { ordered: true });
        }
        const updated = await deps.RepairSession.findOneAndUpdate(
          {
            ...ownershipFilter(repair, userId),
            version,
            pendingMutationId: mutationId,
            pendingRecoveryId: null,
          },
          {
            $set: {
              status: "needs_match_review",
              summary,
              documentGroupStatuses: groups,
              activeSchemaGenerationId: schemaGenerationId,
            },
            $unset: {
              pendingMutationId: 1,
              pendingMutationType: 1,
              pendingMutationStartedAt: 1,
              pendingRecoveryId: 1,
            },
            $inc: { version: 1 },
          },
          { new: true },
        );
        if (!updated) {
          throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
        }
        return updated;
      } catch (error) {
        try {
          await deps.Issue.deleteMany({ ...issueFilter, schemaGenerationId });
          const released = await deps.RepairSession.findOneAndUpdate(
            {
              ...ownershipFilter(repair, userId),
              version,
              pendingMutationId: mutationId,
              pendingRecoveryId: null,
            },
            { $unset: {
              pendingMutationId: 1,
              pendingMutationType: 1,
              pendingMutationStartedAt: 1,
              pendingRecoveryId: 1,
            } },
            { new: true },
          );
          if (!released) throw new Error("schema mutation reservation changed");
        } catch (rollbackError) {
          throw rollbackFailure("Không thể rollback schema mutation", rollbackError);
        }
        throw error;
      }
    }

    const updated = await runAtomicMutation(
      deps.startSession,
      persistInTransaction,
      persistStandalone,
    );
    return { session: updated, issues: docs.map(issueResponse) };
  }

  async function readWorkspace({
    userId,
    repairId,
    status,
    cursor,
    limit,
    groupCursor,
    groupLimit,
    requestId,
  }) {
    const repair = await loadRepair(repairId, userId);
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const boundedGroupLimit = Math.min(Math.max(Number(groupLimit) || 100, 1), 100);
    const filter = activeIssueFilter(repair);
    if (status) {
      if (!["unmatched", "suggested", "ambiguous", "confirmed", "rejected"].includes(status)) {
        throw repairError(422, "status filter không hợp lệ", "INVALID_STATUS_FILTER");
      }
      filter.matchStatus = status;
    }
    if (cursor) {
      const decoded = decodeWorkspaceCursor(cursor, "issue", repair.version, { objectIdValue: true });
      filter._id = { $gt: decoded };
    }
    const issueQuery = deps.Issue.find(filter);
    const issues = typeof issueQuery?.sort === "function" && typeof issueQuery?.limit === "function"
      ? await issueQuery.sort({ _id: 1 }).limit(boundedLimit + 1)
      : (await issueQuery)
          .slice()
          .sort((left, right) => String(left?._id || "").localeCompare(String(right?._id || "")))
          .slice(0, boundedLimit + 1);
    const hasMore = issues.length > boundedLimit;
    const visible = issues.slice(0, boundedLimit);
    const allGroups = (Array.isArray(repair.documentGroupStatuses)
      ? repair.documentGroupStatuses.map(plain)
      : [])
      .sort((left, right) => String(left.documentGroupId).localeCompare(String(right.documentGroupId)));
    const decodedGroupCursor = decodeWorkspaceCursor(
      groupCursor,
      "document_group",
      repair.version,
    );
    const groupStart = decodedGroupCursor
      ? allGroups.findIndex((group) => String(group.documentGroupId) === decodedGroupCursor) + 1
      : 0;
    if (decodedGroupCursor && groupStart === 0) {
      throw repairError(422, "group cursor không hợp lệ", "INVALID_CURSOR");
    }
    const groupPage = allGroups.slice(groupStart, groupStart + boundedGroupLimit + 1);
    const hasMoreGroups = groupPage.length > boundedGroupLimit;
    const visibleGroups = groupPage.slice(0, boundedGroupLimit);
    const groupsReady = allGroups.length > 0 &&
      allGroups.every((group) =>
        ["failed", "imported"].includes(group.status) && group.userConfirmed === true);
    const failedGroups = allGroups.filter((group) => group.status === "failed");
    const issuesReady = Number(repair.summary?.unknownDocumentGroups || 0) === 0 &&
      Number(repair.summary?.ambiguousIssues || 0) === 0 &&
      Number(repair.summary?.unmatchedIssues || 0) === 0 &&
      Number(repair.summary?.unresolvedIssues || 0) === 0;
    let readiness = null;
    if (groupsReady && failedGroups.length > 0 && issuesReady && !cursor && !groupCursor) {
      const canonical = await canonicalRetryRequest({
        repair,
        userId,
        body: {
          expected_version: repair.version,
          document_group_ids: failedGroups.map((group) => String(group.documentGroupId)),
          acknowledge_warnings: false,
        },
        expected: repair.version,
      });
      readiness = (await retryPreflight({ repair, canonical, requestId })).response;
    }
    const readinessBlocked = Number(readiness?.summary?.fatal || 0) > 0 ||
      Number(readiness?.summary?.blocker || 0) > 0;
    return {
      session: sessionResponse(repair, visibleGroups),
      issues: visible.map(issueResponse),
      nextCursor: hasMore && visible.length
        ? encodeWorkspaceCursor("issue", visible[visible.length - 1]._id, repair.version)
        : null,
      documentGroups: visibleGroups.map(documentGroupResponse),
      nextGroupCursor: hasMoreGroups && visibleGroups.length
        ? encodeWorkspaceCursor(
            "document_group",
            visibleGroups[visibleGroups.length - 1].documentGroupId,
            repair.version,
          )
        : null,
      readiness,
      retryGate: {
        allowed: groupsReady && failedGroups.length > 0 && issuesReady && !readinessBlocked,
        reason: !groupsReady
          ? "Còn document group chưa xác nhận trạng thái import"
          : failedGroups.length === 0
            ? "Không có document group thất bại để retry"
          : !issuesReady
            ? "Còn issue chưa match hoặc chưa resolved"
            : readinessBlocked
              ? "Readiness còn deterministic blocker"
              : Number(readiness?.summary?.warning || 0) > 0
                ? "Cần rà soát và xác nhận readiness warnings"
                : "Sẵn sàng tạo retry export",
        requiresReadinessValidation: true,
      },
    };
  }

  async function confirmMatch({ userId, repairId, issueId, body, humanConfirmationToken }) {
    assertHumanAction(body);
    const repair = await loadRepair(repairId, userId);
    const version = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    if (repair.version !== version) throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    const documentGroupId = text(body?.document_group_id || body?.documentGroupId, 256);
    if (!documentGroupId) throw repairError(422, "document_group_id là bắt buộc", "INVALID_MATCH");
    const normalizedIssueId = objectId(issueId, "Issue", "ISSUE_NOT_FOUND");
    const issueScope = activeIssueFilter(repair);
    const issue = await deps.Issue.findOne({ _id: normalizedIssueId, ...issueScope });
    if (!issue) throw repairError(404, "Issue không tồn tại", "ISSUE_NOT_FOUND");
    if (!["suggested", "ambiguous", "unmatched"].includes(String(issue.matchStatus))) {
      throw repairError(409, "Issue không còn chờ xác nhận match", "MATCH_NOT_CONFIRMABLE");
    }
    const previousStatus = String(issue.matchStatus);
    if (
      previousStatus !== "unmatched" &&
      !(issue.candidates || []).some((candidate) => String(candidate.documentGroupId) === documentGroupId)
    ) {
      throw repairError(422, "document_group_id không thuộc candidates", "CANDIDATE_NOT_MEMBER");
    }
    if (previousStatus === "unmatched") {
      const trusted = await trustedRepairScope(repair, userId, ["import_repair"]);
      const trustedGroups = Array.isArray(trusted.manifestResult.manifest?.document_groups)
        ? trusted.manifestResult.manifest.document_groups
        : [];
      if (!trustedGroups.some((group) => String(group?.document_group_id || "") === documentGroupId)) {
        throw repairError(422, "document_group_id không thuộc manifest", "CANDIDATE_NOT_MEMBER");
      }
    }
    const confirmationPayload = await canonicalConfirmationPayload({
      action: "confirm_match",
      repair,
      userId,
      body,
      issueId,
    });
    await consumeHumanConfirmation({
      userId,
      repair,
      action: "confirm_match",
      payloadHash: confirmationPayload.requestFingerprint,
      body,
      token: humanConfirmationToken,
    });
    const summary = { ...(repair.summary?.toObject?.() || repair.summary || {}) };
    summary.confirmedIssues = Number(summary.confirmedIssues || 0) + 1;
    if (previousStatus === "ambiguous") {
      summary.ambiguousIssues = Math.max(0, Number(summary.ambiguousIssues || 0) - 1);
    }
    if (previousStatus === "unmatched") {
      summary.unmatchedIssues = Math.max(0, Number(summary.unmatchedIssues || 0) - 1);
    }
    const sessionFilter = {
      ...ownershipFilter(repair, userId),
      version,
      pendingMutationId: null,
      pendingRecoveryId: null,
    };
    const issueUpdateFilter = {
      _id: normalizedIssueId,
      ...issueScope,
      ...(previousStatus === "unmatched" ? {} : { "candidates.documentGroupId": documentGroupId }),
      matchStatus: previousStatus === "unmatched"
        ? "unmatched"
        : { $in: ["suggested", "ambiguous"] },
    };
    const confirmation = {
      matchStatus: "confirmed",
      confirmedDocumentGroupId: documentGroupId,
      userConfirmedMatch: true,
      confirmedBy: userId,
      confirmedAt: deps.now(),
    };

    async function confirmInTransaction(session) {
      const updatedIssue = await deps.Issue.findOneAndUpdate(
        issueUpdateFilter,
        { $set: confirmation },
        { new: true, session },
      );
      if (!updatedIssue) throw repairError(409, "Issue đã được cập nhật ở tab khác", "MATCH_CONFLICT");
      const updatedRepair = await deps.RepairSession.findOneAndUpdate(
        sessionFilter,
        { $set: { summary }, $inc: { version: 1 } },
        { new: true, session },
      );
      if (!updatedRepair) {
        throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
      }
      return { session: updatedRepair, issue: updatedIssue };
    }

    async function confirmStandalone() {
      const mutationId = crypto.randomUUID();
      const reserved = await deps.RepairSession.findOneAndUpdate(
        sessionFilter,
        { $set: {
          pendingMutationId: mutationId,
          pendingMutationType: "confirm",
          pendingMutationStartedAt: deps.now(),
        } },
        { new: true },
      );
      if (!reserved) {
        throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
      }
      let updatedIssue = null;
      try {
        updatedIssue = await deps.Issue.findOneAndUpdate(
          issueUpdateFilter,
          { $set: {
            ...confirmation,
            mutationId,
            mutationPreviousMatchStatus: previousStatus,
          } },
          { new: true },
        );
        if (!updatedIssue) throw repairError(409, "Issue đã được cập nhật ở tab khác", "MATCH_CONFLICT");
        const updatedRepair = await deps.RepairSession.findOneAndUpdate(
          {
            ...ownershipFilter(repair, userId),
            version,
            pendingMutationId: mutationId,
            pendingRecoveryId: null,
          },
          {
            $set: { summary },
            $unset: {
              pendingMutationId: 1,
              pendingMutationType: 1,
              pendingMutationStartedAt: 1,
              pendingRecoveryId: 1,
            },
            $inc: { version: 1 },
          },
          { new: true },
        );
        if (!updatedRepair) {
          throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
        }
        return { session: updatedRepair, issue: updatedIssue };
      } catch (error) {
        try {
          if (updatedIssue) {
            const rolledBackIssue = await deps.Issue.findOneAndUpdate(
              { _id: normalizedIssueId, ...issueScope, mutationId },
              { $set: {
                matchStatus: previousStatus,
                confirmedDocumentGroupId: issue.confirmedDocumentGroupId || "",
                userConfirmedMatch: issue.userConfirmedMatch === true,
                confirmedBy: issue.confirmedBy || null,
                confirmedAt: issue.confirmedAt || null,
                mutationId: issue.mutationId || null,
                mutationPreviousMatchStatus: null,
              } },
              { new: true },
            );
            if (!rolledBackIssue) throw new Error("confirmed issue changed before rollback");
          }
          const released = await deps.RepairSession.findOneAndUpdate(
            {
              ...ownershipFilter(repair, userId),
              version,
              pendingMutationId: mutationId,
              pendingRecoveryId: null,
            },
            { $unset: {
              pendingMutationId: 1,
              pendingMutationType: 1,
              pendingMutationStartedAt: 1,
              pendingRecoveryId: 1,
            } },
            { new: true },
          );
          if (!released) throw new Error("confirmation reservation changed");
        } catch (rollbackError) {
          throw rollbackFailure("Không thể rollback match confirmation", rollbackError);
        }
        throw error;
      }
    }

    const result = await runAtomicMutation(
      deps.startSession,
      confirmInTransaction,
      confirmStandalone,
    );
    return { session: result.session, issue: issueResponse(result.issue) };
  }

  async function setImportStatus({ userId, repairId, groupId, body, humanConfirmationToken }) {
    assertHumanAction(body);
    const repair = await loadRepair(repairId, userId);
    const version = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    if (repair.version !== version) throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    const status = text(body?.status || body?.import_status, 32).toLowerCase();
    if (!IMPORT_STATUSES.includes(status)) throw repairError(422, "import status không hợp lệ", "INVALID_IMPORT_STATUS");
    const documentGroupId = text(groupId, 256);
    const existing = (repair.documentGroupStatuses || []).map(plain);
    const group = existing.find((item) => String(item.documentGroupId) === documentGroupId);
    if (!group) throw repairError(404, "Document group không thuộc repair session", "GROUP_NOT_FOUND");
    if (status === "failed" && body?.confirmation !== "entire_document_not_imported") {
      throw repairError(422, "Cần xác nhận toàn bộ chứng từ chưa được MISA nhập", "IMPORT_STATUS_CONFIRMATION_REQUIRED");
    }
    const confirmation = await canonicalConfirmationPayload({
      action: "set_import_status",
      repair,
      userId,
      body,
      groupId: documentGroupId,
    });
    await consumeHumanConfirmation({
      userId,
      repair,
      action: "set_import_status",
      payloadHash: confirmation.requestFingerprint,
      body,
      token: humanConfirmationToken,
    });
    const statuses = existing.map((item) => String(item.documentGroupId) === documentGroupId
      ? {
          ...item,
          status,
          userConfirmed: status === "failed" || status === "imported",
          confirmedBy: userId,
          confirmedAt: deps.now(),
        }
      : item);
    const summary = summaryFromIssues([], statuses);
    summary.totalIssues = Number(repair.summary?.totalIssues || 0);
    summary.unmatchedIssues = Number(repair.summary?.unmatchedIssues || 0);
    summary.ambiguousIssues = Number(repair.summary?.ambiguousIssues || 0);
    summary.confirmedIssues = Number(repair.summary?.confirmedIssues || 0);
    summary.unresolvedIssues = Number(repair.summary?.unresolvedIssues || 0);
    const updated = await deps.RepairSession.findOneAndUpdate(
      { ...ownershipFilter(repair, userId), version, pendingMutationId: null, pendingRecoveryId: null },
      { $set: { documentGroupStatuses: statuses, summary }, $inc: { version: 1 } },
      { new: true },
    );
    if (!updated) throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    return { session: updated, group: statuses.find((item) => item.documentGroupId === documentGroupId) };
  }

  async function trustedRepairScope(repair, userId, scopes = ["export"]) {
    const scope = await loadOwnedRun({
      Run: deps.Run,
      Workspace: deps.Workspace,
      runId: repair.conversionRun,
      userId,
    });
    if (
      String(scope.run._id) !== String(repair.conversionRun) ||
      scope.ownerScope !== repair.ownerScope ||
      String(scope.workspaceId || "") !== String(repair.workspace?._id || repair.workspace || "")
    ) {
      throw repairError(404, "Repair session không tồn tại", "REPAIR_NOT_FOUND");
    }
    const manifestResult = await loadManifest({
      artifacts: deps.artifacts,
      run: scope.run,
      ownerScope: repair.ownerScope,
      userId,
      now: deps.now,
    });
    await assertOutputArtifact({
      artifacts: deps.artifacts,
      run: scope.run,
      ownerScope: repair.ownerScope,
      userId,
      now: deps.now,
    });
    const contextToken = createContextToken({
      createToken: deps.createToken,
      run: scope.run,
      userId,
      workspaceId: scope.workspaceId,
      ownerScope: repair.ownerScope,
      scopes,
    });
    return { ...scope, manifestResult, contextToken };
  }

  async function allActiveIssues(repair) {
    const issues = await deps.Issue.find(activeIssueFilter(repair));
    return Array.isArray(issues) ? issues : [];
  }

  function retryConverterBody({ repair, scope, manifest, groups, documentGroupStatuses, patches, acknowledgeWarnings }) {
    const selectedIds = groups.map((group) => String(group.documentGroupId));
    return {
      upload_id: text(scope.run.converterUploadId, 256),
      session_id: text(repair.operationSessionId, 256),
      conversion_run_id: String(scope.run._id),
      target_template_id: text(repair.targetTemplateId, 256),
      profile_id: text(manifest.mapping_profile_id, 256),
      profile_version: Number(manifest.mapping_profile_version),
      profile_state_hash: text(manifest.mapping_profile_state_hash, 64),
      manifest,
      selected_document_group_ids: selectedIds,
      confirmed_failed_group_ids: selectedIds,
      document_group_statuses: documentGroupStatuses,
      patches,
      acknowledge_warnings: acknowledgeWarnings === true,
    };
  }

  async function converterReadiness({ scope, body, requestId }) {
    let result;
    try {
      result = await deps.forwardJson({
        path: "/api/v1/import-repairs/readiness",
        body,
        contextToken: scope.contextToken,
        requestId,
      });
    } catch (error) {
      if (isConverterTimeoutError(error)) {
        throw repairError(503, "Converter phản hồi quá thời gian", "CONVERTER_TIMEOUT");
      }
      throw error;
    }
    if (Number(result?.status) >= 400) upstreamFailure(result, 422);
    return validateReadinessPayload(result?.data);
  }

  function readinessResponse({ repair, canonical, readiness }) {
    const issues = readiness.issues.map(readinessIssueResponse);
    const commitment = {
      version: Number(repair.version),
      selected_document_group_ids: canonical.canonical.selected_document_group_ids,
      document_group_statuses: canonical.canonical.document_group_statuses,
      effective_resolutions: canonical.canonical.effective_resolutions,
      trusted_state_hash: canonical.canonical.trusted_state_hash,
      status: readiness.status,
      summary: readiness.summary,
      issues,
      selected_document_group_count: readiness.selectedDocumentGroupCount,
      selected_row_count: readiness.selectedRowCount,
    };
    return {
      version: Number(repair.version),
      status: readiness.status,
      summary: readiness.summary,
      issues,
      selectedDocumentGroupCount: readiness.selectedDocumentGroupCount,
      selectedRowCount: readiness.selectedRowCount,
      hash: hashCanonical(commitment),
    };
  }

  async function retryPreflight({ repair, canonical, acknowledgeWarnings = false, requestId }) {
    const converterBody = retryConverterBody({
      repair,
      scope: canonical.trusted,
      manifest: canonical.trusted.manifestResult.manifest,
      groups: canonical.groups,
      documentGroupStatuses: canonical.canonical.document_group_statuses,
      patches: canonical.patches,
      acknowledgeWarnings,
    });
    const readiness = await converterReadiness({
      scope: canonical.trusted,
      body: converterBody,
      requestId,
    });
    return {
      converterBody,
      readiness,
      response: readinessResponse({ repair, canonical, readiness }),
    };
  }

  function assertCurrentReadinessHash(supplied, current) {
    if (
      !supplied ||
      !current ||
      supplied.length !== current.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(current))
    ) {
      throw repairError(
        409,
        "Readiness preflight đã thay đổi; cần tải và xác nhận lại",
        "STALE_READINESS_PREFLIGHT",
      );
    }
  }

  function resolutionValue({ scope, patch, userId }) {
    const now = deps.now();
    const storedPatch = { ...patch };
    if (scope !== "once") {
      storedPatch.proposal_type = scope;
      storedPatch.proposal_status = "pending";
      storedPatch.proposed_by = String(userId);
      storedPatch.proposed_at = now.toISOString();
    }
    return {
      status: "resolved",
      scope,
      patch: storedPatch,
      resolvedBy: userId,
      resolvedAt: now,
    };
  }

  async function persistResolutions({ repair, userId, version, issues, scope, patch }) {
    const summary = { ...(repair.summary?.toObject?.() || repair.summary || {}) };
    const newlyResolvedCount = issues.filter(
      (issue) => String(issue?.resolution?.status || "unresolved") === "unresolved",
    ).length;
    summary.unresolvedIssues = Math.max(
      0,
      Number(summary.unresolvedIssues || 0) - newlyResolvedCount,
    );
    const sessionFilter = {
      ...ownershipFilter(repair, userId),
      version,
      pendingMutationId: null,
      pendingRecoveryId: null,
    };

    async function updateIssues(session = null, mutationId = null) {
      const updated = [];
      for (const issue of issues) {
        const previousResolution = plain(issue.resolution) || {
          status: "unresolved", scope: "once", patch: null,
        };
        const resolution = resolutionValue({ scope, patch, userId });
        const set = { resolution };
        if (mutationId) {
          set.mutationId = mutationId;
          set.mutationPreviousMatchStatus = "confirmed";
          set.mutationPreviousResolution = previousResolution;
        }
        const result = await deps.Issue.findOneAndUpdate(
          {
            _id: issue._id,
            ...activeIssueFilter(repair),
            matchStatus: "confirmed",
            userConfirmedMatch: true,
            "resolution.status": previousResolution.status,
          },
          { $set: set },
          { new: true, ...(session ? { session } : {}) },
        );
        if (!result) throw repairError(409, "Issue đã được cập nhật ở tab khác", "RESOLUTION_CONFLICT");
        updated.push(result);
      }
      return updated;
    }

    async function transactional(session) {
      const updatedIssues = await updateIssues(session);
      const updatedRepair = await deps.RepairSession.findOneAndUpdate(
        sessionFilter,
        {
          $set: {
            summary,
            status: summary.unresolvedIssues === 0 ? "ready_for_repair" : repair.status,
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!updatedRepair) {
        throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
      }
      return { session: updatedRepair, issues: updatedIssues };
    }

    async function standalone() {
      const mutationId = `resolution:${crypto.randomUUID()}`;
      const reserved = await deps.RepairSession.findOneAndUpdate(
        sessionFilter,
        { $set: {
          pendingMutationId: mutationId,
          pendingMutationType: "confirm",
          pendingMutationStartedAt: deps.now(),
        } },
        { new: true },
      );
      if (!reserved) {
        throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
      }
      let updatedIssues = [];
      try {
        updatedIssues = await updateIssues(null, mutationId);
        const updatedRepair = await deps.RepairSession.findOneAndUpdate(
          {
            ...ownershipFilter(repair, userId),
            version,
            pendingMutationId: mutationId,
            pendingRecoveryId: null,
          },
          {
            $set: {
              summary,
              status: summary.unresolvedIssues === 0 ? "ready_for_repair" : repair.status,
            },
            $unset: {
              pendingMutationId: 1,
              pendingMutationType: 1,
              pendingMutationStartedAt: 1,
              pendingRecoveryId: 1,
            },
            $inc: { version: 1 },
          },
          { new: true },
        );
        if (!updatedRepair) {
          throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
        }
        for (const issue of updatedIssues) {
          await deps.Issue.findOneAndUpdate(
            { _id: issue._id, ...activeIssueFilter(repair), mutationId },
            { $set: {
              mutationId: null,
              mutationPreviousMatchStatus: null,
              mutationPreviousResolution: null,
            } },
            { new: true },
          );
        }
        return { session: updatedRepair, issues: updatedIssues };
      } catch (error) {
        try {
          for (const issue of updatedIssues) {
            const original = issues.find((candidate) => String(candidate._id) === String(issue._id));
            await deps.Issue.findOneAndUpdate(
              { _id: issue._id, ...activeIssueFilter(repair), mutationId },
              { $set: {
                resolution: plain(original?.resolution) || {
                  status: "unresolved", scope: "once", patch: null,
                },
                mutationId: null,
                mutationPreviousMatchStatus: null,
                mutationPreviousResolution: null,
              } },
              { new: true },
            );
          }
          const released = await deps.RepairSession.findOneAndUpdate(
            {
              ...ownershipFilter(repair, userId),
              version,
              pendingMutationId: mutationId,
              pendingRecoveryId: null,
            },
            { $unset: {
              pendingMutationId: 1,
              pendingMutationType: 1,
              pendingMutationStartedAt: 1,
              pendingRecoveryId: 1,
            } },
            { new: true },
          );
          if (!released) throw new Error("resolution reservation changed");
        } catch (rollbackError) {
          throw rollbackFailure("Không thể rollback issue resolution", rollbackError);
        }
        throw error;
      }
    }

    return runAtomicMutation(deps.startSession, transactional, standalone);
  }

  async function resolveIssue({ userId, repairId, issueId, body, humanConfirmationToken, requestId }) {
    const repair = await loadRepair(repairId, userId);
    const version = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    if (repair.version !== version) {
      throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    }
    const scopeName = text(body?.scope || "once", 64);
    if (!RESOLUTION_SCOPES.includes(scopeName)) {
      throw repairError(422, "Resolution scope không hợp lệ", "INVALID_RESOLUTION_SCOPE");
    }
    const patch = validateResolutionPatch(body);
    const normalizedIssueId = objectId(issueId, "Issue", "ISSUE_NOT_FOUND");
    const issue = await deps.Issue.findOne({ _id: normalizedIssueId, ...activeIssueFilter(repair) });
    if (!issue) throw repairError(404, "Issue không tồn tại", "ISSUE_NOT_FOUND");
    if (
      issue.matchStatus !== "confirmed" ||
      issue.userConfirmedMatch !== true ||
      !["unresolved", "resolved"].includes(String(issue.resolution?.status || "unresolved"))
    ) {
      throw repairError(409, "Issue chưa được user xác nhận hoặc đã resolved", "RESOLUTION_BLOCKED");
    }
    const trusted = await trustedRepairScope(repair, userId);
    const group = { documentGroupId: String(issue.confirmedDocumentGroupId), status: "failed", userConfirmed: true };
    const acknowledgeWarnings = warningAcknowledgement(body);
    const readiness = await converterReadiness({
      scope: trusted,
      body: retryConverterBody({
        repair,
        scope: trusted,
        manifest: trusted.manifestResult.manifest,
        groups: [group],
        patches: [converterPatch(issue, patch, trusted.manifestResult.manifest)],
        acknowledgeWarnings,
      }),
      requestId,
    });
    assertResolutionReadiness(readiness, acknowledgeWarnings);
    const confirmation = await canonicalConfirmationPayload({
      action: "resolve_issue",
      repair,
      userId,
      body,
      issueId: normalizedIssueId,
    });
    await consumeHumanConfirmation({
      userId,
      repair,
      action: "resolve_issue",
      payloadHash: confirmation.requestFingerprint,
      body,
      token: humanConfirmationToken,
    });
    const result = await persistResolutions({
      repair,
      userId,
      version,
      issues: [issue],
      scope: scopeName,
      patch,
    });
    return { session: result.session, issue: issueResponse(result.issues[0]) };
  }

  function simulationHash(value) {
    const secret = String(
      deps.simulationSecret ||
      process.env.CONVERSION_CONTEXT_SECRET ||
      process.env.CONVERTER_SERVICE_TOKEN ||
      "",
    );
    if (!secret) throw repairError(503, "Thiếu secret cho bulk simulation", "SIMULATION_SECRET_MISSING");
    return crypto.createHmac("sha256", secret).update(canonicalJson(value)).digest("hex");
  }

  async function simulateBulk({ userId, repairId, body, requestId }) {
    const repair = await loadRepair(repairId, userId);
    const version = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    if (repair.version !== version) {
      throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    }
    const ids = selectedIssueIds(body?.issue_ids || body?.issueIds);
    const patch = validateResolutionPatch(body);
    const scopeName = text(body?.scope || "once", 64);
    if (!RESOLUTION_SCOPES.includes(scopeName)) {
      throw repairError(422, "Resolution scope không hợp lệ", "INVALID_RESOLUTION_SCOPE");
    }
    const allIssues = await allActiveIssues(repair);
    const selectedSet = new Set(ids);
    const issues = allIssues.filter((issue) => selectedSet.has(String(issue._id)));
    if (issues.length !== ids.length) throw repairError(404, "Issue không tồn tại", "ISSUE_NOT_FOUND");
    if (issues.some((issue) =>
      issue.matchStatus !== "confirmed" ||
      issue.userConfirmedMatch !== true ||
      issue.resolution?.status !== "unresolved")) {
      throw repairError(409, "Bulk action chỉ áp dụng issue đã match và chưa resolved", "BULK_ACTION_BLOCKED");
    }
    const groups = [...new Set(issues.map((issue) => String(issue.confirmedDocumentGroupId)))].map(
      (documentGroupId) => ({ documentGroupId, status: "failed", userConfirmed: true }),
    );
    const trusted = await trustedRepairScope(repair, userId);
    const readiness = await converterReadiness({
      scope: trusted,
      body: retryConverterBody({
        repair,
        scope: trusted,
        manifest: trusted.manifestResult.manifest,
        groups,
        patches: issues.map((issue) => converterPatch(issue, patch, trusted.manifestResult.manifest)),
        acknowledgeWarnings: warningAcknowledgement(body),
      }),
      requestId,
    });
    const commitment = {
      repairId: String(repair._id),
      version,
      issueIds: [...ids].sort(),
      patch,
      scope: scopeName,
      readinessSummary: readiness.summary,
      examples: readiness.examples,
    };
    return {
      affectedIssueCount: issues.length,
      documentGroupCount: groups.length,
      examples: readiness.examples,
      newBlockers: readiness.issues.filter((issue) => issue?.severity === "fatal" || issue?.severity === "blocker"),
      newWarnings: readiness.issues.filter((issue) => issue?.severity === "warning"),
      readiness: { status: readiness.status, summary: readiness.summary },
      simulationHash: simulationHash(commitment),
    };
  }

  async function applyBulk({ userId, repairId, body, humanConfirmationToken, requestId }) {
    const simulation = await simulateBulk({ userId, repairId, body, requestId });
    const supplied = text(body?.simulation_hash || body?.simulationHash, 64).toLowerCase();
    if (
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(simulation.simulationHash))
    ) {
      throw repairError(409, "simulation_hash không khớp", "SIMULATION_HASH_MISMATCH");
    }
    assertResolutionReadiness(
      { summary: simulation.readiness?.summary || {} },
      warningAcknowledgement(body),
    );
    const repair = await loadRepair(repairId, userId);
    const version = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    const ids = selectedIssueIds(body?.issue_ids || body?.issueIds);
    const selectedSet = new Set(ids);
    const issues = (await allActiveIssues(repair)).filter((issue) => selectedSet.has(String(issue._id)));
    const patch = validateResolutionPatch(body);
    const scopeName = text(body?.scope || "once", 64);
    if (!RESOLUTION_SCOPES.includes(scopeName)) {
      throw repairError(422, "Resolution scope không hợp lệ", "INVALID_RESOLUTION_SCOPE");
    }
    const confirmation = await canonicalConfirmationPayload({
      action: "bulk_apply",
      repair,
      userId,
      body,
    });
    await consumeHumanConfirmation({
      userId,
      repair,
      action: "bulk_apply",
      payloadHash: confirmation.requestFingerprint,
      body,
      token: humanConfirmationToken,
    });
    const result = await persistResolutions({ repair, userId, version, issues, scope: scopeName, patch });
    return {
      session: result.session,
      affectedIssueCount: result.issues.length,
      simulationHash: simulation.simulationHash,
    };
  }

  function scopedRetryKey(repairId, key) {
    return sha256(Buffer.from(`${String(repairId)}:${key}`, "utf8"));
  }

  function assertRetryReplay(batch, requestFingerprint) {
    if (String(batch?.readinessSummary?.requestFingerprint || "") !== requestFingerprint) {
      throw repairError(409, "Idempotency key đã được dùng cho payload khác", "IDEMPOTENCY_KEY_REUSED");
    }
    if (batch.status !== "completed") {
      throw repairError(409, "Retry batch đang xử lý hoặc đã thất bại", "RETRY_BATCH_NOT_COMPLETE");
    }
    return batch;
  }

  async function deleteRetryPersistence({ repair, userId, batch, artifact, mutationId }) {
    const failures = [];
    if (artifact) {
      try {
        await deps.artifacts.deleteArtifact({
          sessionId: String(repair._id),
          runId: String(artifact.runId || repair.conversionRun),
          ownerScope: repair.ownerScope,
          userId,
          workspaceId: repair.workspace ? String(repair.workspace?._id || repair.workspace) : null,
          uploadId: text(artifact.uploadId, 256),
          targetTemplateId: text(repair.targetTemplateId, 256),
          kind: "retry_output",
          revision: Number(batch?.readinessSummary?.sequence || artifact.revision),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (!failures.length && batch && typeof deps.RetryBatch.deleteOne === "function") {
      try {
        await deps.RetryBatch.deleteOne({
          _id: batch._id,
          repairSession: repair._id,
          ownerScope: repair.ownerScope,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      if (batch && typeof deps.RetryBatch.findOneAndUpdate === "function") {
        try {
          await deps.RetryBatch.findOneAndUpdate(
            { _id: batch._id },
            {
              $set: {
                status: "failed",
                recoveryState: "cleanup_required",
                recoveryError: String(failures[0]?.message || failures[0]),
              },
            },
            { new: true },
          );
        } catch (error) {
          failures.push(error);
        }
      }
      throw rollbackFailure("Không thể hoàn tất cleanup retry artifact", failures[0]);
    }
    return { mutationId };
  }

  async function releaseRetryReservation({ repair, userId, version, mutationId }) {
    const released = await deps.RepairSession.findOneAndUpdate(
      {
        ...ownershipFilter(repair, userId),
        version,
        pendingMutationId: mutationId,
        pendingRecoveryId: null,
      },
      {
        $unset: {
          pendingMutationId: 1,
          pendingMutationType: 1,
          pendingMutationStartedAt: 1,
          pendingRecoveryId: 1,
        },
      },
      { new: true },
    );
    if (!released) throw new Error("retry reservation changed before release");
    return released;
  }

  async function persistRetryBatch({ repair, userId, version, mutationId, batch, artifact }) {
    function completeBatch() {
      batch.status = "completed";
      batch.outputArtifactKey = artifactObjectId(artifact);
      batch.outputSha256 = artifact.sha256;
      batch.completedAt = deps.now();
    }

    async function transactional(session) {
      completeBatch();
      await batch.save({ session });
      const updated = await deps.RepairSession.findOneAndUpdate(
        {
          ...ownershipFilter(repair, userId),
          version,
          pendingMutationId: mutationId,
          pendingRecoveryId: null,
        },
        {
          $set: { status: "retry_exported" },
          $unset: {
            pendingMutationId: 1,
            pendingMutationType: 1,
            pendingMutationStartedAt: 1,
            pendingRecoveryId: 1,
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!updated) throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
      return { batch, session: updated };
    }

    async function standalone() {
      try {
        completeBatch();
        await batch.save();
        const updated = await deps.RepairSession.findOneAndUpdate(
          {
            ...ownershipFilter(repair, userId),
            version,
            pendingMutationId: mutationId,
            pendingRecoveryId: null,
          },
          {
            $set: { status: "retry_exported" },
            $unset: {
              pendingMutationId: 1,
              pendingMutationType: 1,
              pendingMutationStartedAt: 1,
              pendingRecoveryId: 1,
            },
            $inc: { version: 1 },
          },
          { new: true },
        );
        if (!updated) throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
        return { batch, session: updated };
      } catch (error) {
        try {
          await deleteRetryPersistence({ repair, userId, batch, artifact, mutationId });
          await releaseRetryReservation({ repair, userId, version, mutationId });
        } catch (rollbackError) {
          throw rollbackFailure("Không thể rollback retry persistence", rollbackError);
        }
        error.retryPersistenceCleaned = true;
        error.retryReservationReleased = true;
        throw error;
      }
    }

    try {
      return await runAtomicMutation(deps.startSession, transactional, standalone);
    } catch (error) {
      if (!error.retryPersistenceCleaned) {
        try {
          await deleteRetryPersistence({ repair, userId, batch, artifact, mutationId });
          error.retryPersistenceCleaned = true;
        } catch (cleanupError) {
          throw cleanupError;
        }
      }
      if (!error.retryReservationReleased) {
        try {
          await releaseRetryReservation({ repair, userId, version, mutationId });
          error.retryReservationReleased = true;
        } catch (releaseError) {
          throw rollbackFailure("Không thể release retry reservation", releaseError);
        }
      }
      throw error;
    }
  }

  async function createRetryBatch({ userId, repairId, body, humanConfirmationToken, idempotencyKey, requestId }) {
    assertHumanAction(body);
    const repair = await loadRepair(repairId, userId);
    const key = strictText(idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH, "Idempotency-Key", "IDEMPOTENCY_KEY_INVALID");
    if (!key) throw repairError(400, "Idempotency-Key là bắt buộc", "IDEMPOTENCY_KEY_REQUIRED");
    const storedKey = scopedRetryKey(repair._id, key);
    const version = expectedVersion(body?.expected_version ?? body?.expectedVersion);
    const canonical = await canonicalRetryRequest({ repair, userId, body, expected: version });
    const requestFingerprint = canonical.requestFingerprint;
    const batchFilter = {
      repairSession: repair._id,
      ownerScope: repair.ownerScope,
      workspace: repair.workspace || null,
      idempotencyKey: storedKey,
    };
    const existing = await deps.RetryBatch.findOne(batchFilter);
    if (existing) {
      return { batch: assertRetryReplay(existing, requestFingerprint), idempotent: true };
    }
    suppliedConfirmationToken(body, humanConfirmationToken);

    if (repair.version !== version) {
      throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    }
    const issues = await allActiveIssues(repair);
    const selectedIds = canonical.canonical.selected_document_group_ids;
    const groups = canonical.groups;
    const trusted = canonical.trusted;
    const preflight = await retryPreflight({
      repair,
      canonical,
      acknowledgeWarnings: canonical.canonical.acknowledge_warnings,
      requestId,
    });
    assertCurrentReadinessHash(
      retryReadinessHash(body, { required: true }),
      preflight.response.hash,
    );
    const converterBody = preflight.converterBody;
    const readiness = preflight.readiness;
    assertRetryGate({
      groups,
      issues,
      readiness,
      acknowledgeWarnings: canonical.canonical.acknowledge_warnings,
    });

    await consumeHumanConfirmation({
      userId,
      repair,
      action: "retry_export",
      payloadHash: requestFingerprint,
      body,
      token: humanConfirmationToken,
    });

    const mutationId = `retry:${crypto.randomUUID()}`;
    const reserved = await deps.RepairSession.findOneAndUpdate(
      {
        ...ownershipFilter(repair, userId),
        version,
        pendingMutationId: null,
        pendingRecoveryId: null,
      },
      {
        $set: {
          pendingMutationId: mutationId,
          pendingMutationType: "confirm",
          pendingMutationStartedAt: deps.now(),
        },
      },
      { new: true },
    );
    if (!reserved) {
      throw repairError(409, "Repair session đã được cập nhật ở tab khác", "STALE_REPAIR_VERSION");
    }

    let batch = null;
    let exported;
    let artifact = null;
    try {
      const sequence = Number(await deps.RetryBatch.countDocuments({
        repairSession: repair._id,
        ownerScope: repair.ownerScope,
      })) + 1;
      batch = new deps.RetryBatch({
        repairSession: repair._id,
        ownerScope: repair.ownerScope,
        workspace: repair.workspace || null,
        exportBatchId: `retry-${repair._id}-${sequence}`,
        idempotencyKey: storedKey,
        documentGroupIds: selectedIds,
        confirmation: {
          statement: RETRY_CONFIRMATION_STATEMENT,
          confirmedBy: userId,
          confirmedAt: deps.now(),
        },
        status: "exporting",
        readinessSummary: {
          ...readiness.summary,
          sequence,
          requestFingerprint,
          trustedStateHash: canonical.canonical.trusted_state_hash,
        },
        createdBy: userId,
        expiresAt: new Date(repair.expiresAt),
        mutationId,
      });
      await batch.save();
      try {
        exported = await deps.forwardBinary({
          path: "/api/v1/import-repairs/export",
          body: converterBody,
          contextToken: trusted.contextToken,
          requestId,
        });
      } catch (error) {
        if (isConverterTimeoutError(error)) {
          throw repairError(503, "Converter phản hồi quá thời gian", "CONVERTER_TIMEOUT");
        }
        throw error;
      }
      if (Number(exported?.status) >= 400) upstreamFailure(exported, 422);
      if (!Buffer.isBuffer(exported?.data) || exported.data.length === 0) throw invalidConverterResponse();
      artifact = await deps.artifacts.putArtifact({
        sessionId: String(repair._id),
        runId: String(trusted.run._id),
        ownerScope: repair.ownerScope,
        userId,
        workspaceId: trusted.workspaceId,
        uploadId: text(trusted.run.converterUploadId, 256),
        targetTemplateId: text(repair.targetTemplateId, 256),
        kind: "retry_output",
        revision: sequence,
        bytes: exported.data,
        sha256: sha256(exported.data),
        sizeBytes: exported.data.length,
        mime: "application/vnd.ms-excel",
        expiresAt: new Date(repair.expiresAt),
      });
      artifact = {
        ...artifact,
        revision: sequence,
        runId: String(trusted.run._id),
        uploadId: text(trusted.run.converterUploadId, 256),
      };
      const persisted = await persistRetryBatch({
        repair,
        userId,
        version,
        mutationId,
        batch,
        artifact,
      });
      return { batch: persisted.batch, session: persisted.session, idempotent: false };
    } catch (error) {
      let raced = null;
      if (error?.code === 11000) {
        raced = await deps.RetryBatch.findOne(batchFilter);
        batch = null;
      }
      if ((batch || artifact) && !error.retryPersistenceCleaned) {
        try {
          await deleteRetryPersistence({ repair, userId, batch, artifact, mutationId });
          error.retryPersistenceCleaned = true;
        } catch (cleanupError) {
          throw cleanupError;
        }
      }
      if (!error.retryReservationReleased) {
        try {
          await releaseRetryReservation({ repair, userId, version, mutationId });
          error.retryReservationReleased = true;
        } catch (releaseError) {
          throw rollbackFailure("Không thể release retry reservation", releaseError);
        }
      }
      if (raced) return { batch: assertRetryReplay(raced, requestFingerprint), idempotent: true };
      throw error;
    }
  }

  async function downloadRetryBatch({ userId, repairId, batchId }) {
    const repair = await loadRepair(repairId, userId);
    const scope = await loadOwnedRun({
      Run: deps.Run,
      Workspace: deps.Workspace,
      runId: repair.conversionRun,
      userId,
    });
    const repairWorkspaceId = repair.workspace
      ? String(repair.workspace?._id || repair.workspace)
      : null;
    if (
      scope.ownerScope !== repair.ownerScope ||
      String(scope.workspaceId || "") !== String(repairWorkspaceId || "")
    ) {
      throw repairError(404, "Retry artifact không tồn tại", "RETRY_ARTIFACT_NOT_FOUND");
    }
    const normalizedBatchId = objectId(batchId, "Retry batch", "RETRY_BATCH_NOT_FOUND");
    const batch = await deps.RetryBatch.findOne({
      _id: normalizedBatchId,
      repairSession: repair._id,
      ownerScope: repair.ownerScope,
      workspace: repair.workspace || null,
    });
    if (!batch) throw repairError(404, "Retry batch không tồn tại", "RETRY_BATCH_NOT_FOUND");
    if (new Date(batch.expiresAt) <= deps.now()) {
      throw repairError(410, "Retry batch đã hết hạn", "RETRY_BATCH_EXPIRED");
    }
    if (batch.status !== "completed") {
      throw repairError(409, "Retry batch chưa hoàn tất", "RETRY_BATCH_NOT_COMPLETE");
    }
    const sequence = Number(batch.readinessSummary?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw repairError(409, "Retry artifact binding không hợp lệ", "RETRY_ARTIFACT_MISMATCH");
    }
    const artifactBinding = {
      sessionId: String(repair._id),
      runId: String(scope.run._id),
      ownerScope: repair.ownerScope,
      userId: String(userId),
      workspaceId: scope.workspaceId,
      uploadId: text(scope.run.converterUploadId, 256),
      targetTemplateId: text(repair.targetTemplateId, 256),
      kind: "retry_output",
      revision: sequence,
    };
    let stored;
    try {
      stored = await deps.artifacts.getArtifact(artifactBinding);
    } catch (error) {
      if ([404, 410].includes(Number(error?.statusCode))) {
        throw repairError(410, "Retry artifact đã hết hạn", "RETRY_ARTIFACT_EXPIRED");
      }
      throw error;
    }
    if (
      stored.metadata?.ownerScope !== repair.ownerScope ||
      String(stored.metadata?.userId || "") !== String(userId) ||
      String(stored.metadata?.workspaceId || "") !== String(scope.workspaceId || "")
    ) {
      throw repairError(404, "Retry artifact không tồn tại", "RETRY_ARTIFACT_NOT_FOUND");
    }
    validateStoredArtifact(
      stored,
      artifactBinding,
      positiveByteLimit("CONVERTER_MAX_OUTPUT_BYTES", DEFAULT_OUTPUT_ARTIFACT_MAX_BYTES),
      deps.now,
    );
    if (
      artifactObjectId(stored.metadata) !== String(batch.outputArtifactKey) ||
      stored.metadata.sha256 !== batch.outputSha256
    ) {
      throw repairError(409, "Retry artifact checksum/binding không khớp", "RETRY_ARTIFACT_MISMATCH");
    }
    const content = boundedVerifiedArtifactStream(
      stored,
      artifactBinding,
      positiveByteLimit("CONVERTER_MAX_OUTPUT_BYTES", DEFAULT_OUTPUT_ARTIFACT_MAX_BYTES),
      deps.now,
    );
    return {
      content,
      contentType: stored.metadata.mime,
      filename: `MISA retry ${String(batch._id)}.xls`,
      batch,
    };
  }

  return {
    applyBulk,
    confirmMatch,
    createRetryBatch,
    createSession,
    downloadRetryBatch,
    issueHumanConfirmation,
    loadRepair,
    readWorkspace,
    resolveIssue,
    setImportStatus,
    simulateBulk,
    submitSchema,
  };
}

const defaultService = createMisaImportRepairService();

module.exports = {
  buildIssueMatch,
  assertRetryGate,
  buildMisaImportRepairAuditEvent,
  createMisaImportRepairMetrics,
  createMisaImportRepairService,
  createSession: (...args) => defaultService.createSession(...args),
  submitSchema: (...args) => defaultService.submitSchema(...args),
  readWorkspace: (...args) => defaultService.readWorkspace(...args),
  confirmMatch: (...args) => defaultService.confirmMatch(...args),
  setImportStatus: (...args) => defaultService.setImportStatus(...args),
  resolveIssue: (...args) => defaultService.resolveIssue(...args),
  simulateBulk: (...args) => defaultService.simulateBulk(...args),
  applyBulk: (...args) => defaultService.applyBulk(...args),
  createRetryBatch: (...args) => defaultService.createRetryBatch(...args),
  downloadRetryBatch: (...args) => defaultService.downloadRetryBatch(...args),
  emitMisaImportRepairMetric,
  issueHumanConfirmation: (...args) => defaultService.issueHumanConfirmation(...args),
  emitMisaImportRepairAuditEvent,
  getMisaImportRepairMetricSnapshot,
  renderMisaImportRepairPrometheusMetrics,
  sanitizeRepairPayload,
  sessionResponse,
  setMisaImportRepairMetrics,
  validateResolutionPatch,
};
