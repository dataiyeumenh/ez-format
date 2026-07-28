import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  ExternalLink,
  FileQuestion,
  Loader2,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  isAssistantAnswerCurrent,
  resolveAssistantCitations,
} from "../../utils/converterOperations.js";

const DEFAULT_SUGGESTIONS = [
  "Tôi cần sửa gì trước khi tải?",
  "Vì sao có cảnh báo tiền hoặc thuế?",
  "Có bao nhiêu chứng từ chưa đối chiếu?",
];

function aiStatusText(aiOnline) {
  if (aiOnline === true) {
    return "AI đang hỗ trợ diễn giải; kết quả vẫn dựa trên dữ liệu và quy tắc.";
  }
  if (aiOnline === false) {
    return "AI diễn giải đang ngoại tuyến. Tra cứu và phép tính xác định vẫn hoạt động.";
  }
  return "AI diễn giải chưa được cấu hình. Tra cứu xác định vẫn hoạt động.";
}

export default function AccountingAssistantDrawer({
  session,
  fileName = "File hiện tại",
  aiOnline = null,
  suggestions = DEFAULT_SUGGESTIONS,
  onAsk,
  onEvidence,
}) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (value = question) => {
    const prompt = String(value || "").trim();
    if (!prompt || loading || !session?.sessionId) return;
    setLoading(true);
    setError("");
    try {
      const answer = await onAsk?.(prompt);
      if (!answer || !isAssistantAnswerCurrent(answer, session)) {
        throw new Error("Câu trả lời không khớp phiên bản dữ liệu hiện tại.");
      }
      setMessages((current) => [...current, { question: prompt, answer }]);
      setQuestion("");
    } catch (requestError) {
      setError(requestError?.message || "Chưa đủ dữ liệu để kết luận.");
    } finally {
      setLoading(false);
    }
  };

  const statusText = aiStatusText(aiOnline);

  return (
    <Dialog.Root>
      <div className="fixed bottom-6 left-4 z-40 flex max-w-[calc(100vw-6rem)] flex-col items-start gap-1 sm:left-auto sm:right-6 sm:items-end">
        <Dialog.Trigger className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white shadow-xl transition hover:-translate-y-0.5 hover:bg-blue-700 focus-visible:ring-slate-900 motion-reduce:transform-none">
          <FileQuestion size={18} /> Hỏi về file này
        </Dialog.Trigger>
        <p className="sr-only">{statusText}</p>
      </div>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-950/40 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed inset-0 z-[91] flex flex-col bg-white outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[420px] sm:shadow-2xl">
          <header className="border-b border-slate-200 bg-gradient-to-br from-slate-950 to-blue-950 px-5 pb-5 pt-4 text-white">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="flex items-center gap-2 text-lg font-black">
                  <Bot size={20} /> Hỏi về file này
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-blue-100">
                  {fileName} · Phiên bản {session?.revision ?? "—"}
                </Dialog.Description>
              </div>
              <Dialog.Close
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-blue-100 hover:bg-white/10"
                aria-label="Đóng trợ lý kế toán"
              >
                <X size={20} />
              </Dialog.Close>
            </div>
            <div className="mt-4 flex gap-2 rounded-xl bg-white/10 p-3 text-xs leading-relaxed text-blue-50">
              <ShieldCheck className="mt-0.5 shrink-0 text-emerald-300" size={16} />
              {statusText}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <section aria-labelledby="assistant-suggestions">
              <h2
                id="assistant-suggestions"
                className="text-xs font-black uppercase tracking-wider text-slate-500"
              >
                Gợi ý
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="min-h-11 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-left text-sm font-semibold text-blue-900 hover:border-blue-300 hover:bg-blue-100"
                    onClick={() => submit(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </section>

            <div className="mt-6 space-y-5" aria-live="polite">
              {messages.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center">
                  <FileQuestion className="mx-auto text-slate-300" size={30} />
                  <p className="mt-3 text-sm font-semibold text-slate-700">
                    Câu trả lời sẽ kèm nguồn từ file, phép tính hoặc tài liệu đã kiểm
                    chứng.
                  </p>
                </div>
              )}
              {messages.map((entry, index) => (
                <article key={`${entry.question}-${index}`} className="space-y-3">
                  <div className="ml-8 rounded-2xl rounded-tr-md bg-blue-600 p-4 text-sm text-white">
                    <p className="text-xs font-bold text-blue-100">Bạn</p>
                    <p className="mt-1">{entry.question}</p>
                  </div>
                  <div className="mr-5 rounded-2xl rounded-tl-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                    <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                      {entry.answer.answer_type === "deterministic"
                        ? "EzFormat · Có bằng chứng"
                        : entry.answer.answer_type === "ai_worded"
                          ? "EzFormat · Bản nháp AI · Cần kiểm tra"
                          : "EzFormat · Không đủ bằng chứng"}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap leading-relaxed">
                      {entry.answer.answer ||
                        entry.answer.message ||
                        "Chưa đủ dữ liệu để kết luận."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {resolveAssistantCitations(entry.answer).map((citation) =>
                        citation.source_url ? (
                          <a
                            key={citation.evidence_id}
                            href={citation.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-10 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-xs font-bold text-blue-700"
                          >
                            {citation.label || citation.evidence_id}
                            <ExternalLink size={12} />
                          </a>
                        ) : (
                          <button
                            key={citation.evidence_id}
                            type="button"
                            className="min-h-10 rounded-full border border-slate-200 bg-white px-3 text-xs font-bold text-blue-700"
                            onClick={() => onEvidence?.(citation.locator || citation)}
                          >
                            {citation.label || citation.evidence_id}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                </article>
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-600">
                  <Loader2 className="animate-spin text-blue-600" size={18} />
                  Đang kiểm tra bằng chứng…
                </div>
              )}
              {error && (
                <div
                  role="alert"
                  className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900"
                >
                  {error}
                </div>
              )}
            </div>
          </div>

          <form
            className="border-t border-slate-200 bg-white p-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label htmlFor="accounting-question" className="sr-only">
              Nhập câu hỏi về file
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id="accounting-question"
                rows={2}
                maxLength={1000}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Nhập câu hỏi về file…"
                className="min-h-12 flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              />
              <button
                type="submit"
                className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={loading || !question.trim() || !session?.sessionId}
                aria-label="Gửi câu hỏi"
              >
                <Send size={18} />
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Chưa đủ dữ liệu, EzFormat sẽ nói rõ thay vì tự suy đoán nghiệp vụ.
            </p>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
