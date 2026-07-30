import { Check, CircleAlert, Loader2, RotateCcw, ShieldAlert, Wrench, X } from "lucide-react";
import { useState } from "react";
import { matchBadge } from "../../utils/importRepairUx.js";

const STATUS_OPTIONS = ["failed", "imported"];

const issueIdFor = (issue) => issue.id || issue._id || issue.issueId;

const groupEvidenceText = (group) => {
  const evidence = group?.evidence || {};
  const parts = [];
  if (evidence.documentNumber) parts.push(`Số CT ${evidence.documentNumber}`);
  if (evidence.invoiceNumber) parts.push(`Hóa đơn ${evidence.invoiceNumber}`);
  if (evidence.documentDate) parts.push(`Ngày ${evidence.documentDate}`);
  if (evidence.partnerCode) parts.push(`Đối tượng ${evidence.partnerCode}`);
  if (Number(evidence.lineCount) > 0) parts.push(`${evidence.lineCount} dòng`);
  if (evidence.outputRowNumbers?.length) {
    parts.push(`dòng xuất ${evidence.outputRowNumbers.join(", ")}`);
  }
  return parts.join(" · ") || `ID ${group?.documentGroupId || "không xác định"}`;
};

const candidateEvidenceText = (candidate) => {
  try {
    const evidence = JSON.parse(candidate?.evidence || "{}");
    const fields = Array.isArray(evidence.matched_fields)
      ? evidence.matched_fields.join(", ")
      : "khóa nghiệp vụ";
    const row = Number(evidence.output_row_number);
    return `${candidate.documentGroupId}: khớp ${fields}${row > 0 ? `, dòng xuất ${row}` : ""}`;
  } catch {
    return `${candidate?.documentGroupId || "Chứng từ"}: bằng chứng ghép đã được giới hạn`;
  }
};

const matchableGroups = (issue, groups) => {
  if (issue.matchStatus === "unmatched") return groups;
  const candidateIds = new Set(
    (issue.candidates || []).map((candidate) => String(candidate.documentGroupId)),
  );
  return groups.filter((group) => candidateIds.has(String(group.documentGroupId)));
};

const draftForIssue = (issue, patches, issueId) => {
  if (patches[issueId]) return patches[issueId];
  const patch = issue.resolution?.patch;
  return patch && typeof patch === "object"
    ? { field: patch.field || "", value: patch.value ?? "" }
    : { field: "", value: "" };
};

const ResolutionEditor = ({
  issue,
  rowNumber,
  draft,
  warningAcknowledged,
  busy,
  compact = false,
  onChange,
  onToggleWarning,
  onResolve,
}) => {
  const resolved = issue.resolution?.status === "resolved";
  return <div className="space-y-2">
    {resolved && <p className="text-xs font-bold text-emerald-700">Đã kiểm tra và lưu cách xử lý.</p>}
    <input
      aria-label={`Trường cần sửa cho dòng ${rowNumber}`}
      className={`min-h-11 w-full rounded-xl border border-slate-200 px-3 ${compact ? "text-xs" : "text-sm"}`}
      placeholder="Tên trường"
      value={draft.field || ""}
      onChange={(event) => onChange({ ...draft, field: event.target.value })}
    />
    <input
      aria-label={`Giá trị sửa cho dòng ${rowNumber}`}
      className={`min-h-11 w-full rounded-xl border border-slate-200 px-3 ${compact ? "text-xs" : "text-sm"}`}
      placeholder="Giá trị thay thế"
      value={draft.value ?? ""}
      onChange={(event) => onChange({ ...draft, value: event.target.value })}
    />
    <label className="flex gap-2 text-xs leading-5 text-slate-600">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600"
        checked={warningAcknowledged}
        onChange={(event) => onToggleWarning(event.target.checked)}
      />
      Cho phép lưu nếu kiểm tra cách sửa chỉ còn cảnh báo; blocker vẫn luôn bị chặn.
    </label>
    <button
      type="button"
      className="btn-secondary min-h-11 w-full justify-center"
      onClick={() => onResolve(issue, draft, warningAcknowledged)}
      disabled={busy || !draft.field || draft.value === ""}
    >
      {busy
        ? <Loader2 size={16} className="animate-spin" />
        : resolved ? <RotateCcw size={16} /> : <Wrench size={16} />}
      {resolved ? "Sửa lại cách xử lý" : "Áp dụng cách sửa"}
    </button>
  </div>;
};

