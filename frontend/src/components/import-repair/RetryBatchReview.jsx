import { Download, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { getRetryGate } from "../../utils/importRepairUx.js";

const RetryBatchReview = ({ repair, busy, onCreate, onDownload }) => {
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const readiness = repair?.readiness || {};
  const readinessSummary = readiness.summary || repair?.readinessSummary || {};
  const gate = getRetryGate({
    summary: repair?.summary,
    readiness: readinessSummary,
    warningsAcknowledged,
    readinessHash: readiness.hash,
    readinessVersion: readiness.version,
    sessionVersion: repair?.version,
  });
  const failedGroupIds = (repair?.documentGroupStatuses || []).filter((group) => group.status === "failed").map((group) => group.documentGroupId);
  const batch = repair?.retryBatch;

  return <div className="space-y-4">
    <div className={`rounded-xl border p-4 ${gate.enabled ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex gap-3"><ShieldCheck className={gate.enabled ? "text-emerald-700" : "text-amber-700"} size={20} /><div><p className="font-bold text-slate-900">Kiểm tra trước khi xuất lại</p><p className="mt-1 text-sm text-slate-700">{gate.reason}</p></div></div>
      {readiness.issues?.length > 0 && <ul className="mt-4 space-y-2" aria-label="Chi tiết readiness">{readiness.issues.map((issue, index) => <li key={`${issue.code || "readiness"}-${index}`} className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-sm text-slate-700"><span className="font-bold text-amber-800">{issue.code || issue.severity}</span>{issue.field ? ` · ${issue.field}` : ""}{issue.rowNumber ? ` · dòng ${issue.rowNumber}` : ""}<span className="mt-1 block">{issue.message || "Cần rà soát trước khi xuất lại."}</span></li>)}</ul>}
      {Number(readinessSummary.warning || 0) > 0 && <label className="mt-4 flex min-h-11 items-center gap-3 text-sm font-medium text-slate-800"><input type="checkbox" checked={warningsAcknowledged} onChange={(event) => setWarningsAcknowledged(event.target.checked)} className="h-5 w-5 rounded border-slate-300 text-primary-600" />Tôi đã rà soát {readinessSummary.warning} cảnh báo trong phiên kiểm tra này.</label>}
    </div>
    <div className="flex flex-col gap-3 sm:flex-row">
      <button type="button" className="btn-primary min-h-11" onClick={() => onCreate(failedGroupIds, warningsAcknowledged, readiness.hash)} disabled={!gate.enabled || busy || !failedGroupIds.length}>{busy ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}Tạo file xuất lại</button>
      {batch?.batchId && batch?.status === "completed" && <button type="button" className="btn-secondary min-h-11" onClick={() => onDownload(batch.batchId)}><Download size={17} />Tải file xuất lại</button>}
    </div>
  </div>;
};

export default RetryBatchReview;
