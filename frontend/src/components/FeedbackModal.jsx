import { useState } from "react";
import { MessageSquarePlus, X, CheckCircle2 } from "lucide-react";
import { FEEDBACK_CATEGORIES, submitFeedback } from "../services/feedback";

const MAX_LENGTH = 2000;

const FeedbackModal = ({ open, onClose }) => {
  const [category, setCategory] = useState("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | success | error
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setCategory("bug");
    setMessage("");
    setStatus("idle");
    setError("");
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
      setStatus("success");
      setTimeout(() => {
        reset();
        onClose();
      }, 1800);
    } catch (err) {
      setStatus("error");
      setError(
        err.response?.data?.message ||
          err.message ||
          "Không gửi được góp ý. Vui lòng thử lại sau.",
      );
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-900/50 p-4 animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-6 shadow-2xl shadow-gray-300/60"
        onClick={(event) => event.stopPropagation()}
      >
        {status === "success" ? (
          <div className="flex flex-col items-center py-6 text-center">
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
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                  <MessageSquarePlus size={20} />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Gửi góp ý</h2>
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

            <form onSubmit={handleSubmit} className="space-y-4">
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
                  onChange={(event) => setMessage(event.target.value.slice(0, MAX_LENGTH))}
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
          </>
        )}
      </div>
    </div>
  );
};

export default FeedbackModal;
