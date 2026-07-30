import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnomalyReviewPayload,
  buildAssistantQuestionPayload,
  buildCorrectionPayload,
  buildCorrectionSelection,
  buildUndoPayload,
  extractProfileMatch,
  getConfirmedProfilePresentation,
  filterAnomalies,
  groupAnomalies,
  getProfilePresentation,
  getReconciliationPresentation,
  isAssistantAnswerCurrent,
  resolveAssistantCitations,
  summarizeAnomalies,
} from "./converterOperations.js";
import {
  ANALYZE_SESSION_FIXTURE,
  ASSISTANT_ANSWER_FIXTURE,
  CORRECTION_PATCH_SET_FIXTURE,
  RECONCILIATION_REPORT_FIXTURE,
} from "./converterContractFixtures.js";

test("profile presentation never treats drift as an exact reusable match", () => {
  assert.deepEqual(getProfilePresentation(null), {
    kind: "empty",
    label: "Chưa có setting phù hợp",
    driftCount: 0,
    requiresReview: false,
    canUseProfile: false,
    mandatoryPreview: false,
    actualMappingSource: null,
  });
  assert.deepEqual(
    getProfilePresentation({
      match_tier: "compatible",
      mapping_source: "heuristic",
      approval_state: "approved",
      approval_applies_to_match: false,
      can_suggest: false,
      requires_preview: true,
      drift: [{}, {}],
    }),
    {
      kind: "review",
      label: "Có 2 thay đổi cấu trúc cần xem; đang dùng mapping heuristic",
      driftCount: 2,
      requiresReview: true,
      canUseProfile: false,
      mandatoryPreview: true,
      actualMappingSource: "heuristic",
    },
  );
});

test("profile presentation trusts exact wording only for the mapping actually selected", () => {
  assert.deepEqual(
    getProfilePresentation({
      match_tier: "exact",
      mapping_source: "profile_v2",
      approval_state: "approved",
      approval_applies_to_match: true,
      approved_risk_flags: ["vat"],
      unapproved_risk_flags: [],
      can_suggest: true,
      requires_preview: true,
    }),
    {
      kind: "exact",
      label: "Khớp chính xác; đã phê duyệt. Bắt buộc xem trước",
      driftCount: 0,
      requiresReview: false,
      canUseProfile: true,
      mandatoryPreview: true,
      actualMappingSource: "profile_v2",
    },
  );

  assert.deepEqual(
    getProfilePresentation({
      match_tier: "exact",
      mapping_source: "heuristic",
      approval_state: "unapproved",
      approval_applies_to_match: false,
      approved_risk_flags: [],
      unapproved_risk_flags: ["vat"],
      can_suggest: false,
      requires_preview: true,
    }),
    {
      kind: "review",
      label: "Profile khớp nhưng chưa được phê duyệt; đang dùng mapping heuristic",
      driftCount: 0,
      requiresReview: true,
      canUseProfile: false,
      mandatoryPreview: true,
      actualMappingSource: "heuristic",
    },
  );
});

test("confirmed V2 response is presented as activated with its immutable state hash", () => {
  assert.deepEqual(
    getConfirmedProfilePresentation({
      mapping_profile_kind: "v2",
      mapping_profile_version: 2,
      profile_id: "profile-v2-2",
      profile_state_hash: "state-v2-2",
      status: "active",
    }),
    {
      kind: "v2",
      label: "Thiết lập V2 đã lưu",
      profileId: "profile-v2-2",
      version: 2,
      stateHash: "state-v2-2",
      explicitFallback: false,
    },
  );
});

test("legacy fallback remains explicit when V2 is unavailable", () => {
  assert.deepEqual(
    getConfirmedProfilePresentation({
      mapping_profile_kind: "v1",
      mapping_profile_fallback: "legacy_v1",
    }),
    {
      kind: "v1",
      label: "Đã lưu theo thiết lập cũ (V1)",
      profileId: null,
      version: null,
      stateHash: null,
      explicitFallback: true,
    },
  );
});

test("anomaly summary separates deterministic blockers from review-only outliers", () => {
  const issues = [
    { id: "1", deterministic: true, severity: "blocker", reviewed: false },
    { id: "2", deterministic: false, severity: "warning", reviewed: false },
    { id: "3", deterministic: false, severity: "warning", reviewed: true },
    { id: "4", deterministic: true, severity: "info", reviewed: false },
    {
      id: "5",
      deterministic: true,
      severity: "fatal",
      blocking_scope: "system",
      reviewed: false,
    },
  ];

  assert.deepEqual(summarizeAnomalies(issues), {
    all: 5,
    blockers: 2,
    anomalies: 2,
    reviewed: 1,
  });
  assert.deepEqual(
    filterAnomalies(issues, "anomalies").map((issue) => issue.id),
    ["2", "3"],
  );
});

