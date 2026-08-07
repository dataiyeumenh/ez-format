import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  FileClock,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import api from "../services/api";
import { formatFileHistoryDate } from "../utils/fileHistory";

const PAGE_SIZE = 10;

const STATUS_OPTIONS = [
  { value: "", label: "Tất cả trạng thái" },
  { value: "completed", label: "Hoàn thành" },
  { value: "processing", label: "Đang xử lý" },
  { value: "failed", label: "Lỗi" },
  { value: "cancelled", label: "Đã hủy" },
];

const STATUS_META = {
  completed: { label: "Hoàn thành", className: "bg-emerald-50 text-emerald-700" },
  processing: { label: "Đang xử lý", className: "bg-amber-50 text-amber-700" },
  failed: { label: "Lỗi", className: "bg-red-50 text-red-700" },
  cancelled: { label: "Đã hủy", className: "bg-slate-100 text-slate-600" },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || {
    label: status || "Không rõ",
    className: "bg-slate-100 text-slate-600",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${meta.className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
}

export default function ConversionHistoryModal({ open, onClose }) {
  const [runs, setRuns] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/conversion-runs/me", {
        params: {
          page: currentPage,
          limit: PAGE_SIZE,
          ...(statusFilter ? { status: statusFilter } : {}),
        },
      });
      setRuns(response.data.runs || []);
      setTotalPages(response.data.totalPages || 1);
    } catch (requestError) {
      setError(
        requestError.response?.data?.message || "Không thể tải lịch sử chuyển đổi",
      );
    } finally {
      setLoading(false);
    }
  }, [currentPage, statusFilter]);

  useEffect(() => {
    if (open) loadHistory();
  }, [loadHistory, open]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;

  const handleClose = () => {
    setStatusFilter("");
    setCurrentPage(1);
    onClose();
  };

  const changeStatus = (event) => {
    setStatusFilter(event.target.value);
    setCurrentPage(1);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-900/50 p-3 animate-fade-in sm:p-4"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversion-history-dialog-title"
        className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-2xl shadow-slate-950/20 sm:max-h-[calc(100vh-2rem)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-slate-100 px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <FileClock size={20} />
            </span>
            <div className="min-w-0">
              <h2
                id="conversion-history-dialog-title"
                className="text-base font-bold text-slate-900"
              >
                Lịch sử chuyển đổi
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Chỉ lưu thông tin file, không lưu nội dung file gốc.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Đóng lịch sử chuyển đổi"
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex flex-col gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <h3 className="text-sm font-black text-slate-900">Danh sách chuyển đổi</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Mới nhất được hiển thị trước
            </p>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 sm:flex">
            <select
              value={statusFilter}
              onChange={changeStatus}
              aria-label="Lọc theo trạng thái"
              className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 sm:w-48"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={loadHistory}
              disabled={loading}
              aria-label="Làm mới lịch sử"
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 transition hover:border-blue-200 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              <RefreshCw size={17} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-sm font-semibold text-slate-500">
              <Loader2 className="animate-spin text-blue-600" size={26} />
              Đang tải lịch sử...
            </div>
          ) : error ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <TriangleAlert size={30} className="text-red-500" />
              <p className="mt-3 font-bold text-slate-900">
                Không thể tải lịch sử chuyển đổi
              </p>
              <p className="mt-1 text-sm text-slate-500">{error}</p>
              <button
                type="button"
                onClick={loadHistory}
                className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800"
              >
                Thử lại
              </button>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                <FileSpreadsheet size={25} />
              </span>
              <p className="mt-4 font-bold text-slate-900">
                Chưa có lần chuyển đổi nào
              </p>
              <p className="mt-1 text-sm text-slate-500">
                File đã tải lên trang chuyển đổi sẽ xuất hiện tại đây.
              </p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-6 py-3.5">Tên file</th>
                      <th className="px-5 py-3.5">Định dạng</th>
                      <th className="px-5 py-3.5">Kích thước</th>
                      <th className="px-5 py-3.5">Trạng thái</th>
                      <th className="px-6 py-3.5 text-right">Ngày</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {runs.map((run) => (
                      <tr key={run.id} className="transition hover:bg-slate-50/70">
                        <td className="max-w-sm px-6 py-4">
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                              <FileSpreadsheet size={17} />
                            </span>
                            <span
                              className="truncate text-sm font-bold text-slate-800"
                              title={run.fileName}
                            >
                              {run.fileName}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-sm font-semibold text-slate-600">
                          {run.format || "MISA"}
                        </td>
                        <td className="px-5 py-4 text-sm text-slate-500">{run.size}</td>
                        <td className="px-5 py-4">
                          <StatusBadge status={run.status} />
                        </td>
                        <td className="whitespace-nowrap px-6 py-4 text-right text-sm text-slate-500">
                          {formatFileHistoryDate(run.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="divide-y divide-slate-100 md:hidden">
                {runs.map((run) => (
                  <article key={run.id} className="p-4">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                        <FileSpreadsheet size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="break-all text-sm font-bold text-slate-900">
                          {run.fileName}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {run.format || "MISA"} · {run.size}
                        </p>
                      </div>
                      <StatusBadge status={run.status} />
                    </div>
                    <p className="mt-3 text-right text-xs font-medium text-slate-400">
                      {formatFileHistoryDate(run.createdAt)}
                    </p>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>

        {!loading && !error && runs.length > 0 && (
          <footer className="flex items-center justify-center gap-2 border-t border-slate-100 bg-white px-4 py-3">
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={currentPage <= 1}
              aria-label="Trang trước"
              className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-28 text-center text-sm font-semibold text-slate-600">
              Trang {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={currentPage >= totalPages}
              aria-label="Trang sau"
              className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronRight size={16} />
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
