import { useCallback, useEffect, useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Users,
  FileText,
  Activity,
  Loader2,
  Globe2,
} from "lucide-react";
import { Link } from "react-router-dom";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";
import { formatVisitChartDate } from "../../utils/websiteVisits";

const statusLabels = {
  completed: "Hoàn thành",
  processing: "Đang xử lý",
  failed: "Lỗi",
  cancelled: "Đã hủy",
};

const statusStyle = {
  completed: "bg-green-100 text-green-700",
  processing: "bg-blue-100 text-blue-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-gray-200 text-gray-600",
};

const planTag = {
  free: { label: "Miễn phí", color: "bg-green-500" },
  monthly: { label: "Tháng", color: "bg-blue-500" },
  yearly: { label: "Năm", color: "bg-purple-500" },
  perfile: { label: "Lượt", color: "bg-orange-500" },
};

const getInitials = (name = "") =>
  name
    .split(" ")
    .slice(-2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";

const formatVnd = (value) => `${Number(value || 0).toLocaleString("vi-VN")}đ`;

const formatCompact = (value) => {
  const n = Number(value || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
};

const formatRelative = (iso) => {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "—";
  if (diff < 60000) return "Vừa xong";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} phút trước`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} giờ trước`;
  return `${Math.floor(diff / 86400000)} ngày trước`;
};

const ChangeBadge = ({ pct }) => {
  const value = Number(pct || 0);
  const positive = value >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`flex items-center gap-1 text-xs font-medium ${
        positive ? "text-green-600" : "text-red-600"
      }`}
    >
      <Icon size={12} />
      {positive ? "+" : ""}
      {value}%
    </span>
  );
};

