import { useRef, useState } from "react";
import {
  AlertTriangle,
  FilePlus2,
  FileSpreadsheet,
  Loader2,
  Play,
  Trash2,
} from "lucide-react";
import { getReconciliationPresentation } from "../../utils/converterOperations.js";

const ROLES = [
  ["invoice_export", "Hóa đơn"],
  ["internal_ledger", "Sổ nội bộ"],
  ["payment_list", "Thanh toán"],
  ["inventory_list", "Kho"],
  ["other", "Nguồn khác"],
];

const CANDIDATE_REASONS = {
  invoice_date_counterparty_total: "Số hóa đơn, ngày, đối tác và tổng tiền trùng.",
};

function getCandidateEvidence(record) {
  const deltas = [
    ["Tổng tiền", record.amount_delta],
    ["Số lượng", record.quantity_delta],
    ["VAT", record.vat_delta],
  ]
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `${label}: ${value}`);

  return {
    reason:
      CANDIDATE_REASONS[record.reason] ||
      record.reason ||
      "Hệ thống tìm thấy nhiều bản ghi có dấu hiệu khớp.",
    deltas,
  };
}

export default function ReconciliationWorkspace({
  primaryFile,
  comparisonFiles = [],
  maxFiles = 2,
  report = null,
  loading = false,
  offline = false,
  onAddFile,
  onRemoveFile,
  onRun,
  onSkip,
  onEvidence,
  onConfirmCandidate,
}) {
  const inputRef = useRef(null);
  const [role, setRole] = useState("invoice_export");
  const [candidateSelections, setCandidateSelections] = useState({});
  const sourceCount = 1 + comparisonFiles.length;
  const presentation = getReconciliationPresentation(
    report || { status: "not_run" },
    sourceCount,
  );
  const canAdd = comparisonFiles.length < Math.max(0, maxFiles);
  const comparisonFilesUnavailable = Number(maxFiles) === 0 && comparisonFiles.length === 0;
  const summary = report?.summary || {};

  const chooseFile = (event) => {
    const file = event.target.files?.[0];
    if (file) onAddFile?.(file, role);
    event.target.value = "";
  };

  return (
    <section
      aria-labelledby="reconciliation-title"
      className="rounded-3xl border border-slate-200 bg-white shadow-card"
    >
      <div className="border-b border-slate-100 p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 id="reconciliation-title" className="text-lg font-black text-slate-950">
              Đối chiếu với file khác{" "}
              <span className="font-semibold text-slate-500">(không bắt buộc)</span>
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
              So sánh nguồn chính với hóa đơn, sổ nội bộ hoặc thanh toán để tìm thiếu,
              trùng và chênh lệch.
            </p>
          </div>
          <button type="button" className="btn-secondary min-h-11" onClick={onSkip}>
            Bỏ qua bước này
          </button>
        </div>
      </div>

      {offline && (
        <div
          role="alert"
          className="m-5 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:m-6"
        >
          <AlertTriangle className="mt-0.5 shrink-0" size={18} />
          Dịch vụ đối chiếu đang gián đoạn. File chính và luồng tải MISA vẫn hoạt động.
        </div>
      )}

      {comparisonFilesUnavailable && (
        <div
          role="status"
          className="mx-5 mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 sm:mx-6"
        >
          Đối chiếu bằng file khác chưa được bật. Bạn vẫn có thể tiếp tục chuyển đổi
          file chính.
        </div>
      )}

      <div className="grid gap-3 p-5 md:grid-cols-3 sm:p-6">
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-black uppercase tracking-wide text-blue-700">
            Nguồn chính
          </p>
          <p className="mt-2 truncate font-bold text-blue-950">
            {primaryFile?.name || "File đang chuyển đổi"}
          </p>
          <p className="mt-1 text-xs text-blue-700">
            Không bị thay đổi bởi file đối chiếu
          </p>
        </div>
        {comparisonFiles.map((file) => (
          <div
            key={file.id || file.file_id || file.name}
            className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                  {ROLES.find(([value]) => value === file.role)?.[1] ||
                    file.role ||
                    "Đối chiếu"}
                </p>
                <p className="mt-2 truncate font-bold text-slate-900">
                  {file.name || file.filename}
                </p>
              </div>
              <button
                type="button"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-red-50 hover:text-red-700"
                aria-label={`Bỏ file ${file.name || file.filename}`}
                onClick={() => onRemoveFile?.(file)}
              >
                <Trash2 size={17} />
              </button>
            </div>
            {file.error && (
              <p role="alert" className="mt-2 text-xs font-semibold text-red-700">
                {file.error}
              </p>
            )}
          </div>
        ))}
        {canAdd && (
          <div className="rounded-2xl border border-dashed border-slate-300 p-4">
            <label className="text-xs font-bold uppercase tracking-wide text-slate-600">
              Loại nguồn
              <select
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {ROLES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <input
              ref={inputRef}
              type="file"
              accept=".xls,.xlsx"
              className="hidden"
              onChange={chooseFile}
            />
            <button
              type="button"
              className="btn-secondary mt-3 min-h-11 w-full"
              disabled={loading || offline}
              onClick={() => inputRef.current?.click()}
            >
              <FilePlus2 size={17} /> Thêm file đối chiếu
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-y border-slate-100 bg-slate-50/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <p className="font-bold text-slate-900">{presentation.label}</p>
          <p className="text-sm text-slate-500">
            {comparisonFilesUnavailable
              ? "Không hỗ trợ file đối chiếu"
              : `${sourceCount}/3 nguồn hiện có`}
          </p>
        </div>
        <button
          type="button"
          className="btn-primary min-h-11"
          disabled={loading || offline || comparisonFiles.length === 0}
          onClick={onRun}
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Play size={16} />
          )}
          {loading ? "Đang đối chiếu…" : "Chạy đối chiếu"}
        </button>
      </div>

      {report && (
        <div className="p-5 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-2xl bg-emerald-50 p-4">
              <p className="text-xs font-bold text-emerald-700">Khớp</p>
              <p className="mt-1 text-2xl font-black text-emerald-950">
                {summary.matched || 0}
              </p>
            </div>
            <div className="rounded-2xl bg-amber-50 p-4">
              <p className="text-xs font-bold text-amber-700">Thiếu</p>
              <p className="mt-1 text-2xl font-black text-amber-950">
                {Number(summary.missing_primary || 0) +
                  Number(summary.missing_comparison || 0)}
              </p>
            </div>
            <div className="rounded-2xl bg-red-50 p-4">
              <p className="text-xs font-bold text-red-700">Lệch</p>
              <p className="mt-1 text-2xl font-black text-red-950">
                {summary.conflicts || 0}
              </p>
            </div>
            <div className="rounded-2xl bg-blue-50 p-4">
              <p className="text-xs font-bold text-blue-700">Cần xác nhận</p>
              <p className="mt-1 text-2xl font-black text-blue-950">
                {summary.candidates_need_review || 0}
              </p>
            </div>
          </div>
          <div className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200">
            {(report.records || []).map((record, index) => {
              const recordKey =
                record.match_id ||
                record.primary_record_id ||
                record.comparison_record_id ||
                `${record.status}-${index}`;
              const options = record.comparison_record_ids || [];
              const optionLabels = new Map(
                (record.comparison_options || []).map((option) => [
                  option.record_id,
                  option.label,
                ]),
              );
              const isAmbiguousCandidate =
                record.status === "candidate" && options.length > 1;
              const selectedOption =
                candidateSelections[recordKey] ??
                (isAmbiguousCandidate
                  ? ""
                  : options[0] || record.comparison_record_id || "");
              const candidateEvidence =
                record.status === "candidate" ? getCandidateEvidence(record) : null;
              return (
                <article
                  key={recordKey}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-bold text-slate-900">
                      {record.invoice_number || record.label || "Chứng từ"}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {record.message || record.status}
                    </p>
                    {candidateEvidence && (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                        <p className="font-semibold">Bằng chứng đối chiếu</p>
                        <p className="mt-1">{candidateEvidence.reason}</p>
                        {candidateEvidence.deltas.length > 0 && (
                          <p className="mt-1 text-amber-800">
                            Chênh lệch: {candidateEvidence.deltas.join(" · ")}
                          </p>
                        )}
                        {isAmbiguousCandidate && (
                          <p className="mt-1 text-amber-800">
                            Có {options.length} bản ghi có thể khớp. Chọn một bản ghi trước
                            khi xác nhận.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <button
                      type="button"
                      className="btn-secondary min-h-11"
                      onClick={() => onEvidence?.(record)}
                    >
                      <FileSpreadsheet size={16} /> Xem nguồn
                    </button>
                    {record.status === "candidate" && (
                      <>
                        {options.length > 1 && (
                          <select
                            aria-label="Chọn bản ghi đối chiếu"
                            className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                            value={selectedOption}
                            onChange={(event) =>
                              setCandidateSelections((current) => ({
                                ...current,
                                [recordKey]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Chọn bản ghi đối chiếu</option>
                            {options.map((option) => (
                              <option key={option} value={option}>
                                {optionLabels.get(option) || option}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          className="btn-primary min-h-11"
                          disabled={!selectedOption}
                          onClick={() =>
                            onConfirmCandidate?.(record, selectedOption || null)
                          }
                        >
                          Xác nhận ghép
                        </button>
                        <button
                          type="button"
                          className="btn-secondary min-h-11"
                          onClick={() => onConfirmCandidate?.(record, null, "reject")}
                        >
                          Không ghép bản ghi này
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
