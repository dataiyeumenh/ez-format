import { Check, X, Plus, Download } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";

const plans = [
  {
    name: "GÓI MIỄN PHÍ",
    price: "0 VND",
    period: "/tháng",
    users: 1248,
    badge: "ACTIVE",
    badgeColor: "bg-green-100 text-green-700",
    border: "border-gray-200",
  },
  {
    name: "GÓI THÁNG",
    price: "149k VND",
    period: "/tháng",
    users: 452,
    badge: "POPULAR",
    badgeColor: "bg-orange-100 text-orange-700",
    border: "border-gray-200",
  },
  {
    name: "GÓI NĂM",
    price: "109k VND",
    period: "/tháng",
    users: 896,
    badge: null,
    badgeColor: "",
    border: "border-gray-200",
  },
  {
    name: "THEO LƯỢT",
    price: "5K VND",
    period: "/1 file",
    users: 120,
    badge: null,
    badgeColor: "",
    border: "border-gray-200",
  },
];

const features = [
  {
    name: "Monthly Conversions",
    free: "20 file",
    student: "100 file",
    personal: "500 file",
    class: "Vô hạn",
    studentColor: "text-blue-600 font-semibold",
    personalColor: "text-blue-600 font-semibold",
    classColor: "text-blue-600 font-semibold",
  },
  {
    name: "Max File Size",
    free: "5 MB",
    student: "50 MB",
    personal: "200 MB",
    class: "1 GB",
  },
  {
    name: "Batch Processing",
    free: false,
    student: "Lên tới 5 files",
    personal: "Up to 20 files",
    class: true,
  },
  {
    name: "Priority Support",
    free: false,
    student: false,
    personal: true,
    class: true,
  },
  {
    name: "Cloud Storage",
    free: "None",
    student: "1 GB",
    personal: "10 GB",
    class: "100 GB",
  },
];

const renderCell = (val) => {
  if (val === true)
    return <Check size={16} className="text-green-500 mx-auto" />;
  if (val === false) return <X size={16} className="text-gray-300 mx-auto" />;
  return <span className="text-sm text-gray-700">{val}</span>;
};

const PlansPage = () => {
  return (
    <AdminLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">
              Quản lý gói dịch vụ
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Quản lý danh sách gói dịch vụ và điều chỉnh giá đăng ký hệ thống.
            </p>
          </div>
          <button className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors">
            <Plus size={15} />
            Đăng ký gói mới
          </button>
        </div>

        {/* Plan cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`bg-white rounded-xl p-5 border ${p.border} relative`}
            >
              {p.badge && (
                <span
                  className={`absolute top-4 right-4 text-xs font-bold px-2.5 py-0.5 rounded-full ${p.badgeColor}`}
                >
                  {p.badge}
                </span>
              )}
              <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center mb-3">
                <span className="text-blue-600 text-xl">📦</span>
              </div>
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
                {p.name}
              </p>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-xl font-black text-gray-900">
                  {p.price}
                </span>
                <span className="text-xs text-gray-400">{p.period}</span>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Active Users{" "}
                <span className="font-semibold text-gray-700 ml-1">
                  {p.users.toLocaleString()}
                </span>
              </p>
              <button className="w-full border border-gray-200 text-gray-600 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors">
                Edit Plan
              </button>
            </div>
          ))}
        </div>

        {/* Features table */}
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">
              Plan Features & Limits
            </h3>
            <div className="flex items-center gap-2">
              <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-50 text-gray-400 transition-colors">
                ⚙
              </button>
              <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-50 text-gray-400 transition-colors">
                <Download size={14} />
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50">
                  <th className="text-left text-xs font-semibold text-gray-400 uppercase px-5 py-3">
                    FEATURE NAME
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-400 uppercase px-5 py-3">
                    FREE
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-400 uppercase px-5 py-3">
                    STUDENT
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-400 uppercase px-5 py-3">
                    PERSONAL
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-400 uppercase px-5 py-3">
                    CLASS
                  </th>
                </tr>
              </thead>
              <tbody>
                {features.map((f, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                  >
                    <td className="px-5 py-3.5 text-sm font-medium text-gray-800">
                      {f.name}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {renderCell(f.free)}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {renderCell(f.student)}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {renderCell(f.personal)}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {renderCell(f.class)}
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

export default PlansPage;
