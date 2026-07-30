import { BookOpen, CheckCircle2, ChevronRight, ExternalLink, FlaskConical, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { MISA_IMPORT_GUIDE, MISA_IMPORT_OFFICIAL_LINKS } from "../../content/misaImportGuide.js";

const storageKey = (userId) => `ezformat:misa-guide:v1:${userId || "anonymous"}`;

const MisaNewUserGuide = ({ open, onClose, userId }) => {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const [completedIds, setCompletedIds] = useState(() => new Set());
  const [activeId, setActiveId] = useState(MISA_IMPORT_GUIDE[0].id);
  const activeStep = MISA_IMPORT_GUIDE.find((step) => step.id === activeId) || MISA_IMPORT_GUIDE[0];

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(userId)) || "[]");
      setCompletedIds(new Set(Array.isArray(saved) ? saved : []));
    } catch {
      setCompletedIds(new Set());
    }
  }, [userId]);

  useEffect(() => {
    if (!open) return undefined;
    const appRoot = document.getElementById("root");
    previousFocusRef.current = document.activeElement;
    appRoot?.setAttribute("inert", "");
    appRoot?.setAttribute("aria-hidden", "true");
    closeRef.current?.focus();
    return () => {
      appRoot?.removeAttribute("inert");
      appRoot?.removeAttribute("aria-hidden");
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  const trapFocus = (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...dialogRef.current?.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []];
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const toggleStep = (id) => {
    setCompletedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(storageKey(userId), JSON.stringify([...next]));
      return next;
    });
  };

  if (!open) return null;
  return createPortal(<div className="fixed inset-0 z-50 bg-slate-950/35 p-3 sm:p-6" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="misa-guide-title" className="animate-slide-up ml-auto flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onKeyDown={trapFocus}>
      <header className="flex items-start justify-between border-b border-slate-100 p-5 sm:p-6">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-700">Hướng dẫn nhập MISA</p><h2 id="misa-guide-title" className="mt-1 text-xl font-black text-slate-950">Đi cùng bạn tới lần import đầu tiên</h2><p className="mt-2 text-sm text-slate-600">{completedIds.size}/{MISA_IMPORT_GUIDE.length} bước đã đánh dấu.</p></div>
        <button ref={closeRef} type="button" className="btn-secondary min-h-11 min-w-11 px-3" onClick={onClose} aria-label="Đóng hướng dẫn"><X size={18} /></button>
      </header>
      <div className="table-scroll flex-1 overflow-y-auto p-5 sm:p-6">
        <div className="rounded-2xl border border-cyan-200 bg-gradient-to-br from-cyan-50 to-white p-4 sm:p-5">
          <div className="flex gap-3"><FlaskConical className="mt-0.5 text-cyan-700" size={21} /><div><h3 className="font-bold text-slate-950">Dùng dữ liệu mẫu để thử</h3><p className="mt-1 text-sm leading-6 text-slate-700">Mô phỏng, không phải file MISA xác minh.</p><button type="button" className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 text-sm font-bold text-primary-700 ring-1 ring-primary-100 hover:bg-primary-50" onClick={() => { setActiveId("upload-raw"); toggleStep("choose-document-type"); }}><BookOpen size={16} />Mở lộ trình mô phỏng</button></div></div>
        </div>
        <div className="mt-6 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
          <div><h3 className="text-sm font-bold text-slate-900">Bạn đang ở bước nào trong MISA?</h3><ol className="mt-3 space-y-1">{MISA_IMPORT_GUIDE.map((step, index) => <li key={step.id}><button type="button" onClick={() => setActiveId(step.id)} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors ${activeId === step.id ? "bg-primary-50 font-bold text-primary-800" : "text-slate-700 hover:bg-slate-50"}`}><span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${completedIds.has(step.id) ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}>{completedIds.has(step.id) ? <CheckCircle2 size={15} /> : index + 1}</span>{step.title}</button></li>)}</ol></div>
          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"><div className="flex items-center justify-between gap-3"><p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-700">Bước {MISA_IMPORT_GUIDE.indexOf(activeStep) + 1}</p><button type="button" onClick={() => toggleStep(activeStep.id)} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-primary-700 hover:bg-primary-50"><CheckCircle2 size={17} />{completedIds.has(activeStep.id) ? "Bỏ đánh dấu" : "Đánh dấu xong"}</button></div><h3 className="mt-2 text-xl font-black text-slate-950">{activeStep.title}</h3><div className="mt-5 space-y-4 text-sm leading-6 text-slate-700"><p><strong className="text-slate-950">Vì sao?</strong><br />{activeStep.why}</p><p><strong className="text-slate-950">Bạn cần làm gì?</strong><br />{activeStep.action}</p><p><strong className="text-slate-950">Không chắc thì sao?</strong><br />{activeStep.unsure}</p></div></article>
        </div>
        <div className="mt-6 border-t border-slate-100 pt-5"><h3 className="text-sm font-bold text-slate-900">Nguồn hướng dẫn MISA</h3><div className="mt-3 flex flex-col gap-2 sm:flex-row">{MISA_IMPORT_OFFICIAL_LINKS.map((link) => <a key={link.href} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-primary-700 hover:bg-primary-50" href={link.href} target="_blank" rel="noreferrer"><ExternalLink size={15} />{link.label}<ChevronRight size={15} /></a>)}</div></div>
      </div>
    </section>
  </div>, document.body);
};

export default MisaNewUserGuide;
