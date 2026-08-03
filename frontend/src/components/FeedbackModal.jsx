import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  History,
  Loader2,
  MessageSquarePlus,
  X,
} from "lucide-react";
import {
  FEEDBACK_CATEGORIES,
  fetchMyFeedback,
  rateFeedback,
  submitFeedback,
} from "../services/feedback";
import {
  FEEDBACK_RATINGS,
  formatFeedbackDate,
  getFeedbackStatusMeta,
} from "../utils/feedback";

const MAX_LENGTH = 2000;

function getCategoryLabel(value) {
  return FEEDBACK_CATEGORIES.find((item) => item.value === value)?.label || value;
}

const FeedbackModal = ({ open, onClose }) => {
  const [activeTab, setActiveTab] = useState("submit");
  const [category, setCategory] = useState("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [historyItems, setHistoryItems] = useState([]);
  const [historyState, setHistoryState] = useState("idle");
  const [historyError, setHistoryError] = useState("");
  const [ratingUpdatingId, setRatingUpdatingId] = useState(null);
  const [ratingError, setRatingError] = useState({ id: null, message: "" });

  const loadHistory = useCallback(async () => {
    setHistoryState("loading");
    setHistoryError("");
    try {
      const data = await fetchMyFeedback({ limit: 50 });
      setHistoryItems(data.feedback || []);
      setHistoryState("loaded");
    } catch (requestError) {
      setHistoryError(
        requestError.response?.data?.message || "Không thể tải góp ý của bạn",
      );
      setHistoryState("error");
    }
  }, []);

  useEffect(() => {
    if (open && activeTab === "history" && historyState === "idle") {
      loadHistory();
    }
  }, [activeTab, historyState, loadHistory, open]);

  if (!open) return null;

  const reset = () => {
    setActiveTab("submit");
    setCategory("bug");
    setMessage("");
    setStatus("idle");
    setError("");
    setHistoryItems([]);
    setHistoryState("idle");
    setHistoryError("");
    setRatingUpdatingId(null);
    setRatingError({ id: null, message: "" });
  };

  const handleClose = () => {
    if (status === "submitting") return;
    reset();
    onClose();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      setError("Vui lòng nhập nội dung góp ý.");
      return;
    }
    setStatus("submitting");
    setError("");
    try {
      await submitFeedback({ category, message: trimmed });
      setHistoryState("idle");
      setStatus("success");
      setTimeout(() => {
        reset();
        onClose();
      }, 1800);
    } catch (requestError) {
      setStatus("error");
      setError(
        requestError.response?.data?.message ||
          requestError.message ||
          "Không gửi được góp ý. Vui lòng thử lại sau.",
      );
    }
  };

  const handleRating = async (item, rating) => {
    setRatingUpdatingId(item.id);
    setRatingError({ id: null, message: "" });
    try {
      const data = await rateFeedback(item.id, rating.value);
      setHistoryItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? data.feedback : entry,
        ),
      );
    } catch (requestError) {
      setRatingError({
        id: item.id,
        message:
          requestError.response?.data?.message || "Không thể lưu đánh giá của bạn",
      });
    } finally {
      setRatingUpdatingId(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-900/50 p-4 animate-fade-in"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl shadow-gray-300/60"
        onClick={(event) => event.stopPropagation()}
      >
        {status === "success" ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600">
              <CheckCircle2 size={30} />
            </div>
            <h2 className="mt-4 text-lg font-bold text-gray-900">Cảm ơn bạn đã góp ý!</h2>
            <p className="mt-1 text-sm text-gray-500">
              Góp ý của bạn đã được gửi tới đội ngũ EzFormat.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between px-6 pb-4 pt-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                  <MessageSquarePlus size={20} />
                </div>
                <div>
                  <h2 id="feedback-dialog-title" className="text-base font-bold text-gray-900">
                    Góp ý
                  </h2>
                  <p className="mt-0.5 text-xs text-gray-500">
                    Ý kiến của bạn giúp EzFormat tốt hơn mỗi ngày.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                aria-label="Đóng"
              >
                <X size={18} />
              </button>
            </div>

            <div role="tablist" aria-label="Góp ý" className="mx-6 flex rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "submit"}
                onClick={() => setActiveTab("submit")}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${activeTab === "submit" ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
              >
                Gửi góp ý
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "history"}
                onClick={() => setActiveTab("history")}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${activeTab === "history" ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
              >
                <History size={15} />
                Góp ý của tôi
              </button>
            </div>

            {activeTab === "submit" ? (
              <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
                <div>
                  <label
                    htmlFor="feedback-category"
                    className="mb-1.5 block text-sm font-semibold text-gray-700"
                  >
                    Loại góp ý
                  </label>
                  <select
                    id="feedback-category"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  >
                    {FEEDBACK_CATEGORIES.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="feedback-message"
                    className="mb-1.5 block text-sm font-semibold text-gray-700"
                  >
                    Nội dung
                  </label>
                  <textarea
                    id="feedback-message"
                    value={message}
                    onChange={(event) =>
                      setMessage(event.target.value.slice(0, MAX_LENGTH))
                    }
                    rows={5}
                    placeholder="Bạn gặp lỗi gì, hoặc mong muốn tính năng nào?"
                    className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <div className="mt-1 text-right text-xs text-gray-400">
                    {message.length}/{MAX_LENGTH}
                  </div>
                </div>

                {error && (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2.5 text-sm text-red-600">
                    {error}
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={status === "submitting"}
                    className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={status === "submitting"}
                    className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    {status === "submitting" ? "Đang gửi..." : "Gửi góp ý"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="max-h-[min(28rem,60vh)] overflow-y-auto px-6 py-5">
                {historyState === "loading" ? (
                  <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-500">
                    <Loader2 size={18} className="animate-spin text-blue-600" />
                    Đang tải góp ý...
                  </div>
                ) : historyState === "error" ? (
                  <div className="flex min-h-48 flex-col items-center justify-center text-center">
                    <p className="text-sm text-rose-600">
                      {historyError || "Không thể tải góp ý của bạn"}
                    </p>
                    <button
                      type="button"
                      onClick={loadHistory}
                      className="mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700"
                    >
                      Thử lại
                    </button>
                  </div>
                ) : historyItems.length === 0 ? (
                  <div className="flex min-h-48 flex-col items-center justify-center text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                      <History size={21} />
                    </div>
                    <p className="mt-3 text-sm font-semibold text-slate-700">
                      Bạn chưa gửi góp ý nào
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Góp ý đã gửi và tiến độ xử lý sẽ xuất hiện tại đây.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {historyItems.map((item) => {
                      const statusMeta = getFeedbackStatusMeta(item.status);
                      return (
                        <article
                          key={item.id}
                          className="rounded-xl border border-slate-200 p-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-500">
                              {item.categoryLabel || getCategoryLabel(item.category)}
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusMeta.className}`}
                            >
                              {statusMeta.label}
                            </span>
                          </div>
                          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                            {item.message}
                          </p>
                          <time className="mt-2 block text-xs text-slate-400">
                            {formatFeedbackDate(item.createdAt)}
                          </time>
                          {item.status === "resolved" && (
                            <div className="mt-4 border-t border-slate-100 pt-4">
                              <p className="text-xs font-semibold text-slate-700">
                                Bạn hài lòng với cách xử lý góp ý này không?
                              </p>
                              <div
                                className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3"
                                role="group"
                                aria-label="Đánh giá mức độ hài lòng"
                              >
                                {FEEDBACK_RATINGS.map((rating) => {
                                  const selected = item.rating === rating.value;
                                  return (
                                    <button
                                      key={rating.value}
                                      type="button"
                                      aria-pressed={selected}
                                      disabled={ratingUpdatingId === item.id}
                                      onClick={() => handleRating(item, rating)}
                                      className={`rounded-xl border px-3 py-2 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-60 ${rating.className} ${selected ? "ring-2 ring-offset-1 ring-blue-400" : "opacity-80 hover:opacity-100"}`}
                                    >
                                      {rating.label}
                                    </button>
                                  );
                                })}
                              </div>
                              {ratingError.id === item.id && (
                                <p className="mt-2 text-xs text-rose-600">
                                  {ratingError.message}
                                </p>
                              )}
                              {item.rating && ratingError.id !== item.id && (
                                <p className="mt-2 text-xs text-slate-400">
                                  Đã ghi nhận. Bạn có thể thay đổi đánh giá.
                                </p>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default FeedbackModal;
