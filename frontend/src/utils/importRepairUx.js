export const IMPORT_REPAIR_ERROR_STATUS = new Set([409, 410, 422]);

export function getRepairRefreshId(resumableRepairId, repair) {
  return resumableRepairId || repair?.repairId || repair?.id || repair?._id || "";
}

export function getRetryGate({
  summary = {},
  readiness = {},
  warningsAcknowledged = false,
  readinessHash = "",
  readinessVersion = null,
  sessionVersion = null,
}) {
  if (Number(summary.unknownDocumentGroups || 0) > 0) {
    return { enabled: false, reason: "Còn chứng từ chưa xác nhận đã import hay thất bại." };
  }
  if (
    Object.hasOwn(summary, "failedDocumentGroups") &&
    Number(summary.failedDocumentGroups) === 0
  ) {
    return { enabled: false, reason: "Không có chứng từ thất bại để xuất lại." };
  }
  if (
    Number(summary.unresolvedIssues || 0) > 0 ||
    Number(summary.unmatchedIssues || 0) > 0 ||
    Number(summary.ambiguousIssues || 0) > 0
  ) {
    return { enabled: false, reason: "Còn lỗi chưa ghép hoặc chưa xử lý xong." };
  }
  if (Number(readiness.fatal || 0) > 0 || Number(readiness.blocker || 0) > 0) {
    return { enabled: false, reason: "Readiness còn blocker cần xử lý trước khi xuất lại." };
  }
  if (Number(readiness.warning || 0) > 0 && !warningsAcknowledged) {
    return { enabled: false, reason: "Hãy xác nhận cảnh báo trước khi xuất lại." };
  }
  if (!/^[a-f0-9]{64}$/.test(String(readinessHash || ""))) {
    return { enabled: false, reason: "Chưa có phiên kiểm tra readiness để xuất lại." };
  }
  if (Number(readinessVersion) !== Number(sessionVersion)) {
    return { enabled: false, reason: "Phiên kiểm tra readiness không còn khớp phiên sửa lỗi." };
  }
  return { enabled: true, reason: "Sẵn sàng xuất lại các chứng từ thất bại." };
}

function mergeByStableId(current = [], incoming = [], idFor) {
  const merged = new Map();
  for (const item of [...current, ...incoming]) {
    const id = idFor(item);
    if (id) merged.set(id, item);
  }
  return [...merged.values()];
}

export function mergeImportRepairWorkspacePage(current, page) {
  if (!current) return page;
  const sameSession = String(current.repairId || "") === String(page?.repairId || "") &&
    Number(current.version) === Number(page?.version);
  if (!sameSession) return page;
  return {
    ...current,
    ...page,
    issues: mergeByStableId(
      current.issues,
      page.issues,
      (issue) => String(issue?._id || issue?.id || issue?.issueId || ""),
    ),
    documentGroupStatuses: mergeByStableId(
      current.documentGroupStatuses,
      page.documentGroupStatuses,
      (group) => String(group?.documentGroupId || ""),
    ),
    readiness: page.readiness || current.readiness || null,
  };
}

export function formatImportRepairError(error, fallback = "Không thể hoàn tất thao tác sửa lỗi import.") {
  const status = Number(error?.status || error?.response?.status || 0);
  const message = String(error?.message || "").trim();
  if (IMPORT_REPAIR_ERROR_STATUS.has(status) && message) return message;
  return message || fallback;
}

export function matchBadge(matchStatus) {
  return {
    suggested: { label: "Gợi ý", className: "bg-cyan-50 text-cyan-800 ring-cyan-200" },
    ambiguous: { label: "Mơ hồ", className: "bg-amber-50 text-amber-800 ring-amber-200" },
    confirmed: { label: "Đã xác nhận", className: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
    unmatched: { label: "Chưa ghép", className: "bg-slate-100 text-slate-700 ring-slate-200" },
  }[matchStatus] || { label: "Chưa ghép", className: "bg-slate-100 text-slate-700 ring-slate-200" };
}
