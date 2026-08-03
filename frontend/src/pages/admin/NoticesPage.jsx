import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BellRing,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";
import { formatNoticeDate, normalizeNoticeForm } from "../../utils/notices";

const emptyForm = { title: "", description: "" };

function NoticeDialog({ open, saving, error, onClose, onSubmit }) {
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    if (open) setForm(emptyForm);
  }, [open]);

  const submit = (event) => {
    event.preventDefault();
    onSubmit(form);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-white shadow-2xl outline-none">
          <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
            <div>
              <Dialog.Title className="text-xl font-bold text-slate-950">
                Gửi thông báo
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-500">
                Thông báo sẽ hiển thị cho toàn bộ người dùng EzFormat.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Đóng"
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={submit} className="space-y-5 px-6 py-5">
            {error && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
              >
                {error}
              </div>
            )}

            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                Tiêu đề <span className="text-rose-500">*</span>
              </span>
              <input
                autoFocus
                value={form.title}
                maxLength={120}
                onChange={(event) =>
                  setForm((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Ví dụ: Cập nhật mẫu nhập liệu mới"
                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              />
              <span className="mt-1 block text-right text-xs text-slate-400">
                {form.title.length}/120
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                Nội dung <span className="text-rose-500">*</span>
              </span>
              <textarea
                rows={6}
                value={form.description}
                maxLength={1000}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="Nhập nội dung cần gửi đến người dùng..."
                className="w-full resize-y rounded-xl border border-slate-200 px-3 py-2.5 text-sm leading-relaxed outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              />
              <span className="mt-1 block text-right text-xs text-slate-400">
                {form.description.length}/1000
              </span>
            </label>

            <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={saving}
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  Hủy
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {saving ? "Đang gửi..." : "Gửi cho toàn bộ user"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function NoticesPage() {
  const [notices, setNotices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadNotices = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setPageError("");
    try {
      const { data } = await api.get("/admin/notices", { params: { limit: 50 } });
      setNotices(data.notices || []);
    } catch (error) {
      setPageError(error.response?.data?.message || "Không thể tải thông báo.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadNotices();
  }, [loadNotices]);

  const sendNotice = async (form) => {
    setSaving(true);
    setDialogError("");
    try {
      const payload = normalizeNoticeForm(form);
      const { data } = await api.post("/admin/notices", payload);
      setNotices((current) => [data.notice, ...current]);
      setDialogOpen(false);
      setSuccessMessage("Thông báo đã được gửi đến toàn bộ người dùng.");
    } catch (error) {
      setDialogError(
        error.response?.data?.message || error.message || "Không thể gửi thông báo.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-950">
              Thông báo người dùng
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Gửi cập nhật chung và xem lại lịch sử thông báo đã phát hành.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadNotices({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              Tải lại
            </button>
            <button
              type="button"
              onClick={() => {
                setDialogError("");
                setSuccessMessage("");
                setDialogOpen(true);
              }}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 hover:bg-blue-700"
            >
              <Plus size={17} />
              Gửi thông báo
            </button>
          </div>
        </div>

        {successMessage && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
            {successMessage}
          </div>
        )}
        {pageError && (
          <div className="flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 sm:flex-row sm:items-center sm:justify-between">
            <span>{pageError}</span>
            <button
              type="button"
              onClick={() => loadNotices()}
              className="font-semibold underline underline-offset-2"
            >
              Thử lại
            </button>
          </div>
        )}

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div>
              <h2 className="font-bold text-slate-900">Lịch sử đã gửi</h2>
              <p className="mt-0.5 text-xs text-slate-400">Tối đa 50 thông báo mới nhất</p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              {notices.length} thông báo
            </span>
          </div>

          {loading ? (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 size={18} className="animate-spin text-blue-600" />
              Đang tải thông báo...
            </div>
          ) : notices.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                <BellRing size={26} />
              </div>
              <h3 className="font-bold text-slate-800">Chưa có thông báo</h3>
              <p className="mt-1 max-w-sm text-sm text-slate-500">
                Gửi thông báo đầu tiên để cập nhật thông tin cho toàn bộ người dùng.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {notices.map((notice) => (
                <article key={notice.id} className="group flex gap-4 px-5 py-5 hover:bg-slate-50/70">
                  <div className="mt-0.5 flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-blue-50 text-blue-600 ring-1 ring-blue-100">
                    <BellRing size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <h3 className="font-bold text-slate-900">{notice.title}</h3>
                      <time className="flex-none text-xs text-slate-400">
                        {formatNoticeDate(notice.createdAt)}
                      </time>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">
                      {notice.description}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <NoticeDialog
        open={dialogOpen}
        saving={saving}
        error={dialogError}
        onClose={() => !saving && setDialogOpen(false)}
        onSubmit={sendNotice}
      />
    </AdminLayout>
  );
}
