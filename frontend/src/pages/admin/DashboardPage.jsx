import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import { TrendingUp, ArrowUpRight, Users, FileText, Activity } from "lucide-react";
import { Link } from "react-router-dom";
import AdminLayout from "../../components/admin/AdminLayout";

// ─── Mock data ─────────────────────────────────────────────────────────────
const lineData = [
  { day: "MON", value: 30 },
  { day: "TUE", value: 55 },
  { day: "WED", value: 70 },
  { day: "THU", value: 45 },
  { day: "FRI", value: 90 },
  { day: "SAT", value: 60 },
  { day: "SUN", value: 75 },
];

const barData = [
  { week: "Tuần 1", value: 4200 },
  { week: "Tuần 2", value: 5800 },
  { week: "Tuần 3", value: 3900 },
  { week: "Tuần 4", value: 7200 },
];

const pieData = [
  { name: "Gói Miễn Phí", value: 45, color: "#3B82F6" },
  { name: "Gói Tháng", value: 25, color: "#8B5CF6" },
  { name: "Gói Năm", value: 20, color: "#6366F1" },
  { name: "Theo Lượt", value: 10, color: "#1E40AF" },
];

const recentConversions = [
  {
    user: "Sarah Jenkins",
    email: "sarah@example.com",
    file: "sales_data.xlsx",
    format: "EXCEL",
    status: "Completed",
    time: "2 mins ago",
  },
  {
    user: "Michael Chen",
    email: "michael@example.com",
    file: "sales_xlsx",
    format: "EXCEL",
    status: "Processing",
    time: "5 mins ago",
  },
  {
    user: "Jessica Vane",
    email: "jessica@example.com",
    file: "sales_4q01.xlsx",
    format: "EXCEL",
    status: "Failed",
    time: "10 mins ago",
  },
  {
    user: "Robert Fox",
    email: "robert@example.com",
    file: "sales_4q01.xlsx",
    format: "EXCEL",
    status: "Completed",
    time: "15 mins ago",
  },
];

const newUsers = [
  {
    name: "Jane Doe",
    email: "jane@example.com",
    plan: "Tháng",
    planColor: "bg-blue-500",
    initials: "JD",
  },
  {
    name: "Tom Miller",
    email: "tom@example.com",
    plan: "Năm",
    planColor: "bg-purple-500",
    initials: "TM",
  },
  {
    name: "Arun Kumar",
    email: "arun@example.com",
    plan: "Miễn phí",
    planColor: "bg-green-500",
    initials: "AK",
  },
  {
    name: "Lisa Stone",
    email: "lisa@example.com",
    plan: "Lượt",
    planColor: "bg-orange-500",
    initials: "LS",
  },
];

const statusStyle = {
  Completed: "bg-green-100 text-green-700",
  Processing: "bg-blue-100 text-blue-700",
  Failed: "bg-red-100 text-red-700",
};

const navItems = [
  { label: "Tổng quan", path: "/admin" },
];

// ─── Component ───────────────────────────────────────────────────────────────
const DashboardPage = () => {
  return (
    <AdminLayout>
      <div className="p-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[
            { label: "TỔNG NGƯỜI DÙNG", value: "12,450", change: "+12%", icon: Users, color: "text-blue-600 bg-blue-50" },
            { label: "ĐANG HOẠT ĐỘNG", value: "8,210", change: "+9%", icon: Activity, color: "text-purple-600 bg-purple-50" },
            { label: "FILE ĐÃ XỬ LÝ HÔM NAY", value: "450", change: "+18%", icon: FileText, color: "text-orange-600 bg-orange-50" },
            { label: "DOANH THU THÁNG", value: "$15,200", change: "+7%", icon: TrendingUp, color: "text-green-600 bg-green-50" },
          ].map((stat) => (
            <div key={stat.label} className="bg-white rounded-xl p-5 border border-gray-100">
              <div className="flex items-center justify-between mb-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${stat.color}`}>
                  <stat.icon size={20} />
                </div>
                <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                  <ArrowUpRight size={12} />
                  {stat.change}
                </span>
              </div>
              <p className="text-2xl font-black text-gray-900">{stat.value}</p>
              <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Line chart */}
          <div className="bg-white rounded-xl p-5 border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-900">Chuyển đổi file</h3>
              <select className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-600">
                <option>7 ngày</option>
                <option>30 ngày</option>
              </select>
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={lineData}>
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#9CA3AF" }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip contentStyle={{ fontSize: 12, border: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.1)", borderRadius: 8 }} cursor={{ stroke: "#E5E7EB" }} />
                <Line type="monotone" dataKey="value" stroke="#3B82F6" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Bar chart */}
          <div className="bg-white rounded-xl p-5 border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">Doanh thu hàng tháng</h3>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={barData} barSize={28}>
                <XAxis dataKey="week" tick={{ fontSize: 10, fill: "#9CA3AF" }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip contentStyle={{ fontSize: 12, border: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.1)", borderRadius: 8 }} cursor={false} />
                <Bar dataKey="value" fill="#3B82F6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Pie chart */}
          <div className="bg-white rounded-xl p-5 border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">Phân bổ gói dịch vụ</h3>
            <div className="flex items-center gap-4">
              <div className="relative">
                <ResponsiveContainer width={100} height={100}>
                  <PieChart>
                    <Pie data={pieData} cx={45} cy={45} innerRadius={30} outerRadius={45} dataKey="value" strokeWidth={0}>
                      {pieData.map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-sm font-bold text-gray-900">8.2k</span>
                  <span className="text-xs text-gray-400">ACTIVE</span>
                </div>
              </div>
              <div className="flex-1 space-y-1.5">
                {pieData.map((item) => (
                  <div key={item.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-xs text-gray-600">{item.name}</span>
                    </div>
                    <span className="text-xs font-medium text-gray-700">{item.value}%</span>
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
              <h3 className="text-sm font-semibold text-gray-900">Chuyển đổi gần đây</h3>
              <Link to="/admin/files" className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                Xem tất cả
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-50">
                    {["Người dùng", "File", "Định dạng", "Trạng thái", "Thời gian"].map((h) => (
                      <th key={h} className="text-left text-xs font-medium text-gray-400 uppercase px-5 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentConversions.map((row, i) => (
                    <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                      <td className="px-5 py-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{row.user}</p>
                          <p className="text-xs text-gray-400">{row.email}</p>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-600">{row.file}</td>
                      <td className="px-5 py-3">
                        <span className="bg-blue-50 text-blue-700 text-xs font-medium px-2 py-0.5 rounded">{row.format}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusStyle[row.status]}`}>
                          ● {row.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-gray-400">{row.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* New users */}
          <div className="bg-white rounded-xl border border-gray-100">
            <div className="p-5 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Người dùng mới hôm nay</h3>
            </div>
            <div className="p-5 space-y-4">
              {newUsers.map((u, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full ${u.planColor} flex items-center justify-center text-white text-xs font-bold`}>
                      {u.initials}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{u.name}</p>
                      <p className="text-xs text-gray-400">{u.email}</p>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-gray-600 border border-gray-200 px-2 py-0.5 rounded-full">
                    {u.plan}
                  </span>
                </div>
              ))}
              <Link to="/admin/users" className="block w-full text-center text-xs text-blue-600 hover:text-blue-700 font-medium pt-2">
                Xem 42 người dùng đăng mới
              </Link>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
};

export default DashboardPage;
