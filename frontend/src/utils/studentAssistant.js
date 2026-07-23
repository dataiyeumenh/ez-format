const MASTER_DATA_LABELS = {
  connected: "Đã kết nối",
  unavailable: "Tạm thời gián đoạn",
  not_configured: "Chưa cấu hình",
};
export const STUDENT_RESUME_STORAGE_KEY = "ezformat.student.resume.v1";
const UNSAFE_RESUME_KEYS = new Set([
  "rawrows",
  "rows",
  "rawbytes",
  "workbook",
  "workbookbytes",
  "analysis",
  "preview",
  "student_preview",
]);

function formatCount(value, fallback = "0") {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? new Intl.NumberFormat("vi-VN").format(number)
    : fallback;
}

export function getStudentSummaryItems(summary = {}) {
  const issues = summary.issue_counts || {};
  return [
    { key: "rows", label: "Dòng dữ liệu", value: formatCount(summary.data_row_count) },
    {
      key: "documents",
      label: "Chứng từ ước tính",
      value:
        summary.document_count === null || summary.document_count === undefined
          ? "Chưa đủ dữ liệu"
          : formatCount(summary.document_count),
    },
    {
      key: "recognized",
      label: "Cột đã nhận diện",
      value: formatCount(summary.recognized_columns),
    },
    {
      key: "unresolved",
      label: "Cột chưa nhận diện",
      value: formatCount(summary.unresolved_columns),
    },
    {
      key: "blockers",
      label: "Lỗi chắc chắn",
      value: formatCount(issues.blocker),
    },
    {
      key: "warnings",
      label: "Cảnh báo rà soát",
      value: formatCount(issues.warning),
    },
    {
      key: "master-data",
      label: "Đối chiếu danh mục",
      value:
        MASTER_DATA_LABELS[summary.master_data_status] ||
        summary.master_data_status ||
        "Chưa cấu hình",
    },
  ];
}

