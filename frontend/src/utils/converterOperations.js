export function getProfilePresentation(profileMatch) {
  if (!profileMatch) {
    return {
      kind: "empty",
      label: "Chưa có setting phù hợp",
      driftCount: 0,
      requiresReview: false,
      canUseProfile: false,
      mandatoryPreview: false,
      actualMappingSource: null,
    };
  }
  const driftCount = Array.isArray(profileMatch.drift)
    ? profileMatch.drift.length
    : Number(profileMatch.drift_count || 0);
  const actualMappingSource = profileMatch.mapping_source || null;
  const mandatoryPreview = Boolean(profileMatch.requires_preview);
  const canUseProfile = Boolean(
    profileMatch.match_tier === "exact" &&
    actualMappingSource === "profile_v2" &&
    profileMatch.approval_state === "approved" &&
    profileMatch.approval_applies_to_match === true &&
    profileMatch.can_suggest === true,
  );
  const requiresReview = !canUseProfile;
  let label;
  if (canUseProfile) {
    label = "Khớp chính xác; đã phê duyệt. Bắt buộc xem trước";
  } else if (driftCount > 0) {
    label = `Có ${driftCount} thay đổi cấu trúc cần xem; đang dùng mapping ${
      actualMappingSource || "chưa xác định"
    }`;
  } else if (profileMatch.approval_state !== "approved") {
    label = `Profile khớp nhưng chưa được phê duyệt; đang dùng mapping ${
      actualMappingSource || "chưa xác định"
    }`;
  } else {
    label = `Profile không được áp dụng cho file này; đang dùng mapping ${
      actualMappingSource || "chưa xác định"
    }`;
  }
  return {
    kind: requiresReview ? "review" : "exact",
    label,
    driftCount,
    requiresReview,
    canUseProfile,
    mandatoryPreview,
    actualMappingSource,
  };
}

const GATEWAY_ERROR_MESSAGES = {
  401: "Phiên đăng nhập hết hạn",
  402: "Không còn lượt chuyển đổi",
  403: "Không có quyền dùng hồ sơ này",
  409: "Dữ liệu đã thay đổi; tải lại phiên",
  413: "File vượt 20 MB",
  422: "Còn lỗi MISA cần xử lý",
  429: "Quá nhiều yêu cầu; thử lại sau",
  500: "Dịch vụ tạm thời lỗi; file chưa bị trừ lượt",
};

export function gatewayErrorMessage(error, fallback = "Không thể hoàn tất yêu cầu.") {
  return GATEWAY_ERROR_MESSAGES[Number(error?.response?.status || error?.status)] || fallback;
}

export function gatewayRequestError(error, fallback) {
  const wrapped = new Error(gatewayErrorMessage(error, fallback));
  wrapped.status = error?.response?.status || error?.status;
  wrapped.payload = error?.response?.data || error?.payload;
  return wrapped;
}

export function buildGatewayExportPayload({
  runId,
  uploadId,
  profileId,
  profileVersion = null,
  profileStateHash = null,
  sessionId,
  revision,
  stateHash,
  acknowledgeWarnings = false,
  idempotencyKey,
}) {
  const payload = {
    upload_id: uploadId,
    profile_id: profileId,
    acknowledge_warnings: Boolean(acknowledgeWarnings),
  };
  if (runId) payload.run_id = runId;
  if (sessionId) payload.session_id = sessionId;
  if (revision != null) payload.revision = revision;
  if (stateHash) payload.state_hash = stateHash;
  if (idempotencyKey) payload.idempotency_key = idempotencyKey;
  if (profileVersion != null) payload.profile_version = profileVersion;
  if (profileStateHash) payload.profile_state_hash = profileStateHash;
  return payload;
}

export function getConfirmedProfilePresentation(response = {}) {
  const kind = response.mapping_profile_kind === "v2" ? "v2" : "v1";
  if (kind === "v2" && response.profile_state_hash) {
    return {
      kind,
      label: "Thiết lập V2 đã lưu",
      profileId: response.profile_id || null,
      version: Number(response.mapping_profile_version || 0) || null,
      stateHash: response.profile_state_hash,
      explicitFallback: false,
    };
  }
  return {
    kind: "v1",
    label: "Đã lưu theo thiết lập cũ (V1)",
    profileId: response.profile_id || null,
    version: null,
    stateHash: null,
    explicitFallback: response.mapping_profile_fallback === "legacy_v1",
  };
}

export function extractProfileMatch(analyzePayload) {
  return (
    analyzePayload?.mapping_profile_v2 ||
    analyzePayload?.profile_match ||
    analyzePayload?.mapping_suggestion?.profile_v2 ||
    null
  );
}

function isDeterministicBlocker(issue) {
  if (issue?.deterministic !== true) return false;
  return (
    ["fatal", "blocker"].includes(issue?.severity) ||
    ["system", "export"].includes(issue?.blocking_scope)
  );
}

