import { useState } from "react";
import {
  Download,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";

const mockFiles = [
  {
    user: "James Smith",
    avatar: "JS",
    color: "bg-blue-500",
    file: "Q4_Report.xlxs",
    format: "MISA",
    size: "4.2 MB",
    status: "Hoàn thành",
    date: "24/10, 14:22",
  },
  {
    user: "Maria Anders",
    avatar: "MA",
    color: "bg-pink-500",
    file: "Profile_Large.xlxs",
    format: "MISA",
    size: "12.5 MB",
    status: "Đang xử lý",
    date: "24/10, 15:45",
  },
  {
    user: "Erik Bennett",
    avatar: "EB",
    color: "bg-orange-500",
    file: "Data_Analysis.xlsx",
    format: "MISA",
    size: "1.8 MB",
    status: "Lỗi",
    date: "24/10, 15:10",
  },
  {
    user: "Sarah Doe",
    avatar: "SD",
    color: "bg-purple-500",
    file: "Product_Demo_Final....",
    format: "MISA",
    size: "85.4 MB",
    status: "Hoàn thành",
    date: "23/10, 11:05",
  },
  {
    user: "Kevin Park",
    avatar: "KP",
    color: "bg-teal-500",
    file: "Budget_2024.xlsx",
    format: "MISA",
    size: "3.1 MB",
    status: "Hoàn thành",
    date: "23/10, 09:30",
  },
];

const statusStyle = {
  "Hoàn thành": "bg-green-100 text-green-700",
  "Đang xử lý": "bg-yellow-100 text-yellow-700",
  Lỗi: "bg-red-100 text-red-700",
};

const TOTAL_PAGES = 174;

const FilesPage = () => {
  const [currentPage, setCurrentPage] = useState(1);

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">
              Lịch sử chuyển đổi file
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Real-time overview of all conversion tasks processing in the
              cloud.
            </p>
          </div>
          <button className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors">
            <Download size={15} />
            Export Report
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: "Tổng lượt chuyển đổi",
              value: "12,842",
              change: "+12.4%",
              icon: "⇄",
              color: "text-blue-600 bg-blue-50",
            },
            {
              label: "Thành công",
              value: "11,205",
              change: "+8.2% Tỷ lệ lý chốt đơn",
              icon: "✓",
              color: "text-green-600 bg-green-50",
            },
            {
              label: "Lỗi",
              value: "124",
              change: "-5.1% so với tuần trước",
              icon: "✗",
              color: "text-red-600 bg-red-50",
            },
            {
              label: "Đang xử lý",
              value: "513",
              change: "4 giây / file",
              icon: "⟳",
              color: "text-yellow-600 bg-yellow-50",
            },
          ].map((s) => (
            <div
              key={s.label}
              className="bg-white rounded-xl p-4 border border-gray-100"
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-base font-bold w-9 h-9 flex items-center justify-center rounded-lg ${s.color}`}
                >
                  {s.icon}
                </span>
              </div>
              <p className="text-xl font-black text-gray-900">{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{s.change}</p>
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-100">
          {/* Filters */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
            <span className="text-sm text-gray-500 font-medium">Bộ lọc:</span>
            <select className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20">
              <option>Tất cả trạng thái</option>
              <option>Hoàn thành</option>
              <option>Đang xử lý</option>
              <option>Lỗi</option>
            </select>
            <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-600">
              <span>📅</span>
              <span>31/01/2023 - 31/02/2023</span>
            </div>
            <button className="ml-auto text-sm text-gray-400 hover:text-gray-600">
              ⚙ Reset Filters
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50">
                  {[
                    "USER",
                    "TÊN FILE",
                    "ĐỊNH DẠNG",
                    "KÍCH THƯỚC",
                    "TRẠNG THÁI",
                    "NGÀY & GIỜ",
                    "HÀNH ĐỘNG",
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
                {mockFiles.map((f, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-9 h-9 rounded-full ${f.color} flex items-center justify-center text-white text-xs font-bold`}
                        >
                          {f.avatar}
                        </div>
                        <span className="text-sm font-medium text-gray-900">
                          {f.user}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-gray-700 max-w-[160px] truncate">
                      {f.file}
                    </td>
                    <td className="px-5 py-4">
                      <span className="bg-gray-100 text-gray-600 text-xs font-semibold px-2.5 py-1 rounded">
                        {f.format}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-gray-500">
                      {f.size}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1.5 w-fit ${statusStyle[f.status]}`}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {f.status}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-gray-500">
                      {f.date}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors">
                          <Pencil size={14} />
                        </button>
                        <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                          <Trash2 size={14} />
                        </button>
                      </div>
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

export default FilesPage;
