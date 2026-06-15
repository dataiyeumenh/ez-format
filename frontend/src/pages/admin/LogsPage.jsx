import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import { fetchAdminFeedback } from "../../services/feedback";

const categoryLabels = {
  bug: "Lỗi",
  feature: "Tính năng",
  ui: "Giao diện",
  other: "Khác",
};

const categoryStyle = {
  bug: "bg-red-100 text-red-700",
  feature: "bg-blue-100 text-blue-700",
  ui: "bg-purple-100 text-purple-700",
  other: "bg-gray-100 text-gray-600",
};

const categoryFilters = [
  { value: "", label: "Tất cả" },
  { value: "bug", label: "Lỗi" },
  { value: "feature", label: "Tính năng" },
  { value: "ui", label: "Giao diện" },
  { value: "other", label: "Khác" },
];

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
  const headers = ["User", "Email", "Loại", "Nội dung", "Thời gian"];
  const lines = rows.map((row) => [
    row.user?.name || "",
    row.user?.email || "",
    categoryLabels[row.category] || row.category || "",
    row.message || "",
    formatDateTime(row.createdAt),
  ]);
  return [headers, ...lines]
    .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

const LogsPage = () => {
  const [currentPage, setCurrentPage] = useState(1);
  const [category, setCategory] = useState("");
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({ total: 0, bug: 0, feature: 0, ui: 0, other: 0 });
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadFeedback = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchAdminFeedback({
        page: currentPage,
        limit: 10,
        category: category || undefined,
      });
      setItems(data.feedback || []);
      setStats(data.stats || { total: 0, bug: 0, feature: 0, ui: 0, other: 0 });
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError(
        err.response?.data?.message || err.message || "Không thể tải danh sách góp ý.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, category]);

  const statCards = useMemo(
    () => [
      { label: "Tổng góp ý", value: stats.total || 0, icon: "💬", color: "text-blue-600 bg-blue-50" },
      { label: "Lỗi", value: stats.bug || 0, icon: "🐞", color: "text-red-600 bg-red-50" },
      { label: "Tính năng", value: stats.feature || 0, icon: "✨", color: "text-blue-600 bg-blue-50" },
      { label: "Giao diện", value: stats.ui || 0, icon: "🎨", color: "text-purple-600 bg-purple-50" },
    ],
    [stats],
  );

  const handleExport = () => {
    const csv = buildCsv(items);
    const blob = new Blob([String.fromCharCode(0xfeff) + csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "feedback.csv";
    link.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">Góp ý người dùng</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Xem các góp ý người dùng gửi về hệ thống.
            </p>
          </div>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 border border-gray-200 text-gray-600 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((s) => (
            <div key={s.label} className="bg-white rounded-xl p-4 border border-gray-100">
              <div
                className={`text-xl w-9 h-9 flex items-center justify-center rounded-lg mb-2 ${s.color}`}
              >
                {s.icon}
              </div>
              <p className="text-xl font-black text-gray-900">
                {s.value.toLocaleString("vi-VN")}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Feedback table */}
        <div className="bg-white rounded-xl border border-gray-100">
          {/* Filter bar */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 flex-wrap">
            <span className="text-sm text-gray-500 font-medium">Loại:</span>
            {categoryFilters.map((f) => (
              <button
                key={f.value || "all"}
                onClick={() => {
                  setCategory(f.value);
                  setCurrentPage(1);
                }}
                className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  category === f.value
                    ? "bg-blue-600 text-white"
                    : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {f.label}
              </button>
            ))}
            <button
              onClick={loadFeedback}
              disabled={loading}
              className="ml-auto inline-flex items-center gap-2 text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Tải lại
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
                  {["NGƯỜI DÙNG", "LOẠI", "NỘI DUNG", "THỜI GIAN"].map((h) => (
                    <th
                      key={h}
                      className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider px-5 py-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">
                      Đang tải danh sách góp ý...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">
                      Chưa có góp ý nào.
                    </td>
                  </tr>
                ) : (
                  items.map((item, index) => (
                    <tr
                      key={item.id}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-full ${avatarColors[index % avatarColors.length]} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}
                          >
                            {initials(item.user?.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {item.user?.name || "Không rõ"}
                            </p>
                            {item.user?.email && (
                              <p className="text-xs text-gray-400 truncate">{item.user.email}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={`text-xs font-semibold px-2.5 py-1 rounded-full ${categoryStyle[item.category] || "bg-gray-100 text-gray-600"}`}
                        >
                          {item.categoryLabel || categoryLabels[item.category] || item.category}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-700 max-w-md">
                        <p className="whitespace-pre-wrap break-words">{item.message}</p>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-500 whitespace-nowrap">
                        {formatDateTime(item.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
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

export default LogsPage;
