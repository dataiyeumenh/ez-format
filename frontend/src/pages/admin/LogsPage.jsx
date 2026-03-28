import { useState } from "react";
import { Download, Filter, ChevronLeft, ChevronRight } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";

const mockLogs = [
  {
    id: "#LOG-0042",
    time: "24/10/2023, 14:22",
    user: "Sarah Jenkins",
    avatar: "SJ",
    color: "bg-pink-500",
    action: "Chuyển đổi file",
    detail: "sales_data.xlsx → MISA format",
    ip: "192.168.1.12",
    type: "conversion",
    typeColor: "bg-blue-100 text-blue-700",
  },
  {
    id: "#LOG-0041",
    time: "24/10/2023, 14:10",
    user: "Admin",
    avatar: "A",
    color: "bg-blue-600",
    action: "Cập nhật gói dịch vụ",
    detail: "Nâng cấp Personal Plan → 150k VND",
    ip: "10.0.0.1",
    type: "admin",
    typeColor: "bg-purple-100 text-purple-700",
  },
  {
    id: "#LOG-0040",
    time: "24/10/2023, 13:55",
    user: "Michael Chen",
    avatar: "MC",
    color: "bg-blue-500",
    action: "Đăng nhập",
    detail: "Đăng nhập thành công từ Chrome/Mac",
    ip: "203.45.12.8",
    type: "auth",
    typeColor: "bg-green-100 text-green-700",
  },
  {
    id: "#LOG-0039",
    time: "24/10/2023, 13:30",
    user: "Elena Rodriguez",
    avatar: "ER",
    color: "bg-orange-500",
    action: "Đăng nhập thất bại",
    detail: "Sai mật khẩu - lần 3/5",
    ip: "118.70.20.45",
    type: "security",
    typeColor: "bg-red-100 text-red-700",
  },
  {
    id: "#LOG-0038",
    time: "24/10/2023, 12:15",
    user: "David Kim",
    avatar: "DK",
    color: "bg-green-600",
    action: "Đăng ký tài khoản",
    detail: "Tạo tài khoản Free mới",
    ip: "14.161.4.109",
    type: "auth",
    typeColor: "bg-green-100 text-green-700",
  },
  {
    id: "#LOG-0037",
    time: "24/10/2023, 11:40",
    user: "Amanda Smith",
    avatar: "AS",
    color: "bg-indigo-500",
    action: "Thanh toán",
    detail: "Thanh toán Personal Plan - 150.000đ",
    ip: "101.84.33.22",
    type: "payment",
    typeColor: "bg-yellow-100 text-yellow-700",
  },
  {
    id: "#LOG-0036",
    time: "24/10/2023, 10:55",
    user: "Admin",
    avatar: "A",
    color: "bg-blue-600",
    action: "Vô hiệu hóa tài khoản",
    detail: "Ban user: elena.rod@univ.edu",
    ip: "10.0.0.1",
    type: "admin",
    typeColor: "bg-purple-100 text-purple-700",
  },
];

const TOTAL_PAGES = 48;

const LogsPage = () => {
  const [currentPage, setCurrentPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState("Tất cả");

  const filtered =
    typeFilter === "Tất cả"
      ? mockLogs
      : mockLogs.filter((l) => l.type === typeFilter.toLowerCase());

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">
              Nhật ký hoạt động
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Theo dõi toàn bộ hoạt động của người dùng và hệ thống theo thời
              gian thực.
            </p>
          </div>
          <button className="flex items-center gap-2 border border-gray-200 text-gray-600 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 transition-colors">
            <Download size={15} />
            Export Logs
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: "Tổng sự kiện (hôm nay)",
              value: "1,248",
              icon: "📋",
              color: "text-blue-600 bg-blue-50",
            },
            {
              label: "Đăng nhập",
              value: "342",
              icon: "🔐",
              color: "text-green-600 bg-green-50",
            },
            {
              label: "Chuyển đổi file",
              value: "513",
              icon: "📄",
              color: "text-orange-600 bg-orange-50",
            },
            {
              label: "Cảnh báo bảo mật",
              value: "12",
              icon: "⚠️",
              color: "text-red-600 bg-red-50",
            },
          ].map((s) => (
            <div
              key={s.label}
              className="bg-white rounded-xl p-4 border border-gray-100"
            >
              <div
                className={`text-xl w-9 h-9 flex items-center justify-center rounded-lg mb-2 ${s.color}`}
              >
                {s.icon}
              </div>
              <p className="text-xl font-black text-gray-900">{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Logs table */}
        <div className="bg-white rounded-xl border border-gray-100">
          {/* Filter bar */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 flex-wrap">
            <Filter size={15} className="text-gray-400" />
            <span className="text-sm text-gray-500 font-medium">Loại:</span>
            {[
              "Tất cả",
              "Auth",
              "Conversion",
              "Admin",
              "Payment",
              "Security",
            ].map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  typeFilter === t
                    ? "bg-blue-600 text-white"
                    : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {t}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-600">
              📅 Hôm nay
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50">
                  {[
                    "ID",
                    "THỜI GIAN",
                    "NGƯỜI DÙNG",
                    "HÀNH ĐỘNG",
                    "CHI TIẾT",
                    "IP",
                    "LOẠI",
                  ].map((h) => (
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
                {filtered.map((log, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                  >
                    <td className="px-5 py-3.5 text-xs font-mono text-gray-400">
                      {log.id}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-gray-500 whitespace-nowrap">
                      {log.time}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-8 h-8 rounded-full ${log.color} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}
                        >
                          {log.avatar}
                        </div>
                        <span className="text-sm font-medium text-gray-900 whitespace-nowrap">
                          {log.user}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-sm font-medium text-gray-800 whitespace-nowrap">
                      {log.action}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-gray-500 max-w-xs truncate">
                      {log.detail}
                    </td>
                    <td className="px-5 py-3.5 text-xs font-mono text-gray-400 whitespace-nowrap">
                      {log.ip}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`text-xs font-semibold px-2.5 py-1 rounded-full ${log.typeColor}`}
                      >
                        {log.type}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-center gap-1 px-5 py-4 border-t border-gray-100">
            <button
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <ChevronLeft size={14} /> Trước
            </button>
            {[1, 2, 3].map((p) => (
              <button
                key={p}
                onClick={() => setCurrentPage(p)}
                className={`w-8 h-8 text-sm rounded-lg transition-colors ${currentPage === p ? "bg-blue-600 text-white font-semibold" : "text-gray-600 hover:bg-gray-50 border border-gray-200"}`}
              >
                {p}
              </button>
            ))}
            <span className="px-2 text-gray-400 text-sm">...</span>
            <button
              onClick={() => setCurrentPage(TOTAL_PAGES)}
              className="w-8 h-8 text-sm rounded-lg text-gray-600 hover:bg-gray-50 border border-gray-200 transition-colors"
            >
              {TOTAL_PAGES}
            </button>
            <button
              onClick={() =>
                setCurrentPage(Math.min(TOTAL_PAGES, currentPage + 1))
              }
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
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
