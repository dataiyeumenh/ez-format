import { AlertTriangle, FileWarning, HelpCircle, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatImportRepairError,
  getImportRepairStep,
  getRepairRefreshId,
} from "../../utils/importRepairUx.js";
import ImportIssueWorkspace from "./ImportIssueWorkspace.jsx";
import ImportResultUploadStep from "./ImportResultUploadStep.jsx";
import ImportSchemaMappingStep from "./ImportSchemaMappingStep.jsx";
import MisaNewUserGuide from "./MisaNewUserGuide.jsx";
import RetryBatchReview from "./RetryBatchReview.jsx";

const STEPS = [
  "Chọn conversion run + upload file lỗi",
  "Ghép cột file lỗi",
  "Xác nhận lỗi thuộc chứng từ nào",
  "Sửa và kiểm tra lại",
  "Xuất lại chứng từ thất bại",
];

const repairIdFrom = (repair) => repair?.repairId || repair?.id || repair?._id || "";
const repairStorageKey = (userId) => `ezformat:misa-repair:v1:${userId || "anonymous"}`;
const repairExpiryLabel = (expiresAt) => {
  const value = new Date(expiresAt || "");
  return Number.isFinite(value.getTime())
    ? value.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })
    : "";
};
const repairStepState = (repair, inspection) => {
  if (!repair && !inspection) return 0;
  if (inspection) return 1;
  return getImportRepairStep(repair?.status);
};

