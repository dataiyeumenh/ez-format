import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw } from "lucide-react";
import { getReconciliationStatusState } from "../../utils/studentAssistant";

export default function ReconciliationPanel({ data, loading, error, onRefresh }) {
  if (loading) return <p className="rounded-3xl bg-white p-6 text-sm text-slate-600">Đang đối chiếu các tổng độc lập…</p>;
  if (error) return <button type="button" onClick={onRefresh} className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-800">{error} · Thử lại</button>;
  if (!data) return null;
  return (
    <section>
      <div className="flex items-center justify-between"><div><h2 className="text-xl font-black text-slate-950">Reconciliation</h2><p className="text-sm text-slate-500">Kết quả deterministic; lý do bên dưới chỉ là giả thuyết.</p></div><button type="button" onClick={onRefresh} className="rounded-xl border border-slate-200 p-2" aria-label="Tải lại đối chiếu"><RefreshCw size={17} /></button></div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {(data.items || []).map((item) => {
          const state = getReconciliationStatusState(item.status);
          const Icon = state.kind === "success" ? CheckCircle2 : state.kind === "blocker" ? AlertTriangle : HelpCircle;
          return (
            <article key={item.code} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
              <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wide text-slate-500">{item.code}</p><p className="mt-1 font-black text-slate-950">{state.label}</p></div><Icon className={state.kind === "success" ? "text-emerald-600" : state.kind === "blocker" ? "text-rose-600" : "text-amber-600"} /></div>
              {item.left && item.right ? <div className="mt-4 grid grid-cols-2 gap-2 text-sm"><div className="rounded-xl bg-slate-50 p-3"><span className="block text-xs text-slate-500">{item.left.label}</span><strong>{item.left.value}</strong></div><div className="rounded-xl bg-slate-50 p-3"><span className="block text-xs text-slate-500">{item.right.label}</span><strong>{item.right.value}</strong></div></div> : <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-900">insufficient_data — không được coi là khớp.</p>}
              {item.delta !== undefined && <p className="mt-3 text-sm font-black text-slate-800">Chênh lệch: {item.delta} · Dung sai: {item.tolerance ?? "n/a"}</p>}
              {(item.possibleReasonsVi || []).length > 0 && <div className="mt-3 text-xs leading-5 text-slate-600"><strong>Giả thuyết:</strong> {item.possibleReasonsVi.join(" · ")}</div>}
              {item.fixHintVi && <p className="mt-3 rounded-xl bg-blue-50 p-3 text-xs font-bold text-blue-900">{item.fixHintVi}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
