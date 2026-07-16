import { AlertTriangle, CheckCircle2, FileStack, ShieldAlert } from "lucide-react";

const cards = [
  { key: "draft_count", label: "Chứng từ", icon: FileStack, tone: "slate" },
  { key: "ready", label: "Sẵn sàng", icon: CheckCircle2, tone: "emerald" },
  { key: "needs_review", label: "Cần kiểm tra", icon: AlertTriangle, tone: "amber" },
  { key: "blocked", label: "Bị chặn", icon: ShieldAlert, tone: "red" },
];

const tones = {
  slate: "border-slate-200 bg-slate-50 text-slate-800",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  red: "border-red-200 bg-red-50 text-red-800",
};

export default function ReconstructionSummary({ report }) {
  const summary = report?.summary || {};
  const conservation = report?.row_conservation || {};
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(({ key, label, icon: Icon, tone }) => (
          <div key={key} className={`rounded-2xl border p-4 ${tones[tone]}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-bold uppercase tracking-wide opacity-70">
                {label}
              </span>
              <Icon size={18} />
            </div>
            <p className="mt-2 text-3xl font-black">{summary[key] || 0}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-600">
        <span>
          Dòng nguồn: <strong>{conservation.source_rows || 0}</strong>
        </span>
        <span>
          Đã gán: <strong>{conservation.assigned_rows || 0}</strong>
        </span>
        <span>
          Chưa xử lý: <strong>{conservation.unresolved_rows || 0}</strong>
        </span>
        <span>
          Profile: <strong>{report?.profile?.name || "Chưa có"}</strong>
        </span>
      </div>
    </div>
  );
}
