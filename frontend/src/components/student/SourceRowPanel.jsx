import { AlertTriangle, Loader2, TableProperties, X } from "lucide-react";
import { buildStudentSourceRowItems } from "../../utils/studentAssistant";

export default function SourceRowPanel({ state, onClose }) {
  if (!state || state.status === "idle") return null;
  const items = buildStudentSourceRowItems(state.data, state.selectedField);

  return (
    <section
      className="overflow-hidden rounded-3xl border border-cyan-200 bg-white shadow-card xl:col-span-3"
      aria-label="Dòng nguồn được chọn"
    >
      <div className="flex items-start justify-between gap-4 border-b border-cyan-100 bg-cyan-50 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-2xl bg-white p-2.5 text-cyan-700 shadow-sm">
            <TableProperties size={20} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-cyan-700">
              Exact source row
            </p>
            <h2 className="mt-1 text-lg font-black text-gray-950">
              {state.data
                ? `${state.data.sheet || "Sheet"} · dòng ${state.data.worksheet_row}`
                : `Dòng ${state.worksheetRow || "-"}`}
            </h2>
            <p className="mt-1 text-xs text-cyan-900/70">
              Trường evidence: {state.selectedField || "-"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng dòng nguồn"
          className="rounded-full p-2 text-cyan-800 hover:bg-cyan-100"
        >
          <X size={18} />
        </button>
      </div>

      {state.status === "loading" && (
        <div className="flex items-center justify-center gap-2 p-8 text-sm font-bold text-cyan-800">
          <Loader2 className="animate-spin" size={18} /> Đang tải đúng dòng nguồn…
        </div>
      )}
      {state.status === "error" && (
        <div className="flex items-center gap-2 p-5 text-sm font-bold text-red-700">
          <AlertTriangle size={18} /> {state.error}
        </div>
      )}
      {state.status === "ready" && (
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <div
              key={item.field}
              className={`min-w-0 rounded-2xl border p-3 ${
                item.selected
                  ? "border-cyan-400 bg-cyan-50 ring-2 ring-cyan-200"
                  : "border-slate-200 bg-slate-50"
              }`}
              aria-current={item.selected ? "true" : undefined}
            >
              <p className="truncate text-[11px] font-black uppercase tracking-wide text-gray-500">
                {item.field}
              </p>
              <p className="mt-1 break-words font-mono text-xs text-gray-900">
                {item.value === null || item.value === undefined || item.value === ""
                  ? "—"
                  : String(item.value)}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
