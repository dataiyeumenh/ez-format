import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { getStudentSummaryItems } from "../../utils/studentAssistant";

const itemTone = {
  blockers: "border-red-100 bg-red-50 text-red-800",
  warnings: "border-amber-100 bg-amber-50 text-amber-800",
  unresolved: "border-amber-100 bg-amber-50 text-amber-800",
};

export default function StudentSessionSummary({ analysis, onReset }) {
  const summary = analysis?.student_summary || {};
  const items = getStudentSummaryItems(summary);
  const syncStatus = analysis?.session_sync?.status;

  return (
    <aside className="space-y-4" aria-label="Tóm tắt phiên giải thích file">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="flex items-start gap-3">
          <span className="rounded-2xl bg-primary-50 p-3 text-primary-700">
            <FileSpreadsheet size={23} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">
              File đang học
            </p>
            <h2 className="mt-1 truncate text-base font-black text-gray-950">
              {summary.file_name || "File Excel"}
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              {analysis?.target_template_id} · Sheet {summary.sheet_name || "-"}
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2 xl:grid-cols-1 2xl:grid-cols-2">
          {items.map((item) => (
            <div
              key={item.key}
              className={`rounded-2xl border p-3 ${
                itemTone[item.key] || "border-slate-100 bg-slate-50 text-gray-900"
              }`}
            >
              <p className="text-[11px] font-semibold text-current/70">{item.label}</p>
              <p className="mt-1 text-lg font-black leading-tight">{item.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="flex items-start gap-3">
          {syncStatus === "unavailable" ? (
            <AlertTriangle className="mt-0.5 text-amber-600" size={20} />
          ) : (
            <ShieldCheck className="mt-0.5 text-emerald-600" size={20} />
          )}
          <div>
            <h3 className="text-sm font-black text-gray-950">Dữ liệu có truy vết</h3>
            <p className="mt-1 text-xs leading-5 text-gray-500">
              Mỗi giải thích đều dẫn về cột, ô nguồn hoặc quy tắc. AI không quyết định
              mapping hay severity.
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
          <CheckCircle2 size={15} />
          {analysis?.explanations?.length || 0} giải thích deterministic
        </div>
        <button
          type="button"
          onClick={onReset}
          className="btn-secondary mt-4 w-full"
        >
          <RefreshCw size={16} /> Phân tích file khác
        </button>
      </section>
    </aside>
  );
}
