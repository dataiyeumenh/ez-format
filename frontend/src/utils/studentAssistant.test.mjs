import assert from "node:assert/strict";
import test from "node:test";
import {
  createStudentSourceRowRequestContext,
  createStudentWorkDraft,
  buildStudentSourceRowItems,
  buildInternshipReportRequest,
  canExportAnonymizedWorkbook,
  filterStudentActivities,
  formatStudentQuestionEvidenceLabel,
  formatStudentEvidenceLabel,
  findStudentExplanation,
  getStudentQuestionAnswerState,
  getStudentQuestionSuggestions,
  getAccountingMapStatusState,
  getAccountingMapPresentationState,
  getAccountingMapTotals,
  getReconciliationStatusState,
  isReconciliationEvidenceInsufficient,
  isStudentAssistantAvailable,
  getStudentActivitySkillSummary,
  getStudentSummaryItems,
  getStudentDataTabDomIds,
  getNextStudentTabId,
  keepCurrentExplanationSelection,
  resolveStudentEvidenceNavigation,
  studentSourceRowResponseMatchesContext,
  clearStudentSessionResume,
  loadStudentSessionResume,
  resumeStudentSession,
  saveStudentSessionResume,
} from "./studentAssistant.js";

test("student route requires both frontend flag and backend capability", () => {
  assert.equal(
    isStudentAssistantAvailable(true, {
      serviceOnline: true,
      capabilityEnabled: true,
    }),
    true,
  );
  assert.equal(
    isStudentAssistantAvailable(false, {
      serviceOnline: true,
      capabilityEnabled: true,
    }),
    false,
  );
  assert.equal(
    isStudentAssistantAvailable(true, {
      serviceOnline: true,
      capabilityEnabled: false,
    }),
    false,
  );
  assert.equal(isStudentAssistantAvailable(true, null), false);
});

test("nested student data tabs use DOM ids distinct from page tabs", () => {
  const ids = getStudentDataTabDomIds("mapping");
  assert.deepEqual(ids, {
    tabId: "student-data-tab-mapping",
    panelId: "student-data-panel-mapping",
  });
  assert.notEqual(ids.tabId, "student-tab-mapping");
  assert.notEqual(ids.panelId, "student-panel-mapping");
});

test("accounting-map labels and totals keep review states explicit", () => {
  assert.equal(getAccountingMapStatusState("suggested").label, "Gợi ý có căn cứ");
  assert.equal(getAccountingMapStatusState("needs_review").label, "Cần rà soát");
  assert.equal(getAccountingMapStatusState("unresolved").label, "Chưa đủ căn cứ");
  assert.deepEqual(
    getAccountingMapTotals({
      entries: [
        { side: "debit", amount: "108" },
        { side: "credit", amount: "100" },
        { side: "credit", amount: "8" },
      ],
    }),
    { debit: 108, credit: 108, delta: 0, balanced: true },
  );
});

test("reconciliation never presents insufficient data as success", () => {
  assert.equal(getReconciliationStatusState("match").kind, "success");
  assert.equal(getReconciliationStatusState("mismatch").kind, "blocker");
  const insufficient = getReconciliationStatusState("insufficient_data");
  assert.equal(insufficient.kind, "insufficient");
  assert.notEqual(insufficient.kind, "success");
});

test("reconciliation does not label non-numeric matches as insufficient", () => {
  assert.equal(
    isReconciliationEvidenceInsufficient({
      code: "duplicate_document_keys",
      status: "match",
    }),
    false,
  );
  assert.equal(
    isReconciliationEvidenceInsufficient({
      code: "detail_amount_vs_invoice_subtotal",
      status: "insufficient_data",
    }),
    true,
  );
});

test("internship activity filters and summaries use verified metadata only", () => {
  const activities = [
    { id: "1", eventType: "accounting_map_reviewed", skill: "accounting_mapping", evidenceCount: 2 },
    { id: "2", eventType: "reconciliation_completed", skill: "vat_reconciliation", evidenceCount: 8 },
  ];
  assert.deepEqual(filterStudentActivities(activities, "reconciliation_completed"), [activities[1]]);
  assert.deepEqual(getStudentActivitySkillSummary(activities), [
    { skill: "accounting_mapping", actions: 1, evidenceCount: 2 },
    { skill: "vat_reconciliation", actions: 1, evidenceCount: 8 },
  ]);
});

test("anonymization export needs acknowledgement and report generation is explicit", () => {
  assert.equal(canExportAnonymizedWorkbook(false, { scanner_status: "passed" }), false);
  assert.equal(canExportAnonymizedWorkbook(true, { scanner_status: "passed" }), true);
  assert.deepEqual(buildInternshipReportRequest(["activity-1"], "  Approved note  "), {
    activity_ids: ["activity-1"],
    approved_notes: ["Approved note"],
  });
});

