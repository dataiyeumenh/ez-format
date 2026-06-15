import { useEffect, useMemo, useState } from "react";
import { Download, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";

const statusLabels = {
  completed: "Hoàn thành",
  processing: "Đang xử lý",
  failed: "Lỗi",
};

const statusStyle = {
  completed: "bg-green-100 text-green-700",
  processing: "bg-yellow-100 text-yellow-700",
  failed: "bg-red-100 text-red-700",
};

const avatarColors = [
  "bg-blue-500",
  "bg-pink-500",
  "bg-orange-500",
  "bg-purple-500",
  "bg-teal-500",
  "bg-emerald-500",
  "bg-indigo-500",
];

function initials(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function buildCsv(rows) {
  const headers = ["User", "Email", "Tên file", "Định dạng", "Kích thước", "Trạng thái", "Ngày giờ"];
  const lines = rows.map((row) => [
    row.user?.name || "",
    row.user?.email || "",
    row.fileName || "",
    row.format || "MISA",
    row.size || "",
    statusLabels[row.status] || row.status || "",
    formatDateTime(row.createdAt),
  ]);
  return [headers, ...lines]
    .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

const FilesPage = () => {
  const [currentPage, setCurrentPage] = useState(1);
  const [status, setStatus] = useState("");
  const [runs, setRuns] = useState([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchRuns = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/admin/conversion-runs", {
        params: {
          page: currentPage,
          limit: 10,
          status: status || undefined,
        },
      });
      setRuns(data.runs || []);
      setStats(data.stats || { total: 0, completed: 0, failed: 0, processing: 0 });
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Không thể tải lịch sử chuyển đổi.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, status]);

  const statCards = useMemo(
    () => [
      {
        label: "Tổng lượt chuyển đổi",
        value: stats.total || 0,
        change: "Tất cả file đã ghi nhận",
        icon: "⇄",
        color: "text-blue-600 bg-blue-50",
      },
      {
        label: "Thành công",
        value: stats.completed || 0,
        change: "File đã tải MISA thành công",
        icon: "✓",
        color: "text-green-600 bg-green-50",
      },
      {
        label: "Lỗi",
        value: stats.failed || 0,
        change: "Convert/export không hoàn tất",
        icon: "✗",
        color: "text-red-600 bg-red-50",
      },
      {
        label: "Đang xử lý",
        value: stats.processing || 0,
        change: "Đã upload nhưng chưa hoàn tất",
        icon: "⟳",
        color: "text-yellow-600 bg-yellow-50",
      },
    ],
    [stats],
  );

  const handleReset = () => {
    setStatus("");
    setCurrentPage(1);
  };

  const handleExport = () => {
    const csv = buildCsv(runs);
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "conversion-history.csv";
    link.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">
              Lịch sử chuyển đổi file
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Theo dõi user đã upload file để chuyển đổi sang mẫu MISA.
            </p>
          </div>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            <Download size={15} />
            Export Report
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((s) => (
            <div key={s.label} className="bg-white rounded-xl p-4 border border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <span className={`text-base font-bold w-9 h-9 flex items-center justify-center rounded-lg ${s.color}`}>
                  {s.icon}
                </span>
              </div>
              <p className="text-xl font-black text-gray-900">{s.value.toLocaleString("vi-VN")}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{s.change}</p>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl border border-gray-100">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-100">
            <span className="text-sm text-gray-500 font-medium">Bộ lọc:</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setCurrentPage(1);
              }}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="">Tất cả trạng thái</option>
              <option value="completed">Hoàn thành</option>
              <option value="processing">Đang xử lý</option>
              <option value="failed">Lỗi</option>
            </select>
            <button
              onClick={fetchRuns}
              disabled={loading}
              className="inline-flex items-center gap-2 text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Tải lại
            </button>
            <button onClick={handleReset} className="ml-auto text-sm text-gray-400 hover:text-gray-600">
              ⚙ Reset Filters
            </button>
          </div>

          {error && (
            <div className="mx-5 mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50">
                  {["USER", "TÊN FILE", "ĐỊNH DẠNG", "KÍCH THƯỚC", "TRẠNG THÁI", "NGÀY & GIỜ", "HÀNH ĐỘNG"].map((h) => (
                    <th key={h} className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && runs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500">
                      Đang tải lịch sử chuyển đổi...
                    </td>
                  </tr>
                ) : runs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500">
                      Chưa có lịch sử chuyển đổi nào.
                    </td>
                  </tr>
                ) : (
                  runs.map((run, index) => (
                    <tr key={run.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-full ${avatarColors[index % avatarColors.length]} flex items-center justify-center text-white text-xs font-bold`}>
                            {initials(run.user?.name)}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{run.user?.name || "Không rõ"}</p>
                            {run.user?.email && <p className="text-xs text-gray-400">{run.user.email}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-700 max-w-[220px] truncate" title={run.fileName}>
                        {run.fileName}
                      </td>
                      <td className="px-5 py-4">
                        <span className="bg-gray-100 text-gray-600 text-xs font-semibold px-2.5 py-1 rounded">
                          {run.format || "MISA"}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-500">{run.size}</td>
                      <td className="px-5 py-4">
                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1.5 w-fit ${statusStyle[run.status] || "bg-gray-100 text-gray-600"}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-current" />
                          {statusLabels[run.status] || run.status}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-500">{formatDateTime(run.createdAt)}</td>
                      <td className="px-5 py-4 text-sm text-gray-400">—</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-center gap-1 px-5 py-4 border-t border-gray-100">
            <button
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40"
            >
              <ChevronLeft size={14} /> Trước
            </button>
            <span className="px-3 py-1.5 text-sm text-gray-600">
              Trang {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40"
            >
              Sau <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
};

export default FilesPage;
