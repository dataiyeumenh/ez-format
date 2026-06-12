import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, MoreVertical, RefreshCw } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";

const rangeOptions = [
  { label: "Hôm nay", value: "today" },
  { label: "7 ngày gần đây", value: "7d" },
  { label: "30 ngày gần đây", value: "30d" },
];

const statusLabels = {
  paid: "Thành công",
  pending: "Đang xử lý",
  cancelled: "Đã huỷ",
  expired: "Hết hạn",
  failed: "Thất bại",
};

const statusStyle = {
  paid: "bg-green-100 text-green-700",
  pending: "bg-yellow-100 text-yellow-700",
  cancelled: "bg-gray-100 text-gray-700",
  expired: "bg-orange-100 text-orange-700",
  failed: "bg-red-100 text-red-700",
};

const planColors = {
  monthly: "bg-blue-100 text-blue-700",
  yearly: "bg-purple-100 text-purple-700",
  perfile: "bg-emerald-100 text-emerald-700",
};

const barColors = ["bg-blue-500", "bg-blue-400", "bg-blue-300"];

function formatVnd(amount = 0) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDateTime(dateValue) {
  if (!dateValue) return "—";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function initials(name = "?") {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(-2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

const RevenuePage = () => {
  const [range, setRange] = useState("30d");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  const fetchRevenue = useCallback(async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      const response = await api.get("/admin/revenue", { params: { range } });
      setData(response.data);
    } catch (error) {
      setErrorMsg(
        error.response?.data?.message ||
          error.message ||
          "Không thể tải dữ liệu doanh thu.",
      );
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchRevenue();
  }, [fetchRevenue]);

  const stats = data?.stats || {};
  const chart = data?.chart || [];
  const planRevenue = useMemo(() => data?.planRevenue || [], [data]);
  const transactions = data?.transactions || [];

  const bestPlan = useMemo(
    () => [...planRevenue].sort((a, b) => b.amount - a.amount)[0],
    [planRevenue],
  );

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2 bg-white border border-gray-200 rounded-xl p-1">
            {rangeOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => setRange(option.value)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  range === option.value
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={fetchRevenue}
              className="flex items-center gap-2 border border-gray-200 text-gray-600 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <RefreshCw size={15} />
              Tải lại
            </button>
            <button className="flex items-center gap-2 border border-gray-200 text-gray-600 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 transition-colors">
              <Download size={15} />
              Export Report
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMsg}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center rounded-2xl border border-gray-100 bg-white py-20 text-blue-600">
            <Loader2 className="animate-spin" size={28} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                {
                  label: "Tổng doanh thu",
                  value: formatVnd(stats.totalRevenue),
                  change: `${stats.revenueChangePct || 0}%`,
                  icon: "💰",
                },
                {
                  label: "Doanh thu gói tháng",
                  value: formatVnd(stats.monthlyRevenue),
                  change: `${stats.paidCount || 0} đơn đã thanh toán`,
                  icon: "⏱",
                },
                {
                  label: "ARPU",
                  value: formatVnd(stats.arpu),
                  change: "Trung bình / đơn",
                  icon: "🏆",
                },
                {
                  label: "Đơn đang xử lý",
                  value: String(stats.pendingCount || 0),
                  change: "Đang chờ xử lý",
                  chgColor: "text-amber-600",
                  icon: "👤",
                },
              ].map((s) => (
                <div
                  key={s.label}
                  className="bg-white rounded-xl p-4 border border-gray-100"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xl">{s.icon}</span>
                    <span
                      className={`text-xs font-medium ${s.chgColor || "text-green-600"} bg-green-50 px-2 py-0.5 rounded-full`}
                    >
                      {s.change}
                    </span>
                  </div>
                  <p className="text-xl font-black text-gray-900">{s.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="bg-white rounded-xl p-5 border border-gray-100 col-span-2">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Doanh thu theo thời gian
                  </h3>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-blue-600 inline-block" />
                      Kỳ hiện tại
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-blue-200 inline-block" />
                      Kỳ trước
                    </span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chart} barSize={14} barGap={4}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="#F3F4F6"
                    />
                    <XAxis
                      dataKey="date"
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
                      cursor={{ fill: "#F9FAFB" }}
                    />
                    <Bar dataKey="previous" fill="#BFDBFE" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="current" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-white rounded-xl p-5 border border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">
                  Doanh thu theo gói dịch vụ
                </h3>
                <div className="space-y-4">
                  {planRevenue.map((p, index) => (
                    <div key={p.planType}>
                      <div className="flex justify-between text-sm mb-1.5">
                        <span className="text-gray-700 font-medium">{p.name}</span>
                        <span className="text-gray-500 text-xs">
                          {formatVnd(p.amount)} ({p.pct}%)
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${barColors[index] || "bg-blue-200"} rounded-full`}
                          style={{ width: `${p.pct}%` }}
                        />
                      </div>
                    </div>
                  ))}
                  <div className="pt-2 border-t border-gray-100">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">Hiệu quả nhất</span>
                      <span className="font-semibold text-blue-600">
                        {bestPlan?.amount > 0 ? bestPlan.name : "Chưa có dữ liệu"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-100">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">
                  Giao dịch gần đây
                </h3>
                <span className="text-sm text-gray-500">
                  {transactions.length} giao dịch mới nhất
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-50">
                      {[
                        "DATE",
                        "USER",
                        "PLAN",
                        "ORDER",
                        "AMOUNT",
                        "STATUS",
                        "ACTION",
                      ].map((h) => (
                        <th
                          key={h}
                          className="text-left text-xs font-semibold text-gray-400 uppercase px-5 py-3"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-5 py-10 text-center text-sm text-gray-500"
                        >
                          Chưa có giao dịch thanh toán nào.
                        </td>
                      </tr>
                    ) : (
                      transactions.map((t) => (
                        <tr
                          key={t.id}
                          className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                        >
                          <td className="px-5 py-4 text-sm text-gray-500 whitespace-nowrap">
                            {formatDateTime(t.createdAt)}
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold">
                                {initials(t.user?.name)}
                              </div>
                              <div>
                                <span className="block text-sm font-medium text-gray-900">
                                  {t.user?.name || "Không rõ"}
                                </span>
                                <span className="block text-xs text-gray-400">
                                  {t.user?.email || "—"}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-4">
                            <span
                              className={`text-xs font-semibold px-2.5 py-1 rounded-full ${planColors[t.planType] || "bg-gray-100 text-gray-700"}`}
                            >
                              {t.planName}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-sm text-gray-500">
                            <div className="font-medium text-gray-700">#{t.orderCode}</div>
                            <div className="max-w-[160px] truncate text-xs text-gray-400">
                              {t.paymentLinkId || "—"}
                            </div>
                          </td>
                          <td className="px-5 py-4 text-sm font-semibold text-gray-900">
                            {formatVnd(t.amount)}
                          </td>
                          <td className="px-5 py-4">
                            <span
                              className={`text-xs font-medium px-2.5 py-1 rounded-full flex items-center gap-1.5 w-fit ${statusStyle[t.status] || "bg-gray-100 text-gray-700"}`}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-current" />
                              {statusLabels[t.status] || t.status}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <button className="text-gray-400 hover:text-gray-600">
                              <MoreVertical size={16} />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
};

export default RevenuePage;