test("student summary labels expose the deterministic file overview", () => {
  const items = getStudentSummaryItems({
    data_row_count: 1930,
    document_count: 420,
    recognized_columns: 8,
    unresolved_columns: 2,
    issue_counts: { blocker: 3, warning: 5, info: 1 },
    master_data_status: "connected",
  });

  assert.deepEqual(
    items.map((item) => [item.label, item.value]),
    [
      ["Dòng dữ liệu", "1.930"],
      ["Chứng từ ước tính", "420"],
      ["Cột đã nhận diện", "8"],
      ["Cột chưa nhận diện", "2"],
      ["Lỗi chắc chắn", "3"],
      ["Cảnh báo rà soát", "5"],
      ["Đối chiếu danh mục", "Đã kết nối"],
    ],
  );
});

test("student evidence labels distinguish source cells, columns, rules and templates", () => {
  assert.equal(
    formatStudentEvidenceLabel({
      kind: "source_cell",
      sheet: "Data",
      row: 25,
      column: "Thời gian",
    }),
    "Data · dòng 25 · cột Thời gian",
  );
  assert.equal(
    formatStudentEvidenceLabel({
      kind: "source_column",
      sheet: "Data",
      column: "Mã hàng",
    }),
    "Data · cột Mã hàng",
  );
  assert.equal(
    formatStudentEvidenceLabel({ kind: "rule", rule_id: "required_value_blank" }),
    "Quy tắc required_value_blank",
  );
  assert.equal(
    formatStudentEvidenceLabel({
      kind: "template",
      source_ref: "template:bsn_sales:Ngày hạch toán (*)",
    }),
    "Mẫu bsn_sales · Ngày hạch toán (*)",
  );
});

test("stale explanation selection is cleared when the state hash changes", () => {
  const explanations = [
    { id: "current", state_hash: "state-2", stale: false },
    { id: "stale-flag", state_hash: "state-2", stale: true },
    { id: "old", state_hash: "state-1", stale: false },
  ];

  assert.equal(
    keepCurrentExplanationSelection("current", explanations, "state-2"),
    "current",
  );
  assert.equal(
    keepCurrentExplanationSelection("stale-flag", explanations, "state-2"),
    null,
  );
  assert.equal(keepCurrentExplanationSelection("old", explanations, "state-2"), null);
  assert.equal(
    keepCurrentExplanationSelection("missing", explanations, "state-2"),
    null,
  );
});

test("preview selection keeps row index and chooses matching source-row evidence", () => {
  const explanations = [
    {
      id: "row-1",
      kind: "normalization",
      target_field: "Ngày hạch toán (*)",
      preview_row: 1,
      evidence: [{ kind: "source_cell", row: 2, column: "Thời gian" }],
    },
    {
      id: "row-2",
      kind: "normalization",
      target_field: "Ngày hạch toán (*)",
      preview_row: 2,
      evidence: [{ kind: "source_cell", row: 3, column: "Thời gian" }],
    },
  ];

  assert.equal(
    findStudentExplanation(explanations, "Ngày hạch toán (*)", {
      preferredKinds: ["normalization"],
      previewRow: 2,
      sourceRow: 3,
    })?.id,
    "row-2",
  );
});

test("issue selection matches repeated code by exact field and issue row", () => {
  const explanations = [
    {
      id: "issue-row-1",
      kind: "issue",
      target_field: "Thành tiền",
      issue_code: "line_amount_mismatch",
      issue_row: 1,
      evidence: [{ kind: "rule", rule_id: "line_amount_mismatch" }],
    },
    {
      id: "issue-row-2",
      kind: "issue",
      target_field: "Thành tiền",
      issue_code: "line_amount_mismatch",
      issue_row: 2,
      evidence: [{ kind: "rule", rule_id: "line_amount_mismatch" }],
    },
  ];

  assert.equal(
    findStudentExplanation(explanations, "Thành tiền", {
      preferredKinds: ["issue"],
      issueCode: "line_amount_mismatch",
      issueRow: 2,
    })?.id,
    "issue-row-2",
  );
});

test("session resume storage persists only session metadata and context token", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const resume = {
    session: {
      id: "session-1",
      status: "analyzed",
      file: { originalName: "sales.xlsx", rawRetained: false },
    },
    contextToken: "signed-token",
    analysis: { student_preview: { rows: [{ confidential: true }] } },
    file: { rawBytes: "secret" },
  };

  saveStudentSessionResume(storage, resume);

  assert.deepEqual(loadStudentSessionResume(storage), {
    session: resume.session,
    contextToken: "signed-token",
  });
  const serialized = [...values.values()][0];
  assert.equal(serialized.includes("student_preview"), false);
  assert.equal(serialized.includes("confidential"), false);
  assert.equal(serialized.includes("rawBytes"), false);

  clearStudentSessionResume(storage);
  assert.equal(loadStudentSessionResume(storage), null);
});

