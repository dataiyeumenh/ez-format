import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellRing, Loader2, RefreshCw } from "lucide-react";
import api from "../services/api";
import { formatNoticeDate, formatUnreadCount } from "../utils/notices";

export default function NoticeBell({ mobile = false }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notices, setNotices] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState("");
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  const loadNotices = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/notices", { params: { limit: 20 } });
      setNotices(data.notices || []);
      setUnreadCount(Math.max(0, Number(data.unreadCount) || 0));
      return data;
    } catch (requestError) {
      if (!silent) {
        setError(requestError.response?.data?.message || "Không thể tải thông báo.");
      }
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotices({ silent: true });
  }, [loadNotices]);

  useEffect(() => {
    const clearUnread = () => setUnreadCount(0);
    window.addEventListener("ezformat:notices-read", clearUnread);
    return () => window.removeEventListener("ezformat:notices-read", clearUnread);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const focusFrame = requestAnimationFrame(() => panelRef.current?.focus());
    const closeOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggle = async () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (!nextOpen) return;

    const data = await loadNotices();
    if (!data?.readCursor || !data.unreadCount) return;

    try {
      await api.post("/notices/read", { readThrough: data.readCursor });
      setUnreadCount(0);
      window.dispatchEvent(new Event("ezformat:notices-read"));
    } catch {
      // Keep the badge so the user can retry by reopening the panel.
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={
          unreadCount > 0
            ? `Thông báo, ${unreadCount} thông báo chưa đọc`
            : "Thông báo"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${unreadCount > 0 ? "bg-blue-50 text-blue-700 hover:bg-blue-100" : "text-gray-500 hover:bg-gray-100 hover:text-gray-800"}`}
      >
        {unreadCount > 0 ? <BellRing size={20} /> : <Bell size={20} />}
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-rose-500 px-1 text-[10px] font-extrabold leading-none text-white shadow-sm"
          >
            {formatUnreadCount(unreadCount)}
          </span>
        )}
      </button>

      {open && (
        <section
          ref={panelRef}
          role="dialog"
          aria-label="Danh sách thông báo"
          tabIndex={-1}
          className={`${mobile ? "fixed inset-x-4 top-16 w-auto" : "absolute right-0 top-full mt-3 w-[min(22rem,calc(100vw-2rem))]"} z-[60] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-300/40 outline-none`}
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Thông báo</h2>
              <p className="text-xs text-slate-400">Cập nhật mới nhất từ EzFormat</p>
            </div>
            <button
              type="button"
              onClick={loadNotices}
              disabled={loading}
              aria-label="Tải lại thông báo"
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </button>
          </div>

          <div className="max-h-[min(26rem,65vh)] overflow-y-auto">
            {loading ? (
              <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-slate-500">
                <Loader2 size={17} className="animate-spin text-blue-600" />
                Đang tải thông báo...
              </div>
            ) : error ? (
              <div className="flex min-h-40 flex-col items-center justify-center px-5 text-center">
                <p className="text-sm text-rose-600">{error}</p>
                <button
                  type="button"
                  onClick={loadNotices}
                  className="mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700"
                >
                  Thử lại
                </button>
              </div>
            ) : notices.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center px-5 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                  <BellRing size={20} />
                </div>
                <p className="text-sm font-semibold text-slate-700">Chưa có thông báo</p>
                <p className="mt-1 text-xs text-slate-400">
                  Các cập nhật từ EzFormat sẽ xuất hiện tại đây.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {notices.map((notice) => (
                  <article key={notice.id} className="px-4 py-4 hover:bg-slate-50/80">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <BellRing size={15} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="break-words text-sm font-bold text-slate-900">
                          {notice.title}
                        </h3>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-slate-600">
                          {notice.description}
                        </p>
                        <time className="mt-2 block text-[11px] font-medium text-slate-400">
                          {formatNoticeDate(notice.createdAt)}
                        </time>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
