export const NODE_CAPABILITIES_FIXTURE = Object.freeze({
  mapping_profile_v2: true,
  anomaly_detection: true,
  bulk_correction: true,
  reconciliation: true,
  accounting_assistant: true,
  ai_explanation: true,
  limits: {
    comparison_files: 2,
    raw_ttl_minutes: 60,
    max_rows_per_file: 50000,
  },
});

export const CONVERTER_HEALTH_FIXTURE = Object.freeze({
  status: "ok",
  ai: "online",
  capabilities: {
    mapping_profile_v2: true,
    anomaly_detection: true,
    bulk_correction: false,
    reconciliation: true,
    accounting_assistant: true,
    ai_explanation: true,
    limits: {
      comparison_files: 2,
      raw_ttl_minutes: 60,
      max_rows_per_file: 50000,
    },
  },
});

export const ANALYZE_SESSION_FIXTURE = Object.freeze({
  upload_id: "upload-1",
  target_template_id: "misa_purchase_goods",
  mapping_profile_v2: {
    match_tier: "exact",
    profile_id: "profile-2",
    confidence: 0.99,
    warnings: [],
  },
  mapping_suggestion: {
    source: "profile_v2",
    profile_id: "profile-2",
    confidence: 0.99,
    mapping: {},
    defaults: {},
    formulas: {},
    warnings: [],
  },
  session: {
    session_id: "session-1",
    active_revision: 3,
    state_hash: "state-3",
    expires_at: "2026-07-27T10:00:00Z",
  },
});

export const CORRECTION_PATCH_SET_FIXTURE = Object.freeze({
  patch_set_id: "patch-set-1",
  base_revision: 3,
  base_state_hash: "state-3",
  status: "proposed",
  patches: [
    {
      patch_id: "patch-1",
      operation: "normalize_text",
      row_ids: ["row-1"],
      field: "Tên hàng",
      after_value: "Sữa chua",
      risk: "safe",
      selected_by_default: true,
    },
  ],
  summary: {
    affected_rows: 1,
    affected_fields: 1,
    amount_delta: "0",
    vat_delta: "0",
  },
});

export const RECONCILIATION_REPORT_FIXTURE = Object.freeze({
  report_id: "report-1",
  session_id: "session-1",
  revision: 3,
  state_hash: "state-3",
  status: "conflict",
  roles_present: ["primary", "invoice"],
  summary: {
    matched: 4,
    missing_primary: 1,
    missing_comparison: 2,
    conflicts: 3,
    candidates_need_review: 1,
  },
  records: [
    {
      match_id: "match-1",
      status: "candidate",
      comparison_record_ids: ["comparison-1", "comparison-2"],
    },
  ],
});

export const ASSISTANT_ANSWER_FIXTURE = Object.freeze({
  answer_id: "answer-1",
  answer: "Có một chênh lệch cần kiểm tra.",
  status: "answered",
  answer_type: "deterministic",
  confidence: "verified",
  evidence_packet_id: "packet-1",
  evidence_packet: {
    packet_id: "packet-1",
    session_id: "session-1",
    owner_scope: "workspace:workspace-1",
    revision: 3,
    state_hash: "state-3",
    items: [
      {
        evidence_id: "evidence-1",
        type: "file_cell",
        label: "Dòng 12, cột Thành tiền",
        locator: { row: 12, field: "Thành tiền" },
      },
    ],
    seal: "signed-seal",
  },
  citations: ["evidence-1"],
  needs_professional_review: false,
});