export function summarizeAnomalies(issues = []) {
  return issues.reduce(
    (summary, issue) => {
      summary.all += 1;
      if (isDeterministicBlocker(issue)) {
        summary.blockers += 1;
      }
      if (issue?.deterministic === false) summary.anomalies += 1;
      if (issue?.reviewed === true || issue?.review_status === "reviewed") {
        summary.reviewed += 1;
      }
      return summary;
    },
    { all: 0, blockers: 0, anomalies: 0, reviewed: 0 },
  );
}

export function filterAnomalies(issues = [], filter = "all") {
  if (filter === "blockers") {
    return issues.filter((issue) => isDeterministicBlocker(issue));
  }
  if (filter === "anomalies") {
    return issues.filter((issue) => issue?.deterministic === false);
  }
  if (filter === "reviewed") {
    return issues.filter(
      (issue) => issue?.reviewed === true || issue?.review_status === "reviewed",
    );
  }
  return issues;
}

export function groupAnomalies(issues = []) {
  const groups = new Map();
  for (const issue of issues) {
    const key = String(
      issue?.group_key || issue?.rule_id || issue?.code || issue?.id || "unclassified",
    );
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: issue?.group_label || issue?.message || "Bất thường dữ liệu",
        items: [],
      });
    }
    groups.get(key).items.push(issue);
  }
  return [...groups.values()];
}

export function buildCorrectionSelection(patchSet = {}, selectedIds = []) {
  const selected = new Set(selectedIds.map(String));
  const patches = (patchSet.patches || patchSet.groups || []).filter((patch) =>
    selected.has(String(patch.patch_id || patch.id)),
  );
  return {
    selectedIds: patches.map((patch) => String(patch.patch_id || patch.id)),
    affectedCells: patches.reduce(
      (total, patch) =>
        total + Math.max(0, Number(patch.affected_cells || patch.row_ids?.length || 1)),
      0,
    ),
    requiresAcknowledgement: patches.some(
      (patch) => patch.risk !== "safe" && patch.safe !== true,
    ),
  };
}

export function buildAnomalyReviewPayload(mutationContext) {
  return { ...mutationContext, action: "deferred" };
}

export function buildCorrectionPayload(mutationContext, patchSet, selectedPatchIds) {
  return {
    ...mutationContext,
    patch_set_id: patchSet?.patch_set_id,
    selected_patch_ids: selectedPatchIds.map(String),
  };
}

export function buildUndoPayload(mutationContext) {
  return {
    expected_revision: mutationContext?.revision,
    state_hash: mutationContext?.state_hash,
  };
}

export function buildAssistantQuestionPayload(
  mutationContext,
  question,
  useAi = false,
) {
  return {
    ...mutationContext,
    question: String(question || "").trim(),
    use_ai: useAi === true,
  };
}

export function getReconciliationPresentation(report = {}, sourceCount = 1) {
  if (report.status === "conflict") {
    return { kind: "conflict", label: "Có chênh lệch cần kiểm tra" };
  }
  if (report.status === "insufficient_evidence") {
    return { kind: "insufficient", label: "Chưa đủ dữ liệu để đối chiếu" };
  }
  if (report.status === "not_run") {
    return { kind: "not_run", label: "Chưa chạy đối chiếu" };
  }
  if (sourceCount < 3) {
    return {
      kind: "partial",
      label: sourceCount > 1 ? `Đối chiếu ${sourceCount} nguồn` : "Chỉ có nguồn chính",
    };
  }
  return { kind: "complete", label: "Đã đối chiếu đủ 3 nguồn" };
}

export function isAssistantAnswerCurrent(answer = {}, session = {}) {
  const packet = answer.evidence_packet || {};
  const boundToCurrentSession =
    packet.session_id === session.sessionId &&
    Number(packet.revision) === Number(session.revision) &&
    packet.state_hash === session.stateHash &&
    answer.evidence_packet_id === packet.packet_id &&
    Boolean(String(packet.seal || "").trim());
  if (!boundToCurrentSession) return false;
  if (
    ["unsupported", "ai_unavailable"].includes(answer.status) &&
    String(answer.unsupported_reason || "").trim()
  ) {
    return true;
  }
  const evidenceIds = new Set((packet.items || []).map((item) => item.evidence_id));
  return Boolean(
    Array.isArray(answer.citations) &&
    answer.citations.length > 0 &&
    answer.citations.every((citationId) => evidenceIds.has(String(citationId))),
  );
}

export function resolveAssistantCitations(answer = {}) {
  const selected = new Set((answer.citations || []).map(String));
  return (answer.evidence_packet?.items || []).filter((item) =>
    selected.has(String(item.evidence_id)),
  );
}
