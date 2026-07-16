const VALID_MODES = new Set(["auto", "purchase", "sales"]);

const TRANSITIONS = {
  created: new Set(["analyzing", "failed", "expired"]),
  analyzing: new Set(["review_required", "approved", "failed", "expired"]),
  review_required: new Set(["review_required", "approved", "failed", "expired"]),
  approved: new Set([
    "approved",
    "review_required",
    "exported",
    "failed",
    "expired",
  ]),
  exported: new Set(["exported"]),
  failed: new Set(["failed"]),
  expired: new Set(["expired"]),
};

function cleanFileName(value) {
  return String(value || "")
    .replace(/[\\/]/g, "")
    .trim()
    .slice(0, 255);
}

function cleanReconstructionRunPayload(body = {}) {
  const mode = String(body.mode || "auto").toLowerCase();
  return {
    fileName: cleanFileName(body.fileName),
    fileSizeBytes: Number(body.fileSizeBytes || 0),
    workspaceId: String(body.workspaceId || "").trim(),
    mode: VALID_MODES.has(mode) ? mode : "auto",
    targetTemplateId: String(body.targetTemplateId || "").trim().slice(0, 120),
  };
}

function nextRunStatus(current, requested) {
  const from = String(current || "");
  const to = String(requested || "");
  if (!TRANSITIONS[from]?.has(to)) {
    throw new Error(`Chuyển trạng thái reconstruction không hợp lệ: ${from} -> ${to}`);
  }
  return to;
}

function serializeReconstructionRun(run) {
  return {
    id: String(run._id || run.id),
    userId: String(run.user?._id || run.user || ""),
    workspaceId: run.workspace
      ? String(run.workspace?._id || run.workspace)
      : null,
    conversionRunId: String(run.conversionRun?._id || run.conversionRun || ""),
    fileName: run.fileName,
    fileSizeBytes: Number(run.fileSizeBytes || 0),
    sourceFileHash: run.sourceFileHash || "",
    sourceSignatureHash: run.sourceSignatureHash || "",
    mode: run.mode || "auto",
    targetTemplateId: run.targetTemplateId || "",
    status: run.status,
    engineVersion: run.engineVersion || "phase3-v1",
    shadowMode: Boolean(run.shadowMode),
    metrics: run.metrics || {},
    profile: run.profile
      ? { id: String(run.profile?._id || run.profile), version: run.profileVersion || 0 }
      : null,
    workspaceRevision: Number(run.workspaceRevision || 0),
    snapshotSetHash: run.snapshotSetHash || "",
    summary: {
      inputSheets: Number(run.inputSheetCount || 0),
      inputRows: Number(run.inputRowCount || 0),
      draftCount: Number(run.draftCount || 0),
      ready: Number(run.readyCount || 0),
      review: Number(run.reviewCount || 0),
      blocked: Number(run.blockedCount || 0),
      classification: run.classificationSummary || {},
      reconciliation: run.reconciliationSummary || {},
    },
    latestDraftRevision: Number(run.latestDraftRevision || 0),
    approvedAt: run.approvedAt || null,
    exportedAt: run.exportedAt || null,
    creditChargedAt: run.creditChargedAt || null,
    expiresAt: run.expiresAt || null,
    errorCode: run.errorCode || "",
    errorMessage: run.errorMessage || "",
    createdAt: run.createdAt || null,
    updatedAt: run.updatedAt || null,
  };
}

module.exports = {
  VALID_MODES,
  cleanReconstructionRunPayload,
  nextRunStatus,
  serializeReconstructionRun,
};