test("invalid session resume data is cleared", () => {
  const values = new Map([["ezformat.student.resume.v1", '{"session":{},"contextToken":""}']]);
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  assert.equal(loadStudentSessionResume(storage), null);
  assert.equal(values.size, 0);
});

test("expired context refreshes through Node before overview is retried", async () => {
  const calls = [];
  const resume = {
    session: { id: "session-1", status: "analyzed" },
    contextToken: "expired-token",
  };
  const result = await resumeStudentSession(resume, {
    getOverview: async (sessionId, contextToken) => {
      calls.push(["overview", sessionId, contextToken]);
      if (contextToken === "expired-token") {
        throw Object.assign(new Error("jwt expired"), { status: 401 });
      }
      return { upload_id: "upload-1" };
    },
    refreshContext: async (sessionId) => {
      calls.push(["refresh", sessionId]);
      return {
        session: { id: sessionId, status: "analyzed" },
        contextToken: "fresh-token",
      };
    },
  });

  assert.deepEqual(calls, [
    ["overview", "session-1", "expired-token"],
    ["refresh", "session-1"],
    ["overview", "session-1", "fresh-token"],
  ]);
  assert.deepEqual(result, {
    resume: {
      session: { id: "session-1", status: "analyzed" },
      contextToken: "fresh-token",
    },
    overview: { upload_id: "upload-1" },
  });
});

test("student tabs support roving arrow, Home and End navigation", () => {
  const tabs = ["mapping", "preview", "issues"];

  assert.equal(getNextStudentTabId(tabs, "mapping", "ArrowRight"), "preview");
  assert.equal(getNextStudentTabId(tabs, "issues", "ArrowRight"), "mapping");
  assert.equal(getNextStudentTabId(tabs, "mapping", "ArrowLeft"), "issues");
  assert.equal(getNextStudentTabId(tabs, "preview", "Home"), "mapping");
  assert.equal(getNextStudentTabId(tabs, "preview", "End"), "issues");
  assert.equal(getNextStudentTabId(tabs, "preview", "Enter"), "preview");
});

test("question answer labels distinguish supported, unsupported and AI unavailable", () => {
  assert.deepEqual(getStudentQuestionAnswerState({ outcome: "supported" }), {
    kind: "supported",
    label: "Đã kiểm chứng từ file",
  });
  assert.deepEqual(
    getStudentQuestionAnswerState({
      outcome: "unsupported",
      unsupported_reason: "unsupported_legal_or_business_judgment",
    }),
    { kind: "unsupported", label: "Chưa đủ căn cứ deterministic" },
  );
  assert.deepEqual(
    getStudentQuestionAnswerState({
      outcome: "ai_unavailable",
      unsupported_reason: "ai_unavailable",
    }),
    { kind: "ai_unavailable", label: "AI bổ sung không khả dụng" },
  );
});

test("question evidence labels and navigation preserve exact source row and field", () => {
  const evidence = {
    kind: "source_cell",
    sheet: "Data",
    row: 25,
    field: "Thời gian",
    target_field: "Ngày chứng từ (*)",
    actual: "25/12/2025",
  };
  const analysis = {
    detected: { header_row: 3 },
    mapping_suggestion: {
      mapping: { "Thời gian": "Ngày chứng từ (*)" },
    },
    student_preview: {
      headers: ["Ngày chứng từ (*)"],
      rows: Array.from({ length: 25 }, () => ({})),
    },
  };

  assert.equal(
    formatStudentQuestionEvidenceLabel(evidence),
    "Data · dòng 25 · trường Thời gian",
  );
  assert.deepEqual(resolveStudentEvidenceNavigation(evidence, analysis), {
    sourceRow: 25,
    sourceField: "Thời gian",
    targetField: "Ngày chứng từ (*)",
    previewRow: 22,
    view: "preview",
    visibleInPreview: true,
    requiresSourceRowFetch: true,
  });
});