test("anomalies stay grouped by stable backend group key", () => {
  const groups = groupAnomalies([
    { id: "1", group_key: "price:item-1", group_label: "Đơn giá HH001" },
    { id: "2", group_key: "price:item-1", group_label: "Đơn giá HH001" },
    { id: "3", rule_id: "duplicate_invoice", message: "Trùng hóa đơn" },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "Đơn giá HH001");
  assert.deepEqual(
    groups[0].items.map((item) => item.id),
    ["1", "2"],
  );
  assert.equal(groups[1].key, "duplicate_invoice");
});

test("bulk correction selection counts only explicit selected patches", () => {
  const patchSet = {
    groups: [
      { id: "trim", affected_cells: 92, safe: true },
      { id: "date", affected_cells: 34, safe: true },
      { id: "vendor", affected_cells: 2, safe: false },
    ],
  };

  assert.deepEqual(buildCorrectionSelection(patchSet, ["trim", "vendor"]), {
    selectedIds: ["trim", "vendor"],
    affectedCells: 94,
    requiresAcknowledgement: true,
  });
});

test("reconciliation wording never claims three-way completion with fewer than three roles", () => {
  assert.deepEqual(getReconciliationPresentation({ status: "complete" }, 2), {
    kind: "partial",
    label: "Đối chiếu 2 nguồn",
  });
  assert.deepEqual(getReconciliationPresentation({ status: "complete" }, 3), {
    kind: "complete",
    label: "Đã đối chiếu đủ 3 nguồn",
  });
  assert.deepEqual(getReconciliationPresentation({ status: "conflict" }, 3), {
    kind: "conflict",
    label: "Có chênh lệch cần kiểm tra",
  });
});

test("assistant answers are accepted only for the active session revision and evidence packet", () => {
  const session = { sessionId: "s-1", revision: 3, stateHash: "state-3" };
  const valid = {
    evidence_packet_id: "packet-1",
    status: "answered",
    evidence_packet: {
      packet_id: "packet-1",
      session_id: "s-1",
      revision: 3,
      state_hash: "state-3",
      seal: "seal-1",
      items: [{ evidence_id: "evidence-1" }],
    },
    citations: ["evidence-1"],
  };

  assert.equal(isAssistantAnswerCurrent(valid, session), true);
  assert.equal(
    isAssistantAnswerCurrent(
      { ...valid, evidence_packet: { ...valid.evidence_packet, revision: 2 } },
      session,
    ),
    false,
  );
  assert.equal(isAssistantAnswerCurrent({ ...valid, citations: [] }, session), false);
  assert.equal(
    isAssistantAnswerCurrent(
      {
        ...valid,
        status: "unsupported",
        unsupported_reason: "insufficient_evidence",
        citations: [],
      },
      session,
    ),
    true,
  );
});

test("profile V2 match is consumed from the actual analyze suggestion shape", () => {
  assert.deepEqual(extractProfileMatch(ANALYZE_SESSION_FIXTURE), {
    match_tier: "exact",
    profile_id: "profile-2",
    confidence: 0.99,
    warnings: [],
  });
  assert.equal(
    extractProfileMatch({
      mapping_suggestion: {
        source: "profile_v2",
        profile_id: "legacy-inferred-exact",
      },
    }),
    null,
  );
});

test("correction selection uses backend patches and patch IDs", () => {
  const selection = buildCorrectionSelection(CORRECTION_PATCH_SET_FIXTURE, ["patch-1"]);
  assert.deepEqual(selection.selectedIds, ["patch-1"]);
  assert.equal(selection.affectedCells, 1);
  assert.equal(selection.requiresAcknowledgement, false);
});

test("reconciliation presentation consumes backend summary keys", () => {
  const result = getReconciliationPresentation(RECONCILIATION_REPORT_FIXTURE, 2);
  assert.equal(result.kind, "conflict");
  assert.equal(RECONCILIATION_REPORT_FIXTURE.records[0].match_id, "match-1");
});

test("assistant citations are IDs resolved only inside the sealed EvidencePacket", () => {
  const session = { sessionId: "session-1", revision: 3, stateHash: "state-3" };
  assert.equal(isAssistantAnswerCurrent(ASSISTANT_ANSWER_FIXTURE, session), true);
  assert.deepEqual(resolveAssistantCitations(ASSISTANT_ANSWER_FIXTURE), [
    ASSISTANT_ANSWER_FIXTURE.evidence_packet.items[0],
  ]);
  assert.equal(
    isAssistantAnswerCurrent(
      { ...ASSISTANT_ANSWER_FIXTURE, citations: ["invented-evidence"] },
      session,
    ),
    false,
  );
});

test("operation mutation payloads use FastAPI field names", () => {
  const context = { revision: 3, state_hash: "state-3" };
  assert.deepEqual(buildAnomalyReviewPayload(context), {
    revision: 3,
    state_hash: "state-3",
    action: "deferred",
  });
  assert.deepEqual(
    buildCorrectionPayload(context, CORRECTION_PATCH_SET_FIXTURE, ["patch-1"]),
    {
      revision: 3,
      state_hash: "state-3",
      patch_set_id: "patch-set-1",
      selected_patch_ids: ["patch-1"],
    },
  );
  assert.deepEqual(buildUndoPayload(context), {
    expected_revision: 3,
    state_hash: "state-3",
  });
  assert.deepEqual(buildAssistantQuestionPayload(context, "Tổng tiền?", true), {
    revision: 3,
    state_hash: "state-3",
    question: "Tổng tiền?",
    use_ai: true,
  });
});
