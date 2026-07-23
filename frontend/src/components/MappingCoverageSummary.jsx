const FILTERS = [
  { id: "all", label: "Tất cả", tone: "slate" },
  { id: "mapped", label: "Từ Excel", tone: "blue" },
  { id: "default", label: "Mặc định", tone: "emerald" },
  { id: "formula", label: "Công thức", tone: "cyan" },
  { id: "unmapped", label: "Chưa thiết lập", tone: "amber" },
  { id: "mixed", label: "Nhiều cách điền", tone: "rose" },
  { id: "requiredAttention", label: "Bắt buộc cần rà soát", tone: "red" },
];

const TONES = {
  slate: "border-slate-200 bg-slate-50 text-slate-700",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  cyan: "border-cyan-200 bg-cyan-50 text-cyan-700",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  red: "border-red-200 bg-red-50 text-red-700",
};

export default function MappingCoverageSummary({
  summary,
  activeFilter,
  onFilterChange,
  confidence,
  sourceLabel,
}) {
  if (!summary) return null;

  return (
    <section className="border-b border-slate-200 bg-white px-5 py-4 sm:px-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-base font-black text-slate-950">
            Tổng quan {summary.counts.all} cột theo template
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Chọn một nhóm để chỉ xem những cột cần kiểm tra hoặc chỉnh sửa.
          </p>
        </div>
        <div className="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-800 ring-1 ring-blue-100">
          <div className="font-bold">
            {sourceLabel}
            {confidence !== undefined
              ? ` · Độ tin cậy gợi ý ${Math.round(confidence * 100)}%`
              : ""}
          </div>
          <div className="mt-1 text-blue-700">
            Độ tin cậy ghép cột không phải xác nhận dữ liệu đúng nghiệp vụ.
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const selected = activeFilter === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onFilterChange(filter.id)}
              className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${
                selected
                  ? "border-slate-950 bg-slate-950 text-white shadow-sm"
                  : TONES[filter.tone]
              }`}
            >
              {filter.label} · {summary.counts[filter.id]}
            </button>
          );
        })}
      </div>
    </section>
  );
}