export function formatStudentEvidenceLabel(evidence = {}) {
  if (evidence.kind === "source_cell") {
    return [
      evidence.sheet || "Sheet",
      evidence.row ? `dòng ${evidence.row}` : null,
      evidence.column ? `cột ${evidence.column}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (evidence.kind === "source_column") {
    return [evidence.sheet || "Sheet", evidence.column ? `cột ${evidence.column}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  if (evidence.kind === "rule") {
    return `Quy tắc ${evidence.rule_id || evidence.source_ref || "nội bộ"}`;
  }
  if (evidence.kind === "template") {
    const parts = String(evidence.source_ref || "").split(":");
    if (parts[0] === "template" && parts.length >= 3) {
      return `Mẫu ${parts[1]} · ${parts.slice(2).join(":")}`;
    }
    return `Mẫu ${evidence.source_ref || "đích"}`;
  }
  return evidence.source_ref || "Bằng chứng";
}

export function formatStudentQuestionEvidenceLabel(evidence = {}) {
  return [
    evidence.sheet || "Sheet",
    evidence.row ? `dòng ${evidence.row}` : null,
    evidence.field ? `trường ${evidence.field}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function getStudentQuestionAnswerState(answer = {}) {
  if (answer.outcome === "supported") {
    return { kind: "supported", label: "Đã kiểm chứng từ file" };
  }
  if (
    answer.outcome === "ai_unavailable" ||
    answer.unsupported_reason === "ai_unavailable"
  ) {
    return { kind: "ai_unavailable", label: "AI bổ sung không khả dụng" };
  }
  return { kind: "unsupported", label: "Chưa đủ căn cứ deterministic" };
}

export function getStudentQuestionSuggestions(targetTemplateId = "") {
  const isPurchase = String(targetTemplateId).includes("purchase");
  return [
    isPurchase ? "File mua có bao nhiêu hóa đơn?" : "Có bao nhiêu hóa đơn?",
    "Cần sửa gì trước khi export?",
    "Dòng nào lệch tiền thuế GTGT?",
    isPurchase ? "Tổng thành tiền mua hàng là bao nhiêu?" : "Tổng thành tiền là bao nhiêu?",
    isPurchase ? "Hóa đơn mua nào bị trùng?" : "Có hóa đơn trùng không?",
    isPurchase ? "Mã hàng dùng để làm gì?" : "Thành tiền có ý nghĩa gì?",
  ];
}

export function resolveStudentEvidenceNavigation(evidence = {}, analysis = {}) {
  const sourceRow = Number(evidence.row || 0) || null;
  const sourceField = evidence.field || null;
  const mapping = analysis.mapping_suggestion?.mapping || {};
  const mappedTarget = mapping[sourceField];
  const targetField =
    evidence.target_field ||
    (Array.isArray(mappedTarget) ? mappedTarget[0] : mappedTarget) ||
    null;
  const headerRow = Number(analysis.detected?.header_row || 1);
  const previewRow = sourceRow ? sourceRow - headerRow : null;
  const previewRows = analysis.student_preview?.rows || [];
  const previewHeaders = analysis.student_preview?.headers || [];
  const visibleInPreview = Boolean(
    previewRow &&
      previewRow >= 1 &&
      previewRow <= previewRows.length &&
      targetField &&
      previewHeaders.includes(targetField),
  );
  return {
    sourceRow,
    sourceField,
    targetField,
    previewRow,
    view: visibleInPreview ? "preview" : "mapping",
    visibleInPreview,
    requiresSourceRowFetch: Boolean(sourceRow && sourceField),
  };
}

export function buildStudentSourceRowItems(sourceRow = {}, selectedField = null) {
  return (sourceRow.fields || []).map((item) => ({
    field: item.field,
    value: item.value,
    selected: item.field === selectedField,
  }));
}

export function createStudentSourceRowRequestContext(
  session = {},
  analysis = {},
  requestEpoch = 0,
) {
  return {
    sessionId: session?.session?.id || "",
    uploadId: analysis?.upload_id || "",
    stateHash: analysis?.student_state_hash || "",
    requestEpoch,
  };
}

export function studentSourceRowResponseMatchesContext(
  response = {},
  context = {},
  responseEpoch,
) {
  return Boolean(
    responseEpoch === context.requestEpoch &&
      response.session_id === context.sessionId &&
      response.upload_id === context.uploadId &&
      response.state_hash === context.stateHash,
  );
}

export function keepCurrentExplanationSelection(
  selectedId,
  explanations = [],
  currentStateHash = "",
) {
  if (!selectedId) return null;
  const selected = explanations.find((item) => item?.id === selectedId);
  if (!selected || selected.stale) return null;
  return selected.state_hash === currentStateHash ? selectedId : null;
}

export function buildStudentMappingRows(analysis = {}) {
  const suggestion = analysis.mapping_suggestion || {};
  const mapping = suggestion.mapping || {};
  const defaults = suggestion.defaults || {};
  const formulas = suggestion.formulas || {};
  const targetToSources = {};
  for (const [source, targetSpec] of Object.entries(mapping)) {
    const targets = Array.isArray(targetSpec) ? targetSpec : [targetSpec];
    for (const target of targets) {
      if (!target) continue;
      if (!targetToSources[target]) targetToSources[target] = [];
      targetToSources[target].push(source);
    }
  }

  return (analysis.target_headers || []).map((target) => {
    const sources = targetToSources[target] || [];
    const activeModes = [];
    if (sources.length) activeModes.push("mapping");
    if (defaults[target] !== undefined && defaults[target] !== "") activeModes.push("default");
    if (formulas[target]) activeModes.push("formula");
    return {
      target,
      sources,
      defaultValue: defaults[target],
      formula: formulas[target],
      required: String(target).includes("(*)"),
      mode:
        activeModes.length === 0
          ? "unresolved"
          : activeModes.length > 1
            ? "mixed"
            : activeModes[0],
      activeModes,
    };
  });
}

export function findStudentExplanation(
  explanations = [],
  targetField,
  options = {},
) {
  const normalizedOptions = Array.isArray(options)
    ? { preferredKinds: options }
    : options || {};
  const {
    preferredKinds = [],
    previewRow = null,
    sourceRow = null,
    issueCode = null,
    issueRow = null,
  } = normalizedOptions;
  const matches = explanations.filter((item) => item?.target_field === targetField);
  const exactMatches = matches.filter((item) => {
    if (issueCode) {
      const ruleMatches =
        item.issue_code === issueCode ||
        (item.evidence || []).some(
          (evidence) => evidence.kind === "rule" && evidence.rule_id === issueCode,
        );
      if (!ruleMatches) return false;
    }
    if (issueRow && item.issue_row !== issueRow) return false;
    if (previewRow || sourceRow) {
      const rowMatches =
        item.preview_row === previewRow ||
        (item.evidence || []).some(
          (evidence) => evidence.kind === "source_cell" && evidence.row === sourceRow,
        );
      if (!rowMatches) return false;
    }
    return !item.stale;
  });

  for (const kind of preferredKinds) {
    const preferred = exactMatches.find((item) => item.kind === kind);
    if (preferred) return preferred;
  }
  if (exactMatches.length) return exactMatches[0];
  if (issueCode || issueRow) return null;

  const fallbackMatches = matches.filter(
    (item) => !item.stale && !item.preview_row && !item.issue_row,
  );
  for (const kind of preferredKinds) {
    const preferred = fallbackMatches.find((item) => item.kind === kind);
    if (preferred) return preferred;
  }
  return fallbackMatches[0] || null;
}

export function getAccountingMapStatusState(status) {
  return {
    suggested: { kind: "suggested", label: "Gợi ý có căn cứ" },
    needs_review: { kind: "review", label: "Cần rà soát" },
    unresolved: { kind: "unresolved", label: "Chưa đủ căn cứ" },
  }[status] || { kind: "unresolved", label: "Chưa đủ căn cứ" };
}

export function getAccountingMapPresentationState(accountingMap = {}) {
  if (
    accountingMap.business_event_status === "unresolved" ||
    !(accountingMap.entries || []).length
  ) {
    return { kind: "unresolved", label: "Chưa đủ căn cứ để cân đối" };
  }
  if (accountingMap.balanced === true) {
    return { kind: "balanced", label: "Nợ và Có đang cân" };
  }
  return { kind: "unbalanced", label: "Nợ và Có chưa cân" };
}

export function getAccountingMapTotals(accountingMap = {}) {
  const totals = (accountingMap.entries || []).reduce(
    (result, entry) => {
      const amount = Number(entry?.amount || 0);
      if (Number.isFinite(amount) && entry?.side === "debit") result.debit += amount;
      if (Number.isFinite(amount) && entry?.side === "credit") result.credit += amount;
      return result;
    },
    { debit: 0, credit: 0 },
  );
  const delta = totals.debit - totals.credit;
  return { ...totals, delta, balanced: Math.abs(delta) < 1e-9 };
}

export function getReconciliationStatusState(status) {
  return {
    match: { kind: "success", label: "Khớp" },
    mismatch: { kind: "blocker", label: "Có chênh lệch" },
    insufficient_data: { kind: "insufficient", label: "Chưa đủ dữ liệu" },
  }[status] || { kind: "insufficient", label: "Chưa đủ dữ liệu" };
}

export function filterStudentActivities(activities = [], eventType = "all") {
  return eventType === "all"
    ? activities
    : activities.filter((activity) => activity?.eventType === eventType);
}

export function getStudentActivitySkillSummary(activities = []) {
  const summary = new Map();
  for (const activity of activities) {
    const skill = String(activity?.skill || "").trim();
    if (!skill) continue;
    const current = summary.get(skill) || { skill, actions: 0, evidenceCount: 0 };
    current.actions += 1;
    current.evidenceCount += Number(activity?.evidenceCount || 0);
    summary.set(skill, current);
  }
  return [...summary.values()];
}

export function canExportAnonymizedWorkbook(acknowledged, preview = {}) {
  return Boolean(acknowledged && preview?.scanner_status === "passed");
}

export function buildInternshipReportRequest(activityIds = [], approvedNote = "") {
  const activity_ids = [...new Set(activityIds.map((id) => String(id || "").trim()))]
    .filter(Boolean);
  const note = String(approvedNote || "").trim();
  return { activity_ids, approved_notes: note ? [note] : [] };
}

export function classifyStudentAssistantError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 410) return "expired";
  if (status === 401 || status === 403) return "permission";
  if (!status || error?.name === "TypeError") return "offline";
  return "request";
}

export function getNextStudentTabId(tabIds = [], currentId, key) {
  if (!tabIds.length) return currentId;
  const currentIndex = Math.max(0, tabIds.indexOf(currentId));
  if (key === "Home") return tabIds[0];
  if (key === "End") return tabIds[tabIds.length - 1];
  if (key === "ArrowRight") return tabIds[(currentIndex + 1) % tabIds.length];
  if (key === "ArrowLeft") {
    return tabIds[(currentIndex - 1 + tabIds.length) % tabIds.length];
  }
  return currentId;
}

export function getStudentScoreBand(score) {
  const value = Number(score);
  if (Number.isFinite(value) && value >= 85) {
    return { key: "strong", label: "Vững", tone: "emerald" };
  }
  if (Number.isFinite(value) && value >= 60) {
    return { key: "progressing", label: "Đang tiến bộ", tone: "amber" };
  }
  return { key: "review", label: "Cần ôn lại", tone: "rose" };
}

export function formatStudentAttemptRevision(attempt = {}) {
  const revision = Number(attempt.revision);
  return Number.isInteger(revision) && revision > 0
    ? `Lần làm #${revision}`
    : "Lần làm mới";
}

export function getStudentHintLevelState(revealedLevels = {}, issueId, level) {
  const requestedLevel = Number(level);
  const currentLevel = Number(revealedLevels?.[issueId] ?? -1);
  if (requestedLevel <= currentLevel) {
    return { state: "revealed", level: requestedLevel };
  }
  if (requestedLevel === currentLevel + 1) {
    return { state: "available", level: requestedLevel };
  }
  return { state: "locked", level: requestedLevel };
}

export function createStudentWorkDraft(analysis = {}) {
  return {
    mapping: {},
    rows: sanitizeStudentRows(analysis, analysis.student_preview?.rows || []),
    edited_cells: [],
    classification: "",
  };
}

export function setStudentMappingTarget(mapping = {}, target, source) {
  const normalizedTarget = String(target || "");
  const normalizedSource = String(source || "");
  const next = {};
  for (const [currentSource, targetSpec] of Object.entries(mapping || {})) {
    const targets = (Array.isArray(targetSpec) ? targetSpec : [targetSpec])
      .map(String)
      .filter((item) => item && item !== normalizedTarget);
    if (targets.length === 1) next[currentSource] = targets[0];
    if (targets.length > 1) next[currentSource] = targets;
  }
  if (normalizedSource && normalizedTarget) {
    const existing = next[normalizedSource];
    const targets = [...new Set([...(Array.isArray(existing) ? existing : existing ? [existing] : []), normalizedTarget])];
    next[normalizedSource] = targets.length === 1 ? targets[0] : targets;
  }
  return next;
}

export function buildStudentAttemptSubmission(analysis = {}, studentWork = {}) {
  const mapping = sanitizeStudentMapping(analysis, studentWork.mapping || {});
  let rows = sanitizeStudentRows(analysis, studentWork.rows || []);
  if (Array.isArray(studentWork.edited_cells)) {
    const editedCells = new Set(studentWork.edited_cells.map(String));
    rows = rows.map((row, rowIndex) =>
      Object.fromEntries(
        Object.entries(row).filter(([field]) => editedCells.has(`${rowIndex + 1}:${field}`)),
      ),
    );
  }
  const resolvedTargets = new Set();
  for (const targetSpec of Object.values(mapping)) {
    for (const target of Array.isArray(targetSpec) ? targetSpec : [targetSpec]) {
      if (target) resolvedTargets.add(String(target));
    }
  }
  const requiredCompleteness = Object.fromEntries(
    (analysis.target_headers || [])
      .filter((target) => String(target).includes("(*)"))
      .map((target) => [target, resolvedTargets.has(String(target))]),
  );
  const dateNumber = {};
  const vatAmount = {};
  rows.forEach((row, rowIndex) => {
    for (const [field, value] of Object.entries(row || {})) {
      const normalized = field.toLocaleLowerCase("vi");
      const key = `${rowIndex + 1}:${field}`;
      if (["ngày", "số lượng", "đơn giá"].some((marker) => normalized.includes(marker))) {
        dateNumber[key] = value;
      }
      if (
        ["thành tiền", "tiền thuế", "thuế suất", "tổng tiền"].some((marker) =>
          normalized.includes(marker),
        )
      ) {
        vatAmount[key] = value;
      }
    }
  });
  return {
    mapping,
    required_completeness: requiredCompleteness,
    date_number: dateNumber,
    vat_amount: vatAmount,
    classification: String(studentWork.classification || "").slice(0, 100),
  };
}

function sanitizeStudentMapping(analysis, mapping) {
  const suggestionSources = Object.keys(analysis.mapping_suggestion?.mapping || {});
  const sourceHeaders = new Set(
    (analysis.detected?.headers?.length ? analysis.detected.headers : suggestionSources).map(String),
  );
  const targetHeaders = new Set((analysis.target_headers || []).map(String));
  const sanitized = {};
  for (const [source, targetSpec] of Object.entries(mapping || {})) {
    if (!sourceHeaders.has(String(source))) continue;
    const targets = (Array.isArray(targetSpec) ? targetSpec : [targetSpec])
      .map(String)
      .filter((target) => targetHeaders.has(target));
    if (targets.length === 1) sanitized[String(source)] = targets[0];
    if (targets.length > 1) sanitized[String(source)] = [...new Set(targets)];
  }
  return sanitized;
}

function sanitizeStudentRows(analysis, rows) {
  const previewRows = analysis.student_preview?.rows || [];
  const previewHeaders = analysis.student_preview?.headers || Object.keys(previewRows[0] || {});
  const allowedHeaders = new Set(previewHeaders.map(String));
  return (Array.isArray(rows) ? rows : []).slice(0, 25).map((row) =>
    Object.fromEntries(
      Object.entries(row || {})
        .filter(([field]) => allowedHeaders.has(String(field)))
        .map(([field, value]) => [String(field), sanitizeStudentCellValue(value)]),
    ),
  );
}

function sanitizeStudentCellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  return String(value).slice(0, 500);
}

export function saveStudentSessionResume(storage, value = {}) {
  const targetStorage = storage || globalThis.sessionStorage;
  if (!targetStorage) return false;
  const session = sanitizeResumeValue(value.session);
  const contextToken = String(value.contextToken || "").trim();
  if (!session?.id || !contextToken) return false;
  try {
    targetStorage.setItem(
      STUDENT_RESUME_STORAGE_KEY,
      JSON.stringify({ session, contextToken }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadStudentSessionResume(storage) {
  const targetStorage = storage || globalThis.sessionStorage;
  if (!targetStorage) return null;
  try {
    const raw = targetStorage.getItem(STUDENT_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.session?.id || !String(parsed.contextToken || "").trim()) {
      targetStorage.removeItem(STUDENT_RESUME_STORAGE_KEY);
      return null;
    }
    return {
      session: sanitizeResumeValue(parsed.session),
      contextToken: String(parsed.contextToken),
    };
  } catch {
    targetStorage.removeItem(STUDENT_RESUME_STORAGE_KEY);
    return null;
  }
}

export async function resumeStudentSession(
  resume,
  { getOverview, refreshContext },
) {
  try {
    const overview = await getOverview(resume.session.id, resume.contextToken);
    return { resume, overview };
  } catch (error) {
    const status = Number(error?.status || error?.response?.status || 0);
    if (status !== 401) throw error;
  }

  const refreshed = await refreshContext(resume.session.id);
  const nextResume = {
    session: refreshed.session,
    contextToken: String(refreshed.contextToken || ""),
  };
  const overview = await getOverview(
    nextResume.session.id,
    nextResume.contextToken,
  );
  return { resume: nextResume, overview };
}

export function clearStudentSessionResume(storage) {
  const targetStorage = storage || globalThis.sessionStorage;
  if (!targetStorage) return;
  try {
    targetStorage.removeItem(STUDENT_RESUME_STORAGE_KEY);
  } catch {
    // Storage may be disabled by the browser; in-memory state still resets.
  }
}

function sanitizeResumeValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeResumeValue);
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSAFE_RESUME_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitizeResumeValue(item)]),
  );
}