const MisaImportRepairPanel = ({ capability, userId, runId, hasManifest, repairApi }) => {
  const enabled = capability?.misa_import_repair?.enabled === true;
  const [open, setOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [repair, setRepair] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [activeStep, setActiveStep] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState("");
  const [resumableRepairId, setResumableRepairId] = useState("");
  const resumeAttemptedRef = useRef(false);
  const api = repairApi;
  const repairId = repairIdFrom(repair);
  const isExpired = Number(repair?.statusCode) === 410 || repair?.status === "expired";
  const currentVersion = repair?.version ?? inspection?.version;

  const stepState = useMemo(() => {
    return repairStepState(repair, inspection);
  }, [inspection, repair]);

  const persistReference = (id) => {
    if (!id) return;
    localStorage.setItem(repairStorageKey(userId), JSON.stringify({ repairId: id, runId }));
    setResumableRepairId(id);
  };

  const recoverFailure = useCallback((requestError) => {
    const status = Number(requestError?.status || requestError?.response?.status || 0);
    if (status === 410) {
      localStorage.removeItem(repairStorageKey(userId));
      setResumableRepairId("");
      setRepair({ status: "expired", statusCode: 410 });
      setOpen(true);
      setRecovery("expired");
      return;
    }
    if (status === 409) {
      setOpen(true);
      setRecovery("stale");
      return;
    }
    if (status === 503 || status === 0 || requestError?.code === "ERR_NETWORK") {
      setOpen(true);
      setRecovery("offline");
      return;
    }
    setOpen(true);
    setError(formatImportRepairError(requestError));
  }, [userId]);

  useEffect(() => {
    resumeAttemptedRef.current = false;
  }, [runId, userId]);

  useEffect(() => {
    if (!enabled || resumeAttemptedRef.current) return;
    resumeAttemptedRef.current = true;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(repairStorageKey(userId)) || "null"); } catch { saved = null; }
    if (!saved?.repairId || (saved.runId && runId && saved.runId !== runId)) return;
    setResumableRepairId(saved.repairId);
    setBusy("resume");
    api.getImportRepair(saved.repairId).then((next) => {
      setRepair(next);
      setInspection(null);
      setActiveStep(repairStepState(next, null));
      setOpen(true);
      setNotice("Đã khôi phục phiên sửa lỗi import trước đó.");
    }).catch(recoverFailure).finally(() => setBusy(""));
  }, [api, enabled, recoverFailure, runId, userId]);

  const refresh = async (id = repairId) => {
    if (!id) return;
    setBusy("refresh"); setError(""); setRecovery("");
    try {
      const next = await api.getImportRepair(id);
      setRepair(next);
      setInspection(null);
      setActiveStep(repairStepState(next, null));
    } catch (requestError) { recoverFailure(requestError); } finally { setBusy(""); }
  };

  const upload = async (file) => {
    setBusy("upload"); setError(""); setNotice(""); setRecovery("");
    try {
      const result = await api.createImportRepair(runId, file, "failed_rows", crypto.randomUUID());
      setRepair({ repairId: result.repairId, status: result.status, version: result.version });
      persistReference(result.repairId);
      setInspection({ ...result.inspection, version: result.version, status: result.status });
      setActiveStep(1);
      setNotice("Đã nhận file lỗi. Hãy ghép cột thông báo MISA trước khi tiếp tục.");
    } catch (requestError) { recoverFailure(requestError); } finally { setBusy(""); }
  };

  const submitSchema = async (payload) => {
    setBusy("schema"); setError("");
    try {
      const result = await api.submitImportResultSchema(repairId, { ...payload, expected_version: currentVersion });
      setRepair({ repairId: result.repairId, status: result.status, version: result.version, summary: result.summary, issues: result.issues });
      setInspection(null); setActiveStep(2); await refresh(result.repairId);
    } catch (requestError) { setError(formatImportRepairError(requestError)); } finally { setBusy(""); }
  };

  const confirmedMutation = async (action, payload, mutate, issueId, groupId) => {
    const confirmation = await api.issueImportRepairConfirmation(repairId, action, payload, issueId, groupId);
    return mutate(confirmation.confirmationToken);
  };

  const confirmMatch = async (issue, documentGroupId) => {
    const issueId = issue.id || issue._id || issue.issueId;
    const payload = { expected_version: currentVersion, document_group_id: documentGroupId };
    setBusy(issueId); setError("");
    try {
      await confirmedMutation("confirm_match", payload, (token) => api.confirmImportIssueMatch(repairId, issueId, payload, token), issueId);
      await refresh(); setNotice("Đã xác nhận chứng từ cho dòng lỗi này.");
    } catch (requestError) { setError(formatImportRepairError(requestError)); } finally { setBusy(""); }
  };

  const setStatus = async (group, status) => {
    if (status === "unknown") return;
    const payload = {
      expected_version: currentVersion,
      status,
      confirmation: status === "failed" ? "entire_document_not_imported" : "imported",
    };
    setBusy(group.documentGroupId); setError("");
    try {
      await confirmedMutation("set_import_status", payload, (token) => api.setDocumentImportStatus(repairId, group.documentGroupId, payload, token), null, group.documentGroupId);
      await refresh();
    } catch (requestError) { setError(formatImportRepairError(requestError)); } finally { setBusy(""); }
  };

  const resolveIssue = async (issue, patch, acknowledgeWarnings = false) => {
    const issueId = issue.id || issue._id || issue.issueId;
    const payload = {
      expected_version: currentVersion,
      scope: "once",
      patch,
      acknowledge_warnings: acknowledgeWarnings,
    };
    setBusy(issueId); setError("");
    try {
      await confirmedMutation("resolve_issue", payload, (token) => api.resolveImportIssue(repairId, issueId, payload, token), issueId);
      await refresh(); setActiveStep(3);
    } catch (requestError) { setError(formatImportRepairError(requestError)); } finally { setBusy(""); }
  };

  const createBatch = async (groupIds, warningsAcknowledged, readinessHash) => {
    const payload = {
      expected_version: currentVersion,
      document_group_ids: groupIds,
      acknowledge_warnings: warningsAcknowledged,
      readiness_hash: readinessHash,
    };
    setBusy("retry"); setError("");
    try {
      const confirmation = await api.issueImportRepairConfirmation(repairId, "retry_export", payload);
      const batch = await api.createRetryBatch(repairId, payload, confirmation.confirmationToken, crypto.randomUUID());
      setRepair((current) => ({ ...current, retryBatch: batch })); setNotice("Đã tạo file xuất lại. Chờ batch hoàn tất rồi tải file.");
      if (batch.status === "completed") setActiveStep(4);
    } catch (requestError) { setError(formatImportRepairError(requestError)); } finally { setBusy(""); }
  };

  const downloadBatch = async (batchId) => {
    setBusy("download"); setError("");
    try {
      const { blob, filename } = await api.downloadRetryBatch(repairId, batchId);
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
      setNotice("Đã tải file chứng từ thất bại để import lại vào MISA.");
    } catch (requestError) { setError(formatImportRepairError(requestError)); } finally { setBusy(""); }
  };

  if (!enabled) return null;

  return <>
    {(hasManifest || resumableRepairId) && <section className="mt-5 rounded-2xl border border-cyan-100 bg-gradient-to-br from-cyan-50/80 via-white to-primary-50/50 p-5 shadow-card" aria-label="Sửa lỗi import MISA">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-700">{resumableRepairId && !hasManifest ? "PHIÊN ĐÃ LƯU" : "Sau khi tải file"}</p><h2 className="mt-1 text-lg font-black text-slate-950">{resumableRepairId && !hasManifest ? "Tiếp tục sửa lỗi import MISA" : "Đã nhập file vào MISA?"}</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{resumableRepairId && !hasManifest ? "Phiên sửa lỗi trước đó vẫn có thể tiếp tục trong thời hạn lưu trữ." : "Nếu MISA báo lỗi, tải file lỗi lên để EzFormat giúp đối chiếu và sửa."}</p></div><div className="flex flex-col gap-2 sm:flex-row"><button type="button" className="btn-primary min-h-11" onClick={() => { setOpen(true); if (resumableRepairId) refresh(resumableRepairId); else setActiveStep(0); }}><FileWarning size={17} />{resumableRepairId ? "Tiếp tục phiên sửa lỗi" : "Tải file lỗi lên"}</button><button type="button" className="btn-secondary min-h-11" onClick={() => setGuideOpen(true)}><HelpCircle size={17} />Xem hướng dẫn</button></div></div>
    </section>}
    {open && <section className="mt-5 rounded-2xl border border-slate-200 bg-white shadow-card" aria-labelledby="repair-wizard-title">
      <header className="flex items-start justify-between gap-4 border-b border-slate-100 p-5 sm:p-6"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-primary-700">Sửa lỗi import MISA</p><h2 id="repair-wizard-title" className="mt-1 text-xl font-black text-slate-950">Chỉ xuất lại chứng từ đã xác nhận</h2></div><button type="button" className="btn-secondary min-h-11 min-w-11 px-3" onClick={() => setOpen(false)} aria-label="Đóng sửa lỗi import"><X size={18} /></button></header>
      <div className="border-b border-slate-100 px-5 py-4 sm:px-6"><ol className="grid gap-2 sm:grid-cols-5" aria-label="Tiến trình sửa lỗi import">{STEPS.map((step, index) => <li key={step}><button type="button" onClick={() => setActiveStep(index)} disabled={index > stepState} aria-current={activeStep === index ? "step" : undefined} className={`flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-bold ${activeStep === index ? "bg-primary-600 text-white" : index <= stepState ? "bg-primary-50 text-primary-800" : "bg-slate-100 text-slate-500"}`}><span>{index + 1}</span><span>{step}</span></button></li>)}</ol></div>
      <div className="p-5 sm:p-6"><div className="sr-only" aria-live="polite">{notice || error}</div>{repair?.expiresAt && <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">Phiên khả dụng đến {repairExpiryLabel(repair.expiresAt)}.</p>}{recovery === "stale" && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-bold">Phiên sửa lỗi đã thay đổi ở tab khác</p><p className="mt-1">Tải lại phiên trước khi tiếp tục để dùng version mới nhất.</p><button type="button" className="btn-secondary mt-3 min-h-11" onClick={() => refresh(getRepairRefreshId(resumableRepairId, repair))} disabled={busy === "refresh"}><RefreshCw size={16} />Tải lại phiên</button></div>}{recovery === "offline" && <div className="mb-4 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-950"><p className="font-bold">Không thể kết nối Converter</p><p className="mt-1">Phiên đã lưu vẫn còn nguyên. Kết nối lại dịch vụ rồi thử lại.</p><button type="button" className="btn-secondary mt-3 min-h-11" onClick={() => refresh(getRepairRefreshId(resumableRepairId, repair))} disabled={busy === "refresh"}><RefreshCw size={16} />Kết nối lại dịch vụ</button></div>}{error && !recovery && <div role="alert" className="mb-4 flex gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertTriangle size={18} className="shrink-0" />{error}</div>}{notice && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</div>}{isExpired ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-5"><p className="font-bold text-amber-900">Phiên sửa lỗi đã hết hạn</p><p className="mt-1 text-sm text-amber-800">Tải lại file lỗi MISA để bắt đầu một phiên mới.</p></div> : <>{activeStep === 0 && <ImportResultUploadStep runId={runId} disabled={!hasManifest} loading={busy === "upload"} onSubmit={upload} />}{activeStep === 1 && <ImportSchemaMappingStep inspection={inspection || repair} loading={busy === "schema"} onSubmit={submitSchema} />}{activeStep === 2 && <ImportIssueWorkspace repair={repair} busyId={busy} onConfirmMatch={confirmMatch} onSetStatus={setStatus} onResolve={resolveIssue} />}{activeStep === 3 && <div className="space-y-4"><p className="rounded-xl border border-cyan-100 bg-cyan-50 p-4 text-sm leading-6 text-cyan-950">Rà từng lỗi, xác nhận chứng từ, rồi chọn cách sửa trong bảng. Khi mọi dòng đã resolved, sang bước xuất lại.</p><button type="button" className="btn-secondary min-h-11" onClick={() => { setActiveStep(2); refresh(); }} disabled={busy === "refresh"}>{busy === "refresh" ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />}Rà lại trạng thái</button></div>}{activeStep === 4 && <RetryBatchReview repair={repair} busy={busy === "retry" || busy === "download"} onCreate={createBatch} onDownload={downloadBatch} />}</>}</div>
    </section>}
    <MisaNewUserGuide open={guideOpen} onClose={() => setGuideOpen(false)} userId={userId} />
  </>;
};

export default MisaImportRepairPanel;
