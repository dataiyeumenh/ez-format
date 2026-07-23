import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Send,
} from "lucide-react";
import {
  formatStudentQuestionEvidenceLabel,
  getStudentQuestionAnswerState,
  getStudentQuestionSuggestions,
} from "../../utils/studentAssistant";

const stateTone = {
  supported: "bg-emerald-50 text-emerald-800",
  unsupported: "bg-amber-50 text-amber-800",
  ai_unavailable: "bg-slate-100 text-slate-700",
};

export default function FileQuestionPanel({
  targetTemplateId,
  aiStatus,
  history,
  loading,
  error,
  onAsk,
  onRetry,
  onEvidenceNavigate,
}) {
  const [question, setQuestion] = useState("");
  const suggestions = useMemo(
    () => getStudentQuestionSuggestions(targetTemplateId),
    [targetTemplateId],
  );

  const submit = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized || loading) return;
    setQuestion("");
    onAsk(normalized);
  };

  return (
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card xl:col-span-3">
      <div className="grid lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="border-b border-slate-100 bg-slate-950 p-5 text-white lg:border-b-0 lg:border-r lg:border-slate-800">
          <div className="flex items-center gap-3">
            <span className="rounded-2xl bg-cyan-400/15 p-3 text-cyan-200">
              <MessageSquareText size={22} />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.14em] text-cyan-300">
                Phase 2 · Ask About This File
              </p>
              <h2 className="mt-1 text-xl font-black">Hỏi từ dữ liệu đang mở</h2>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-300">
            Hệ thống chạy truy vấn deterministic trước. Mỗi câu trả lời theo file phải có
            evidence hợp lệ; nếu thiếu căn cứ, hệ thống nói rõ là chưa hỗ trợ.
          </p>
          {!["online", "enabled"].includes(String(aiStatus || "").toLowerCase()) && (
            <div className="mt-4 flex gap-2 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-300">
              <Bot className="mt-0.5 shrink-0 text-slate-400" size={16} />
              AI bổ sung không khả dụng; các truy vấn deterministic vẫn hoạt động.
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submit(suggestion)}
                disabled={loading}
                className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-left text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5 sm:p-6">
          <form
            className="flex flex-col gap-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              submit(question);
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="sr-only">Câu hỏi về file đang mở</span>
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={2000}
                placeholder="Ví dụ: Dòng nào lệch tiền thuế GTGT?"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-primary-500 focus:bg-white"
              />
            </label>
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="btn-primary justify-center px-5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="animate-spin" size={17} /> : <Send size={17} />}
              {loading ? "Đang truy vấn" : "Hỏi file"}
            </button>
          </form>

          {error && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-800">
              <span className="flex items-center gap-2">
                <AlertTriangle size={17} /> {error}
              </span>
              <button type="button" onClick={onRetry} className="btn-secondary py-2">
                <RotateCcw size={15} /> Thử lại
              </button>
            </div>
          )}

          <div className="mt-5 space-y-4" aria-live="polite">
            {!history.length && !loading && (
              <div className="rounded-2xl border border-dashed border-slate-200 p-7 text-center">
                <MessageSquareText className="mx-auto text-slate-300" size={30} />
                <p className="mt-2 text-sm font-bold text-gray-800">Chưa có câu hỏi trong phiên</p>
                <p className="mt-1 text-xs text-gray-500">
                  Chọn gợi ý hoặc nhập câu hỏi có thể kiểm tra từ file.
                </p>
              </div>
            )}
            {[...history].reverse().map((entry, index) => {
              const answerState = getStudentQuestionAnswerState(entry.answer);
              return (
                <article
                  key={`${entry.question}-${history.length - index}`}
                  className="rounded-2xl border border-slate-200 p-4"
                >
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-gray-400">
                    Câu hỏi
                  </p>
                  <p className="mt-1 text-sm font-bold text-gray-900">{entry.question}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-black ${stateTone[answerState.kind]}`}
                    >
                      {answerState.label}
                    </span>
                    {answerState.kind === "supported" && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                        <CheckCircle2 size={13} /> {entry.answer.evidence_count} evidence
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-gray-700">{entry.answer.answer}</p>
                  {!!entry.answer.evidence?.length && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {entry.answer.evidence.map((evidence) => (
                        <button
                          key={evidence.id}
                          type="button"
                          onClick={() => onEvidenceNavigate(evidence)}
                          className="rounded-xl border border-cyan-100 bg-cyan-50 px-3 py-2 text-left text-xs font-bold text-cyan-900 hover:border-cyan-300"
                        >
                          <span className="block">
                            {formatStudentQuestionEvidenceLabel(evidence)}
                          </span>
                          {evidence.actual !== null && evidence.actual !== undefined && (
                            <span className="mt-1 block max-w-64 truncate font-mono text-[10px] font-normal text-cyan-700">
                              {String(evidence.actual)}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
