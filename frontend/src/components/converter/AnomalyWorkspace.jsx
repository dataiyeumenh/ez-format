import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, Loader2, ScanSearch, Sparkles } from "lucide-react";
import {
  filterAnomalies,
  groupAnomalies,
  summarizeAnomalies,
} from "../../utils/converterOperations.js";

const FILTERS = [
  ["all", "Tất cả"],
  ["blockers", "Lỗi chắc chắn"],
  ["anomalies", "Bất thường"],
  ["reviewed", "Đã xem"],
];

function valueText(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default function AnomalyWorkspace({
  issues = [],
  loading = false,
  status = "idle",
  onDetect,
  onReview,
  onEvidence,
  onBulkCorrect,
  bulkCorrectionEnabled = false,
}) {
  const [filter, setFilter] = useState("all");
  const summary = useMemo(() => summarizeAnomalies(issues), [issues]);
  const visibleIssues = useMemo(() => filterAnomalies(issues, filter), [issues, filter]);
  const visibleGroups = useMemo(() => groupAnomalies(visibleIssues), [visibleIssues]);

  return (
    <section aria-labelledby="anomaly-title" className="rounded-3xl border border-slate-200 bg-white shadow-card">
      <div className="flex flex-col gap-4 border-b border-slate-100 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div>
          <div className="flex items-center gap-2">
            <ScanSearch className="text-blue-600" size={20} />
            <h2 id="anomaly-title" className="text-lg font-black text-slate-950">
              Kiểm tra dữ liệu và bất thường
            </h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
            Lỗi xác định có thể chặn tải. Bất thường thống kê chỉ yêu cầu rà soát. Không
            tự chặn tải file.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {bulkCorrectionEnabled && summary.all > 0 && (
            <button type="button" className="btn-secondary min-h-11" onClick={onBulkCorrect}>
              <Sparkles size={16} />
              Sửa hàng loạt
            </button>
          )}
          <button
            type="button"
            className="btn-primary min-h-11"
            disabled={loading}
            onClick={onDetect}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ScanSearch size={16} />}
            {loading ? "Đang kiểm tra…" : "Kiểm tra bất thường"}
          </button>
        </div>
      </div>

      <div className="grid gap-3 p-5 sm:grid-cols-3 sm:p-6" aria-live="polite">
        <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-red-700">Lỗi chắc chắn</p>
          <p className="mt-1 text-2xl font-black text-red-950">{summary.blockers}</p>
        </div>
        <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-700">Cần kiểm tra</p>
          <p className="mt-1 text-2xl font-black text-amber-950">{summary.anomalies}</p>
        </div>
        <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-blue-700">Đã xem</p>
          <p className="mt-1 text-2xl font-black text-blue-950">{summary.reviewed}</p>
        </div>
      </div>

      <div className="border-y border-slate-100 px-5 py-3 sm:px-6">
        <div className="scrollbar-hide flex gap-2 overflow-x-auto" role="toolbar" aria-label="Lọc bất thường">
          {FILTERS.map(([value, label]) => {
            const count = value === "all" ? summary.all : summary[value];
            return (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-bold transition ${
                  filter === value
                    ? "bg-slate-950 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
                onClick={() => setFilter(value)}
              >
                {label} {count}
              </button>
            );
          })}
        </div>
      </div>

      {loading && !issues.length ? (
        <div className="flex min-h-48 items-center justify-center gap-3 p-8 text-sm font-semibold text-slate-600">
          <Loader2 className="animate-spin text-blue-600" size={22} />
          Đang đối chiếu quy tắc và mẫu dữ liệu…
        </div>
      ) : visibleIssues.length === 0 ? (
        <div className="p-8 text-center">
          <CheckCircle2 className="mx-auto text-emerald-500" size={32} />
          <p className="mt-3 font-bold text-slate-900">
            {status === "not_evaluated" ? "Chưa đủ mẫu để đánh giá" : "Không có mục trong bộ lọc này"}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Không có cảnh báo không đồng nghĩa dữ liệu đúng nghiệp vụ tuyệt đối.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-200">
          {visibleGroups.map((group) => (
            <section key={group.key} aria-labelledby={`anomaly-group-${group.key}`}>
              <div className="flex items-center justify-between gap-3 bg-slate-50 px-5 py-3 sm:px-6">
                <h3 id={`anomaly-group-${group.key}`} className="font-bold text-slate-900">
                  {group.label}
                </h3>
                <span className="shrink-0 text-xs font-bold text-slate-500">
                  {group.items.length} mục
                </span>
              </div>
              <div className="divide-y divide-slate-100">
                {group.items.map((issue) => {
                  const blocker =
                    issue.deterministic === true && issue.severity === "blocker";
                  return (
                    <article
                      key={issue.id || `${issue.rule_id}-${issue.row_id}`}
                      className="p-5 sm:p-6"
                    >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {blocker ? (
                        <AlertCircle className="text-red-600" size={18} />
                      ) : (
                        <Eye className="text-amber-600" size={18} />
                      )}
                      <span className={`text-xs font-black uppercase tracking-wide ${blocker ? "text-red-700" : "text-amber-700"}`}>
                        {blocker ? "Lỗi chắc chắn" : "Cần kiểm tra"}
                      </span>
                      {issue.reviewed && <span className="text-xs font-semibold text-blue-700">Đã xem</span>}
                    </div>
                    <h4 className="mt-2 font-bold text-slate-950">{issue.message || issue.rule_id || "Bất thường dữ liệu"}</h4>
                    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                      <div><dt className="text-slate-500">Dòng / cột</dt><dd className="font-semibold text-slate-800">{valueText(issue.row || issue.row_id)} · {valueText(issue.field)}</dd></div>
                      <div><dt className="text-slate-500">Giá trị</dt><dd className="font-semibold text-slate-800">{valueText(issue.actual)}</dd></div>
                      <div><dt className="text-slate-500">Tham chiếu</dt><dd className="font-semibold text-slate-800">{valueText(issue.baseline || issue.expected)}</dd></div>
                    </dl>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                    <button type="button" className="btn-secondary min-h-11" onClick={() => onEvidence?.(issue)}>
                      <Eye size={16} /> Xem nguồn
                    </button>
                    {!issue.reviewed && (
                      <button type="button" className="btn-secondary min-h-11" onClick={() => onReview?.(issue)}>
                        Đánh dấu đã kiểm tra
                      </button>
                    )}
                  </div>
                </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
