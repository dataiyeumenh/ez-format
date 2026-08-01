import { ArrowRight, Calculator, RefreshCw } from "lucide-react";
import {
  getAccountingMapStatusState,
  getAccountingMapPresentationState,
  getAccountingMapTotals,
} from "../../utils/studentAssistant";

const number = (value) => new Intl.NumberFormat("vi-VN").format(Number(value || 0));

export default function AccountingMapPanel({
  data,
  loading,
  error,
  onRefresh,
  onEvidenceNavigate,
}) {
  if (loading)
    return (
      <p className="rounded-3xl bg-white p-6 text-sm text-slate-600">
        Đang dựng sơ đồ hạch toán…
      </p>
    );
  if (error)
    return (
      <button
        type="button"
        onClick={onRefresh}
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-800"
      >
        {error} · Thử lại
      </button>
    );
  const maps = data?.maps || [];
  if (!maps.length)
    return (
      <p className="rounded-3xl bg-white p-6 text-sm text-slate-600">
        Chưa có chứng từ đủ dữ liệu để dựng sơ đồ.
      </p>
    );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-black text-slate-950">Accounting Map</h2>
          <p className="text-sm text-slate-500">
            Nguồn → chứng từ → nghiệp vụ → bút toán → dòng MISA.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-xl border border-slate-200 p-2 text-slate-600"
          aria-label="Tải lại sơ đồ"
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {maps.map((map, mapIndex) => {
        const totals = getAccountingMapTotals(map);
        const presentation = getAccountingMapPresentationState(map);
        const balanceTone = {
          balanced: "bg-emerald-50 text-emerald-900",
          unresolved: "bg-amber-50 text-amber-900",
          unbalanced: "bg-rose-50 text-rose-900",
        }[presentation.kind];
        return (
          <article
            key={map.voucher_id}
            className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-500">
              <span>Dòng nguồn</span>
              <ArrowRight size={14} />
              <span>{map.voucher_id}</span>
              <ArrowRight size={14} />
              <span>{map.business_event}</span>
              <ArrowRight size={14} />
              <span>MISA</span>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {(map.entries || []).map((entry, index) => {
                const state = getAccountingMapStatusState(entry.status);
                const evidenceItems = entry.evidence || [];
                const entryLabel = `${entry.side === "debit" ? "Nợ" : "Có"} ${
                  entry.account || "Chưa xác định"
                }`;
                const evidenceHelpId = `accounting-map-evidence-help-${mapIndex}-${index}`;
                return (
                  <div
                    key={`${entry.side}-${entry.account}-${index}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-black text-slate-950">{entryLabel}</span>
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-slate-700">
                        {state.label}
                      </span>
                    </div>
                    <p className="mt-2 text-lg font-black text-slate-900">
                      {number(entry.amount)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">
                      {entry.reason_vi}
                    </p>
                    {evidenceItems.length > 0 && (
                      <>
                        <p id={evidenceHelpId} className="sr-only">
                          Danh sách có thể cuộn. Dùng phím mũi tên hoặc Page Up và Page
                          Down khi danh sách được focus.
                        </p>
                        <div
                          className="mt-3 max-h-52 space-y-2 overflow-y-auto rounded-xl pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                          role="list"
                          tabIndex={0}
                          aria-label={`Căn cứ cho bút toán ${entryLabel}`}
                          aria-describedby={evidenceHelpId}
                        >
                          {evidenceItems.map((evidence, evidenceIndex) => {
                            const sourceRows = evidence.source_rows || [];
                            const targetField =
                              evidence.target_field || "Chưa xác định";
                            return (
                              <div
                                key={`${map.voucher_id}-${index}-${evidenceIndex}`}
                                role="listitem"
                                className="rounded-xl border border-slate-200 bg-white p-3"
                              >
                                <div className="space-y-1 text-xs text-slate-600">
                                  <p>
                                    Dòng nguồn:{" "}
                                    <span className="font-bold text-slate-900">
                                      {sourceRows.length
                                        ? sourceRows.join(", ")
                                        : "Chưa xác định"}
                                    </span>
                                  </p>
                                  <p>
                                    Trường đích:{" "}
                                    <span className="font-bold text-slate-900">
                                      {targetField}
                                    </span>
                                  </p>
                                </div>
                                {sourceRows.length > 0 && (
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    {sourceRows.map((row, rowIndex) => (
                                      <button
                                        key={`${map.voucher_id}-${index}-${evidenceIndex}-${rowIndex}`}
                                        type="button"
                                        onClick={() =>
                                          onEvidenceNavigate?.({
                                            id: `${map.voucher_id}-${index}-${evidenceIndex}-${rowIndex}`,
                                            row,
                                            field: null,
                                            target_field: evidence.target_field ?? null,
                                          })
                                        }
                                        className="rounded-lg border border-primary-200 bg-white px-2.5 py-1.5 text-xs font-black text-primary-700 underline decoration-primary-300 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                                        aria-label={`Mở dòng nguồn ${row}, trường đích ${targetField}`}
                                      >
                                        Mở dòng {row}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {(map.issues || []).length > 0 && (
              <div
                className="mt-4 space-y-2"
                role="list"
                aria-label="Vấn đề Accounting Map"
              >
                {(map.issues || []).map((issue) => (
                  <p
                    key={`${issue.code}-${issue.message_vi}`}
                    role="listitem"
                    className={`rounded-xl border px-3 py-2 text-sm font-bold ${
                      issue.severity === "blocker"
                        ? "border-rose-200 bg-rose-50 text-rose-900"
                        : "border-amber-200 bg-amber-50 text-amber-900"
                    }`}
                  >
                    {issue.message_vi}
                  </p>
                ))}
              </div>
            )}
            <div
              className={`mt-4 flex flex-wrap items-center gap-4 rounded-2xl p-4 text-sm font-bold ${balanceTone}`}
            >
              <Calculator size={18} />
              {presentation.label} · Nợ {number(totals.debit)} · Có{" "}
              {number(totals.credit)} · Chênh {number(totals.delta)}
            </div>
          </article>
        );
      })}
    </section>
  );
}