const DashboardPage = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/admin/dashboard");
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Không thể tải dữ liệu tổng quan");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center py-32 gap-3 text-gray-400">
          <Loader2 size={22} className="animate-spin" />
          <span className="text-sm">Đang tải dữ liệu tổng quan...</span>
        </div>
      </AdminLayout>
    );
  }

  if (error || !data) {
    return (
      <AdminLayout>
        <div className="flex flex-col items-center justify-center py-32 gap-3">
          <p className="text-sm text-red-500">{error || "Không có dữ liệu"}</p>
          <button
            onClick={fetchDashboard}
            className="text-xs text-blue-600 hover:underline"
          >
            Thử lại
          </button>
        </div>
      </AdminLayout>
    );
  }

  const {
    stats,
    conversionsByDay,
    revenueByWeek,
    planDistribution,
    visitsByDay = [],
  } = data;
  const totalDist = planDistribution.reduce((sum, item) => sum + (item.value || 0), 0);

  const statCards = [
    {
      label: "TỔNG NGƯỜI DÙNG",
      value: Number(stats.totalUsers.value).toLocaleString("vi-VN"),
      changePct: stats.totalUsers.changePct,
      icon: Users,
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: "ĐANG HOẠT ĐỘNG",
      value: Number(stats.activeUsers.value).toLocaleString("vi-VN"),
      changePct: stats.activeUsers.changePct,
      icon: Activity,
      color: "text-purple-600 bg-purple-50",
    },
    {
      label: "FILE ĐÃ XỬ LÝ HÔM NAY",
      value: Number(stats.filesToday.value).toLocaleString("vi-VN"),
      changePct: stats.filesToday.changePct,
      icon: FileText,
      color: "text-orange-600 bg-orange-50",
    },
    {
      label: "DOANH THU THÁNG",
      value: formatVnd(stats.monthlyRevenue.value),
      changePct: stats.monthlyRevenue.changePct,
      icon: TrendingUp,
      color: "text-green-600 bg-green-50",
    },
    {
      label: "LƯỢT TRUY CẬP HÔM NAY",
      value: Number(stats.visitsToday?.value || 0).toLocaleString("vi-VN"),
      changePct: stats.visitsToday?.changePct || 0,
      icon: Globe2,
      color: "text-cyan-600 bg-cyan-50",
    },
  ];

  return (
    <AdminLayout>
      <div className="p-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
          {statCards.map((stat) => (
            <div
              key={stat.label}
              className="bg-white rounded-xl p-5 border border-gray-100"
            >
              <div className="flex items-center justify-between mb-3">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center ${stat.color}`}
                >
                  <stat.icon size={20} />
                </div>
                <ChangeBadge pct={stat.changePct} />
              </div>
              <p className="text-2xl font-black text-gray-900">{stat.value}</p>
              <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">
                {stat.label}
              </p>
            </div>
          ))}
        </div>

        {/* Website traffic */}
        <section
          className="rounded-xl border border-gray-100 bg-white p-5"
          aria-labelledby="website-traffic-title"
        >
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2
                id="website-traffic-title"
                className="text-sm font-semibold text-gray-900"
              >
                Lượt truy cập website
              </h2>
              <p className="mt-1 text-xs text-gray-400">
                Từ 01/05/2026 đến nay
              </p>
            </div>
            <div className="rounded-lg bg-cyan-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-700">
                Tổng lượt truy cập
              </p>
              <p className="text-lg font-black text-cyan-900">
                {Number(data.totalVisits || 0).toLocaleString("vi-VN")}
              </p>
            </div>
          </div>

          {visitsByDay.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-gray-400">
              Chưa có dữ liệu truy cập
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart
                data={visitsByDay}
                margin={{ top: 8, right: 12, left: -8, bottom: 0 }}
              >
                <CartesianGrid
                  stroke="#E5E7EB"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={30}
                  tick={{ fontSize: 10, fill: "#9CA3AF" }}
                  tickFormatter={(value) => formatVisitChartDate(value)}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tick={{ fontSize: 10, fill: "#9CA3AF" }}
                />
                <Tooltip
                  labelFormatter={(value) => formatVisitChartDate(value, true)}
                  formatter={(value) => [
                    Number(value).toLocaleString("vi-VN"),
                    "Lượt truy cập",
                  ]}
                  contentStyle={{
                    fontSize: 12,
                    border: "1px solid #E5E7EB",
                    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
                    borderRadius: 8,
                  }}
                  cursor={{ stroke: "#CBD5E1" }}
                />
                <Line
                  type="monotone"
                  dataKey="visits"
                  stroke="#0891B2"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: "#0891B2", strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </section>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Line chart */}
          <div className="bg-white rounded-xl p-5 border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900">Chuyển đổi file</h3>
              <span className="text-xs text-gray-400">7 ngày gần nhất</span>
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={conversionsByDay}>
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10, fill: "#9CA3AF" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    border: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                    borderRadius: 8,
                  }}
                  cursor={{ stroke: "#E5E7EB" }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#3B82F6"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Bar chart */}
          <div className="bg-white rounded-xl p-5 border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">
              Doanh thu hàng tháng
            </h3>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={revenueByWeek} barSize={28}>
                <XAxis
                  dataKey="week"
                  tick={{ fontSize: 10, fill: "#9CA3AF" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  formatter={(value) => formatVnd(value)}
                  contentStyle={{
                    fontSize: 12,
                    border: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                    borderRadius: 8,
                  }}
                  cursor={false}
                />
                <Bar dataKey="value" fill="#3B82F6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Pie chart */}
          <div className="bg-white rounded-xl p-5 border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">
              Phân bổ gói dịch vụ
            </h3>
            <div className="flex items-center gap-4">
              <div className="relative">
                <ResponsiveContainer width={100} height={100}>
                  <PieChart>
                    <Pie
                      data={totalDist > 0 ? planDistribution : [{ value: 1 }]}
                      cx={45}
                      cy={45}
                      innerRadius={30}
                      outerRadius={45}
                      dataKey="value"
                      strokeWidth={0}
                    >
                      {(totalDist > 0 ? planDistribution : [{ color: "#E5E7EB" }]).map(
                        (entry, index) => (
                          <Cell key={index} fill={entry.color || "#E5E7EB"} />
                        ),
                      )}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-sm font-bold text-gray-900">
                    {formatCompact(data.activeTotal)}
                  </span>
                  <span className="text-xs text-gray-400">ACTIVE</span>
                </div>
              </div>
              <div className="flex-1 space-y-1.5">
                {planDistribution.map((item) => (
                  <div key={item.code} className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-xs text-gray-600 truncate">{item.name}</span>
                      {item.isActive === false && (
                        <span className="text-[10px] text-gray-400 flex-shrink-0">(ẩn)</span>
                      )}
                    </div>
                    <span className="text-xs font-medium text-gray-700 flex-shrink-0">
                      {totalDist > 0 ? Math.round((item.value / totalDist) * 100) : 0}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Recent conversions */}
          <div className="bg-white rounded-xl border border-gray-100 col-span-2">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">
                Chuyển đổi gần đây
              </h3>
              <Link
                to="/admin/files"
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                Xem tất cả
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-50">
                    {["Người dùng", "File", "Định dạng", "Trạng thái", "Thời gian"].map(
                      (h) => (
                        <th
                          key={h}
                          className="text-left text-xs font-medium text-gray-400 uppercase px-5 py-3"
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.recentConversions.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-400">
                        Chưa có chuyển đổi nào
                      </td>
                    </tr>
                  ) : (
                    data.recentConversions.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                      >
                        <td className="px-5 py-3">
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {row.user?.name || "Không rõ"}
                            </p>
                            <p className="text-xs text-gray-400">{row.user?.email}</p>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-600 max-w-[180px] truncate" title={row.fileName}>
                          {row.fileName}
                        </td>
                        <td className="px-5 py-3">
                          <span className="bg-blue-50 text-blue-700 text-xs font-medium px-2 py-0.5 rounded">
                            {row.format || "MISA"}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusStyle[row.status] || "bg-gray-100 text-gray-600"}`}
                          >
                            ● {statusLabels[row.status] || row.status}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-xs text-gray-400">
                          {formatRelative(row.createdAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* New users */}
          <div className="bg-white rounded-xl border border-gray-100">
            <div className="p-5 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">
                Người dùng mới hôm nay
              </h3>
            </div>
            <div className="p-5 space-y-4">
              {data.newUsersToday.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">
                  Chưa có người dùng mới hôm nay
                </p>
              ) : (
                data.newUsersToday.map((u, i) => {
                  const tag = planTag[u.planCode] || planTag.free;
                  return (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-full ${tag.color} flex items-center justify-center text-white text-xs font-bold`}
                        >
                          {getInitials(u.name)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{u.name}</p>
                          <p className="text-xs text-gray-400 truncate">{u.email}</p>
                        </div>
                      </div>
                      <span className="text-xs font-medium text-gray-600 border border-gray-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                        {tag.label}
                      </span>
                    </div>
                  );
                })
              )}
              <Link
                to="/admin/users"
                className="block w-full text-center text-xs text-blue-600 hover:text-blue-700 font-medium pt-2"
              >
                Xem {data.newUsersTodayCount} người dùng đăng ký mới
              </Link>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
};

export default DashboardPage;
