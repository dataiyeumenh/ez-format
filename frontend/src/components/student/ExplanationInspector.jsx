import * as Dialog from "@radix-ui/react-dialog";
import { BookOpenCheck, ExternalLink, X } from "lucide-react";
import { formatStudentEvidenceLabel } from "../../utils/studentAssistant";

const severityTone = {
  blocker: "bg-red-100 text-red-800",
  warning: "bg-amber-100 text-amber-800",
  info: "bg-blue-100 text-blue-800",
  none: "bg-slate-100 text-slate-700",
};

function InspectorContent({ explanation, compact = false }) {
  if (!explanation) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
        <BookOpenCheck className="text-slate-300" size={34} />
        <h2 className="mt-3 text-base font-black text-gray-900">
          Chọn một mục để hiểu
        </h2>
        <p className="mt-1 max-w-xs text-sm leading-6 text-gray-500">
          Chọn mapping, ô xem trước hoặc lỗi để mở giải thích cùng bằng chứng.
        </p>
      </div>
    );
  }

  return (
    <div className={compact ? "max-h-[78vh] overflow-y-auto px-5 pb-7" : "p-5"}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide ${
            severityTone[explanation.severity] || severityTone.none
          }`}
        >
          {explanation.severity === "none" ? "Giải thích" : explanation.severity}
        </span>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
          Deterministic
        </span>
      </div>
      <h2 className="mt-4 text-xl font-black tracking-tight text-gray-950">
        {explanation.title}
      </h2>
      {explanation.target_field && (
        <p className="mt-1 text-xs font-bold text-primary-700">
          Trường đích: {explanation.target_field}
        </p>
      )}

      <div className="mt-5 space-y-4 text-sm leading-6">
        <section>
          <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
            Ý nghĩa
          </h3>
          <p className="mt-1 text-gray-700">{explanation.meaning_vi}</p>
        </section>
        <section>
          <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
            Vì sao xuất hiện
          </h3>
          <p className="mt-1 text-gray-700">{explanation.reason_vi}</p>
        </section>
        {explanation.impact_vi && (
          <section>
            <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
              Ảnh hưởng
            </h3>
            <p className="mt-1 text-gray-700">{explanation.impact_vi}</p>
          </section>
        )}
        {explanation.normalized_value !== null &&
          explanation.normalized_value !== undefined && (
            <section className="rounded-2xl bg-slate-50 p-3">
              <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
                Giá trị sau xử lý
              </h3>
              <p className="mt-1 break-words font-mono text-xs text-gray-800">
                {String(explanation.normalized_value)}
              </p>
            </section>
          )}
        <section className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
          <h3 className="text-xs font-black uppercase tracking-[0.12em] text-emerald-700">
            Cách kiểm tra / sửa
          </h3>
          <p className="mt-1 text-emerald-950">{explanation.fix_hint_vi}</p>
        </section>
      </div>

      <section className="mt-6">
        <h3 className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
          Bằng chứng
        </h3>
        <div className="mt-2 space-y-2">
          {(explanation.evidence || []).map((evidence, index) => (
            <div
              key={`${evidence.source_ref}-${index}`}
              className="rounded-2xl border border-slate-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-bold leading-5 text-gray-800">
                  {formatStudentEvidenceLabel(evidence)}
                </p>
                {evidence.source_url && (
                  <a
                    href={evidence.source_url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Mở nguồn quy tắc"
                    className="shrink-0 text-primary-600 hover:text-primary-800"
                  >
                    <ExternalLink size={15} />
                  </a>
                )}
              </div>
              {evidence.raw_value !== null && evidence.raw_value !== undefined && (
                <p className="mt-2 break-words rounded-lg bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-gray-600">
                  {String(evidence.raw_value)}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function ExplanationInspector({
  explanation,
  mobileOpen,
  onMobileOpenChange,
}) {
  return (
    <>
      <aside
        className="hidden min-h-[620px] rounded-3xl border border-slate-200 bg-white shadow-card xl:block"
        aria-label="Trình giải thích"
      >
        <InspectorContent explanation={explanation} />
      </aside>

      <Dialog.Root
        open={Boolean(explanation) && mobileOpen}
        onOpenChange={onMobileOpenChange}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-950/45 backdrop-blur-[2px] xl:hidden" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 z-[100] max-h-[88vh] rounded-t-[28px] bg-white shadow-2xl xl:hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <Dialog.Title className="text-sm font-black text-gray-950">
                  Giải thích và bằng chứng
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-gray-500">
                  Cùng contract với inspector trên desktop.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-full p-2 text-gray-500 hover:bg-slate-100"
                  aria-label="Đóng trình giải thích"
                >
                  <X size={20} />
                </button>
              </Dialog.Close>
            </div>
            <InspectorContent explanation={explanation} compact />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