test("outside-preview evidence requires exact source-row fetch instead of field fallback", () => {
  const navigation = resolveStudentEvidenceNavigation(
    {
      sheet: "Data",
      row: 80,
      field: "Mã hóa đơn",
      target_field: "Số chứng từ (*)",
    },
    {
      detected: { header_row: 1 },
      student_preview: {
        headers: ["Số chứng từ (*)"],
        rows: Array.from({ length: 25 }, () => ({})),
      },
      mapping_suggestion: { mapping: { "Mã hóa đơn": "Số chứng từ (*)" } },
    },
  );

  assert.deepEqual(navigation, {
    sourceRow: 80,
    sourceField: "Mã hóa đơn",
    targetField: "Số chứng từ (*)",
    previewRow: 79,
    view: "mapping",
    visibleInPreview: false,
    requiresSourceRowFetch: true,
  });
});

test("source-row panel items select the exact evidence field", () => {
  assert.deepEqual(
    buildStudentSourceRowItems(
      {
        worksheet_row: 80,
        fields: [
          { field: "Mã hóa đơn", value: "HD080" },
          { field: "Thành tiền", value: 125000 },
        ],
      },
      "Thành tiền",
    ),
    [
      { field: "Mã hóa đơn", value: "HD080", selected: false },
      { field: "Thành tiền", value: 125000, selected: true },
    ],
  );
});

test("late or cross-session source-row responses cannot update the current panel", () => {
  const context = {
    sessionId: "session-2",
    uploadId: "upload-2",
    stateHash: "state-2",
    requestEpoch: 7,
  };
  const valid = {
    session_id: "session-2",
    upload_id: "upload-2",
    state_hash: "state-2",
  };

  assert.equal(
    studentSourceRowResponseMatchesContext(valid, context, 7),
    true,
  );
  assert.equal(
    studentSourceRowResponseMatchesContext(valid, context, 6),
    false,
  );
  assert.equal(
    studentSourceRowResponseMatchesContext(
      { ...valid, session_id: "session-1" },
      context,
      7,
    ),
    false,
  );
  assert.equal(
    studentSourceRowResponseMatchesContext(
      { ...valid, upload_id: "upload-1" },
      context,
      7,
    ),
    false,
  );
  assert.equal(
    studentSourceRowResponseMatchesContext(
      { ...valid, state_hash: "state-1" },
      context,
      7,
    ),
    false,
  );
});

test("reset or new analysis invalidates an older source-row response", () => {
  const oldContext = createStudentSourceRowRequestContext(
    { session: { id: "session-1" } },
    { upload_id: "upload-1", student_state_hash: "state-1" },
    4,
  );
  const currentContext = createStudentSourceRowRequestContext(
    { session: { id: "session-2" } },
    { upload_id: "upload-2", student_state_hash: "state-2" },
    5,
  );
  const oldResponse = {
    session_id: "session-1",
    upload_id: "upload-1",
    state_hash: "state-1",
  };

  assert.equal(
    studentSourceRowResponseMatchesContext(oldResponse, oldContext, 4),
    true,
  );
  assert.equal(
    studentSourceRowResponseMatchesContext(oldResponse, currentContext, 4),
    false,
  );
});

test("question suggestions stay bounded and deterministic", () => {
  const suggestions = getStudentQuestionSuggestions("bsn_purchase");
  assert.ok(suggestions.length >= 4);
  assert.ok(suggestions.length <= 6);
  assert.ok(suggestions.every((item) => typeof item === "string" && item.length > 0));
});

test("editable support draft starts without grading state", () => {
  const analysis = {
    target_template_id: "bsn_sales",
    target_headers: ["Số hóa đơn (*)", "Thành tiền"],
    detected: { headers: ["Mã hóa đơn", "Thành tiền nguồn"] },
    mapping_suggestion: {
      mapping: {
        "Mã hóa đơn": "Số hóa đơn (*)",
        "Thành tiền nguồn": "Thành tiền",
      },
    },
    student_preview: {
      headers: ["Số hóa đơn (*)", "Thành tiền"],
      rows: [{ "Số hóa đơn (*)": "HD001", "Thành tiền": 100 }],
    },
  };

  const draft = createStudentWorkDraft(analysis);

  assert.deepEqual(draft.mapping, {});
  assert.equal(draft.classification, "");
  assert.equal(draft.rows[0]["Số hóa đơn (*)"], "HD001");
});

test("unresolved or empty accounting maps are never presented as balanced success", () => {
  assert.deepEqual(
    getAccountingMapPresentationState({
      business_event_status: "unresolved",
      entries: [],
      balanced: true,
      issues: [{ code: "business_event_unresolved" }],
    }),
    { kind: "unresolved", label: "Chưa đủ căn cứ để cân đối" },
  );
  assert.deepEqual(
    getAccountingMapPresentationState({
      business_event_status: "suggested",
      entries: [{ side: "debit", amount: "10" }, { side: "credit", amount: "10" }],
      balanced: true,
      issues: [],
    }),
    { kind: "balanced", label: "Nợ và Có đang cân" },
  );
});
