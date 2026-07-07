import { useEffect, useCallback, useState } from "react";
import { Download, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import { FEEDBACK_CATEGORIES, fetchAdminFeedback } from "../../services/feedback";

const ITEMS_PER_PAGE = 10;

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

const AVATAR_COLORS = [
  "bg-pink-500",
  "bg-blue-500",
  "bg-orange-500",
  "bg-green-600",
  "bg-indigo-500",
  "bg-teal-500",
  "bg-rose-500",
  "bg-cyan-500",
];

const getInitials = (name = "") =>
  name
    .split(" ")
    .slice(-2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";

const getAvatarColor = (id = "") =>
  AVATAR_COLORS[parseInt(id.toString().slice(-2), 16) % AVATAR_COLORS.length] ||
  AVATAR_COLORS[0];

const formatDateTime = (iso) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

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
    .map((line) =>
      line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
}

const LogsPage = () => {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({ total: 0, bug: 0, feature: 0, ui: 0, other: 0 });
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [filterCategory, setFilterCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadFeedback = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminFeedback({
        page: currentPage,
        limit: ITEMS_PER_PAGE,
        category: filterCategory || undefined,
      });
      setItems(data.feedback || []);
      setStats(data.stats || { total: 0, bug: 0, feature: 0, ui: 0, other: 0 });
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError(err.response?.data?.message || "Không thể tải danh sách góp ý");
    } finally {
      setLoading(false);
    }
  }, [currentPage, filterCategory]);

  useEffect(() => {
    loadFeedback();
  }, [loadFeedback]);

  const resetFilters = () => {
    setFilterCategory("");
    setCurrentPage(1);
  };

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

  const getPaginationPages = () => {
    const pages = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push("...");
      for (
        let i = Math.max(2, currentPage - 1);
        i <= Math.min(totalPages - 1, currentPage + 1);
        i++
      )
        pages.push(i);
      if (currentPage < totalPages - 2) pages.push("...");
      pages.push(totalPages);
    }
    return pages;
  };

  const statCards = [
    {
      label: "TỔNG GÓP Ý",
      value: stats.total || 0,
      icon: "💬",
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: "LỖI",
      value: stats.bug || 0,
      icon: "🐞",
      color: "text-red-600 bg-red-50",
    },
    {
      label: "TÍNH NĂNG",
      value: stats.feature || 0,
      icon: "✨",
      color: "text-green-600 bg-green-50",
    },
    {
      label: "GIAO DIỆN",
      value: stats.ui || 0,
      icon: "🎨",
      color: "text-purple-600 bg-purple-50",
    },
  ];

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">Góp ý người dùng</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Xem các góp ý người dùng gửi về hệ thống.
            </p>
          </div>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Download size={15} /> Export CSV
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((s) => (
            <div
              key={s.label}
              className="bg-white rounded-xl p-4 border border-gray-100"
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-xl w-9 h-9 flex items-center justify-center rounded-lg ${s.color}`}
                >
                  {s.icon}
                </span>
              </div>
              <p className="text-xl font-black text-gray-900">
                {loading ? "—" : s.value}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 uppercase">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-100">
          {/* Filters */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500 font-medium">Bộ lọc:</span>
              <select
                value={filterCategory}
                onChange={(e) => {
                  setFilterCategory(e.target.value);
                  setCurrentPage(1);
                }}
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="">Tất cả loại</option>
                {FEEDBACK_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={resetFilters}
              className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
            >
              ⚙ Reset Filters
            </button>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
                <Loader2 size={20} className="animate-spin" />
                <span className="text-sm">Đang tải...</span>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <p className="text-red-500 text-sm">{error}</p>
                <button
                  onClick={loadFeedback}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Thử lại
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
                Chưa có góp ý nào
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-50">
                    {["USER", "LOẠI", "NỘI DUNG", "THỜI GIAN"].map((h) => (
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
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-full ${getAvatarColor(item.user?.id || item.id)} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}
                          >
                            {getInitials(item.user?.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate">
                              {item.user?.name || "Không rõ"}
                            </p>
                            {item.user?.email && (
                              <p className="text-xs text-gray-400 truncate">
                                {item.user.email}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={`text-xs font-semibold px-2.5 py-1 rounded-full ${categoryStyle[item.category] || "bg-gray-100 text-gray-600"}`}
                        >
                          {item.categoryLabel ||
                            categoryLabels[item.category] ||
                            item.category}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-700 max-w-md">
                        <p className="whitespace-pre-wrap break-words">
                          {item.message}
                        </p>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-500 whitespace-nowrap">
                        {formatDateTime(item.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-center gap-1 px-5 py-4 border-t border-gray-100">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40"
              >
                <ChevronLeft size={14} /> Trước
              </button>
              {getPaginationPages().map((p, i) =>
                p === "..." ? (
                  <span key={`ellipsis-${i}`} className="px-2 text-gray-400 text-sm">
                    ...
                  </span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setCurrentPage(p)}
                    className={`w-8 h-8 text-sm rounded-lg transition-colors ${currentPage === p ? "bg-blue-600 text-white font-semibold" : "text-gray-600 hover:bg-gray-50 border border-gray-200"}`}
                  >
                    {p}
                  </button>
                ),
              )}
              <button
                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40"
              >
                Sau <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
};

export default LogsPage;