const ImportIssueWorkspace = ({ repair, busyId, onConfirmMatch, onSetStatus, onResolve }) => {
  const issues = repair?.issues || [];
  const groups = repair?.documentGroupStatuses || [];
  const [patches, setPatches] = useState({});
  const [manualMatches, setManualMatches] = useState({});
  const [warningAcknowledgements, setWarningAcknowledgements] = useState({});
  const [pendingFailedGroup, setPendingFailedGroup] = useState(null);
  const [wholeDocumentAcknowledged, setWholeDocumentAcknowledged] = useState(false);
  if (!repair) return <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Chưa có lỗi để rà soát.</p>;

  const requestStatusChange = (group, status) => {
    if (status === "failed") {
      setPendingFailedGroup(group);
      setWholeDocumentAcknowledged(false);
      return;
    }
    setPendingFailedGroup(null);
    onSetStatus(group, status);
  };

  const confirmWholeDocumentFailure = () => {
    if (!pendingFailedGroup || !wholeDocumentAcknowledged) return;
    const group = pendingFailedGroup;
    setPendingFailedGroup(null);
    setWholeDocumentAcknowledged(false);
    onSetStatus(group, "failed");
  };

  const updatePatch = (issueId, patch) => {
    setPatches((current) => ({ ...current, [issueId]: patch }));
  };

  const updateWarningAcknowledgement = (issueId, value) => {
    setWarningAcknowledgements((current) => ({ ...current, [issueId]: value }));
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="font-bold text-slate-900">Trạng thái import theo chứng từ</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {groups.map((group) => (
            <label key={group.documentGroupId} className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
              <span className="block font-semibold">Chứng từ {group.documentGroupId}</span>
              <span className="mt-1 block text-xs leading-5 text-slate-500">{groupEvidenceText(group)}</span>
              <select
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-200 px-2"
                value={group.status || "unknown"}
                onChange={(event) => requestStatusChange(group, event.target.value)}
                disabled={busyId === group.documentGroupId}
              >
                <option value="unknown">Chưa xác nhận</option>
                {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status === "failed" ? "Thất bại" : "Đã import"}</option>)}
              </select>
            </label>
          ))}
        </div>
        {pendingFailedGroup && <div role="group" aria-labelledby="whole-document-confirmation" className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 shrink-0 text-amber-700" size={20} />
            <div>
              <p id="whole-document-confirmation" className="font-bold text-amber-950">Xác nhận trước khi cho phép xuất lại</p>
              <p className="mt-1 text-sm leading-6 text-amber-900">Chứng từ {pendingFailedGroup.documentGroupId} · {groupEvidenceText(pendingFailedGroup)}</p>
              <label className="mt-3 flex gap-3 text-sm font-semibold leading-6 text-slate-900">
                <input
                  type="checkbox"
                  checked={wholeDocumentAcknowledged}
                  onChange={(event) => setWholeDocumentAcknowledged(event.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-amber-400 text-primary-600"
                />
                Toàn bộ chứng từ này chưa được MISA nhập
              </label>
              <p className="mt-2 text-xs leading-5 text-amber-800">Không xác nhận nếu MISA đã nhập một phần chứng từ; xuất lại toàn bộ có thể tạo dữ liệu trùng.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button type="button" className="btn-primary min-h-11" onClick={confirmWholeDocumentFailure} disabled={!wholeDocumentAcknowledged || busyId === pendingFailedGroup.documentGroupId}><Check size={16} />Xác nhận chứng từ thất bại</button>
                <button type="button" className="btn-secondary min-h-11" onClick={() => setPendingFailedGroup(null)}><X size={16} />Hủy</button>
              </div>
            </div>
          </div>
        </div>}
      </div>

      <div className="space-y-3 md:hidden" role="region" aria-label="Danh sách lỗi import MISA trên di động">
        {issues.map((issue) => {
          const badge = matchBadge(issue.matchStatus);
          const candidates = issue.candidates || [];
          const issueId = issueIdFor(issue);
          const availableGroups = matchableGroups(issue, groups);
          const selectedGroupId = manualMatches[issueId] || candidates[0]?.documentGroupId || "";
          const selectedGroup = groups.find((group) => group.documentGroupId === selectedGroupId);
          const rowNumber = issue.artifactRowNumber || issue.artifact_row_number || "-";
          const draft = draftForIssue(issue, patches, issueId);
          return <article key={issueId} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
            <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Dòng file lỗi {rowNumber}</p><p className="mt-2 font-bold leading-6 text-slate-950">{issue.technicalMessage || issue.technical_message || issue.message || "Không có thông báo"}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${badge.className}`}>{badge.label}</span></div>
            <dl className="mt-4 grid gap-3 text-sm"><div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Chứng từ gợi ý</dt><dd className="mt-1 font-semibold text-slate-800">{issue.confirmedDocumentGroupId || selectedGroupId || "Chưa ghép"}</dd>{selectedGroup && <dd className="mt-1 text-xs leading-5 text-slate-500">{groupEvidenceText(selectedGroup)}</dd>}</div><div className="rounded-xl bg-cyan-50/70 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-cyan-800">Bằng chứng ghép</dt><dd className="mt-1 leading-6 text-slate-700">{candidates.length ? candidates.map((item, index) => <p key={`${item.documentGroupId}-${index}`}>{candidateEvidenceText(item)}</p>) : "Chưa có gợi ý; hãy chọn một chứng từ trong manifest."}</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Dòng nguồn</dt><dd className="mt-1 text-slate-700">{issue.normalizedLocator?.sourceRowNumber || "Không có"}</dd></div></dl>
            {issue.matchStatus !== "confirmed" && <div className="mt-4 space-y-2"><label className="block text-sm font-bold text-slate-900" htmlFor={`manual-match-mobile-${issueId}`}>Ghép thủ công với chứng từ</label><select id={`manual-match-mobile-${issueId}`} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm" value={selectedGroupId} onChange={(event) => setManualMatches((current) => ({ ...current, [issueId]: event.target.value }))}><option value="">Chọn chứng từ</option>{availableGroups.map((group) => <option key={group.documentGroupId} value={group.documentGroupId}>{group.documentGroupId} · {groupEvidenceText(group)}</option>)}</select><button type="button" className="btn-secondary min-h-11 w-full justify-center" onClick={() => onConfirmMatch(issue, selectedGroupId)} disabled={busyId === issueId || !selectedGroupId}><Check size={16} />Xác nhận ghép</button></div>}
            {issue.matchStatus === "confirmed" && <div className="mt-4"><ResolutionEditor issue={issue} rowNumber={rowNumber} draft={draft} warningAcknowledged={warningAcknowledgements[issueId] === true} busy={busyId === issueId} onChange={(patch) => updatePatch(issueId, patch)} onToggleWarning={(value) => updateWarningAcknowledgement(issueId, value)} onResolve={onResolve} /></div>}
          </article>;
        })}
        {!issues.length && <div className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-600"><CircleAlert className="mx-auto mb-2 text-cyan-600" size={22} />Không tìm thấy dòng lỗi sau khi chuẩn hóa.</div>}
      </div>

      <div className="table-scroll hidden overflow-x-auto rounded-xl border border-slate-200 md:block" aria-label="Danh sách lỗi import MISA">
        <table className="min-w-[1320px] w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr>{["Trạng thái", "Dòng lỗi / nguồn", "Thông báo MISA", "Chứng từ", "Bằng chứng ghép", "Cách sửa", "Hành động"].map((label) => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {issues.map((issue) => {
              const badge = matchBadge(issue.matchStatus);
              const candidates = issue.candidates || [];
              const issueId = issueIdFor(issue);
              const availableGroups = matchableGroups(issue, groups);
              const selectedGroupId = manualMatches[issueId] || candidates[0]?.documentGroupId || "";
              const selectedGroup = groups.find((group) => group.documentGroupId === selectedGroupId);
              const rowNumber = issue.artifactRowNumber || issue.artifact_row_number || "-";
              const draft = draftForIssue(issue, patches, issueId);
              return <tr key={issueId} className="align-top">
                <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${badge.className}`}>{badge.label}</span></td>
                <td className="px-4 py-3 text-slate-700"><span className="block">Lỗi {rowNumber}</span><span className="mt-1 block text-xs text-slate-500">Nguồn {issue.normalizedLocator?.sourceRowNumber || "-"}</span></td>
                <td className="max-w-xs px-4 py-3 text-slate-800">{issue.technicalMessage || issue.technical_message || issue.message || "Không có thông báo"}</td>
                <td className="max-w-xs px-4 py-3 text-slate-700"><span className="font-semibold">{issue.confirmedDocumentGroupId || selectedGroupId || "Chưa ghép"}</span>{selectedGroup && <span className="mt-1 block text-xs leading-5 text-slate-500">{groupEvidenceText(selectedGroup)}</span>}</td>
                <td className="max-w-xs px-4 py-3 text-slate-600">{candidates.length ? candidates.map((item, index) => <p key={`${item.documentGroupId}-${index}`} className="mb-1">{candidateEvidenceText(item)}</p>) : "Chưa có gợi ý; cần ghép thủ công."}</td>
                <td className="w-72 px-4 py-3">{issue.matchStatus === "confirmed" ? <ResolutionEditor issue={issue} rowNumber={rowNumber} draft={draft} warningAcknowledged={warningAcknowledgements[issueId] === true} busy={busyId === issueId} compact onChange={(patch) => updatePatch(issueId, patch)} onToggleWarning={(value) => updateWarningAcknowledgement(issueId, value)} onResolve={onResolve} /> : <span className="text-xs leading-5 text-slate-500">Xác nhận chứng từ trước khi chọn cách sửa.</span>}</td>
                <td className="px-4 py-3"><div className="flex min-w-64 flex-col gap-2">
                  {issue.matchStatus !== "confirmed" ? <><label className="sr-only" htmlFor={`manual-match-${issueId}`}>Ghép thủ công với chứng từ</label><select id={`manual-match-${issueId}`} className="min-h-11 rounded-lg border border-slate-200 px-2 text-xs" value={selectedGroupId} onChange={(event) => setManualMatches((current) => ({ ...current, [issueId]: event.target.value }))}><option value="">Ghép thủ công với chứng từ</option>{availableGroups.map((group) => <option key={group.documentGroupId} value={group.documentGroupId}>{group.documentGroupId} · {groupEvidenceText(group)}</option>)}</select><button type="button" className="btn-secondary min-h-11 justify-center" onClick={() => onConfirmMatch(issue, selectedGroupId)} disabled={busyId === issueId || !selectedGroupId}><Check size={15} />Xác nhận ghép</button></> : <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold leading-5 text-emerald-800">Đã khóa match vào manifest; cách sửa có thể kiểm tra lại.</span>}
                </div></td>
              </tr>;
            })}
            {!issues.length && <tr><td colSpan="7" className="px-4 py-8 text-center text-slate-600"><CircleAlert className="mx-auto mb-2 text-cyan-600" size={22} />Không tìm thấy dòng lỗi sau khi chuẩn hóa.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ImportIssueWorkspace;
