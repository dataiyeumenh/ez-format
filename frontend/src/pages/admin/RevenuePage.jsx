import { useState } from "react";
import { Download, MoreVertical } from "lucide-react";
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

const revenueData = [
  { date: "01/10", current: 900, previous: 700 },
  { date: "08/10", current: 1400, previous: 1000 },
  { date: "15/10", current: 1800, previous: 1300 },
  { date: "22/10", current: 2200, previous: 1700 },
  { date: "30/10", current: 2800, previous: 2100 },
  { date: "07/11", current: 2500, previous: 2000 },
  { date: "14/11", current: 3100, previous: 2400 },
  { date: "21/11", current: 3400, previous: 2600 },
  { date: "30/11", current: 3800, previous: 2900 },
];

const planRevenue = [
  { name: "Gói miễn phí", amount: "54.200k", pct: 42, color: "bg-blue-500" },
  { name: "Gói tháng", amount: "38.100k", pct: 30, color: "bg-blue-400" },
  { name: "Gói năm", amount: "22.800k", pct: 18, color: "bg-blue-300" },
  { name: "Theo lượt", amount: "13.330k", pct: 10, color: "bg-blue-200" },
];

const transactions = [
  {
    date: "24 th10, 2023, 14:22",
    user: "Jane Doe",
    avatar: "JD",
    color: "bg-blue-500",
    plan: "Personal",
    planColor: "bg-blue-100 text-blue-700",
    amount: "150.000 đ",
    status: "Thành công",
  },
  {
    date: "24 th10, 2023, 13:10",
    user: "Tom Miller",
    avatar: "TM",
    color: "bg-purple-500",
    plan: "Class",
    planColor: "bg-purple-100 text-purple-700",
    amount: "149.000 đ",
    status: "Thành công",
  },
  {
    date: "24 th10, 2023, 11:55",
    user: "Arun Kumar",
    avatar: "AK",
    color: "bg-orange-500",
    plan: "Student",
    planColor: "bg-yellow-100 text-yellow-700",
    amount: "109.000 đ",
    status: "Đang xử lý",
  },
  {
    date: "23 th10, 2023, 18:30",
    user: "Lisa Stone",
    avatar: "LS",
    color: "bg-rose-500",
    plan: "Personal",
    planColor: "bg-blue-100 text-blue-700",
    amount: "150.000 đ",
    status: "Hoàn tiền",
  },
];

const statusStyle = {
  "Thành công": "bg-green-100 text-green-700",
  "Đang xử lý": "bg-yellow-100 text-yellow-700",
  "Hoàn tiền": "bg-red-100 text-red-700",
};

const RevenuePage = () => {
  const [range, setRange] = useState("30 ngày gần đây");

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl p-1">
            {[
              "Hôm nay",
              "7 ngày gần đây",
              "30 ngày gần đây",
              "Tự chọn thời gian 📅",
            ].map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  range === r
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button className="flex items-center gap-2 border border-gray-200 text-gray-600 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 transition-colors">
            <Download size={15} />
            Export Report
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: "Tổng doanh thu",
              value: "58.430.000đ",
              change: "+12.5%",
              icon: "💰",
            },
            { label: "MRR", value: "7.500.000đ", change: "+8.2%", icon: "⏱" },
            { label: "ARPU", value: "15.400đ", change: "+1.5%", icon: "🏆" },
            {
              label: "Tỷ lệ hủy gói",
              value: "2.4%",
              change: "-0.4%",
              chgColor: "text-red-500",
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

        {/* Chart + breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl p-5 border border-gray-100 col-span-2">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900">
                Revenue Over Time
              </h3>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-blue-600 inline-block" />
                  Current
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-blue-200 inline-block" />
                  Previous
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={revenueData} barSize={14} barGap={4}>
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
              {planRevenue.map((p) => (
                <div key={p.name}>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="text-gray-700 font-medium">{p.name}</span>
                    <span className="text-gray-500 text-xs">
                      {p.amount} ({p.pct}%)
                    </span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${p.color} rounded-full`}
                      style={{ width: `${p.pct}%` }}
                    />
                  </div>
                </div>
              ))}
              <div className="pt-2 border-t border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Hiệu quả nhất</span>
                  <span className="font-semibold text-blue-600">
                    Personal Plan
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Transactions */}
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">
              Giao dịch gần đây
            </h3>
            <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">
              View All Transactions
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50">
                  {["DATE", "USER", "PLAN", "AMOUNT", "STATUS", "ACTION"].map(
                    (h) => (
                      <th
                        key={h}
                        className="text-left text-xs font-semibold text-gray-400 uppercase px-5 py-3"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                  >
                    <td className="px-5 py-4 text-sm text-gray-500 whitespace-nowrap">
                      {t.date}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-full ${t.color} flex items-center justify-center text-white text-xs font-bold`}
                        >
                          {t.avatar}
                        </div>
                        <span className="text-sm font-medium text-gray-900">
                          {t.user}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`text-xs font-semibold px-2.5 py-1 rounded-full ${t.planColor}`}
                      >
                        {t.plan}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-gray-900">
                      {t.amount}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`text-xs font-medium px-2.5 py-1 rounded-full flex items-center gap-1.5 w-fit ${statusStyle[t.status]}`}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {t.status}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <button className="text-gray-400 hover:text-gray-600">
                        <MoreVertical size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
};

export default RevenuePage;
