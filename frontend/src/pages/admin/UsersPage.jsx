import { useState, useEffect, useCallback } from "react";
import {
  Pencil,
  Trash2,
  UserPlus,
  Download,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";

const ITEMS_PER_PAGE = 10;

const PLAN_STYLES = {
  Free: "bg-gray-100 text-gray-600",
  Monthly: "bg-blue-100 text-blue-700",
  Yearly: "bg-purple-100 text-purple-700",
  PerFile: "bg-yellow-100 text-yellow-700",
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

const statusStyle = {
  Active: "bg-green-100 text-green-700",
  Banned: "bg-red-100 text-red-700",
};

const getInitials = (name = "") =>
  name
    .split(" ")
    .slice(-2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

const getAvatarColor = (id = "") =>
  AVATAR_COLORS[parseInt(id.toString().slice(-2), 16) % AVATAR_COLORS.length];

const formatDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

const formatLastActive = (iso) => {
  if (!iso) return "Chưa có";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "Vừa xong";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} phút trước`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} giờ trước`;
  return `${Math.floor(diff / 86400000)} ngày trước`;
};

const UsersPage = () => {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [filterPlan, setFilterPlan] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    email: "",
    password: "",
    plan: "Free",
  });
  const [addLoading, setAddLoading] = useState(false);
  const [deleteId, setDeleteId] = useState(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page: currentPage, limit: ITEMS_PER_PAGE };
      if (filterPlan) params.plan = filterPlan;
      if (filterStatus) params.status = filterStatus;
      const { data } = await api.get("/admin/users", { params });
      setUsers(data.users);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(
        err.response?.data?.message || "Không thể tải danh sách người dùng",
      );
    } finally {
      setLoading(false);
    }
  }, [currentPage, filterPlan, filterStatus]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleDelete = async (id) => {
    if (!window.confirm("Bạn có chắc muốn xóa người dùng này?")) return;
    setDeleteId(id);
    try {
      await api.delete(`/admin/users/${id}`);
      fetchUsers();
    } catch (err) {
      alert(err.response?.data?.message || "Xóa thất bại");
    } finally {
      setDeleteId(null);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setAddLoading(true);
    try {
      await api.post("/admin/users", addForm);
      setShowAddModal(false);
      setAddForm({ name: "", email: "", password: "", plan: "Free" });
      fetchUsers();
    } catch (err) {
      alert(err.response?.data?.message || "Tạo tài khoản thất bại");
    } finally {
      setAddLoading(false);
    }
  };

  const resetFilters = () => {
    setFilterPlan("");
    setFilterStatus("");
    setCurrentPage(1);
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

  return (
    <AdminLayout>
      <div className="p-6 space-y-5">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">
              Quản lý người dùng
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Quản lý, xác thực và giám sát người dùng cùng các gói đăng ký trên
              hệ thống.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 border border-gray-300 text-gray-600 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 transition-colors">
              <Download size={15} /> Export CSV
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
            >
              <UserPlus size={15} /> Thêm người dùng
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: "TỔNG NGƯỜI DÙNG",
              value: total,
              icon: "👥",
              color: "text-blue-600 bg-blue-50",
            },
            {
              label: "ĐANG HOẠT ĐỘNG",
              value: users.filter((u) => u.isActive).length,
              icon: "✅",
              color: "text-green-600 bg-green-50",
            },
            {
              label: "BỊ KHÓA",
              value: users.filter((u) => !u.isActive).length,
              icon: "🚫",
              color: "text-red-600 bg-red-50",
            },
            {
              label: "TRANG HIỆN TẠI",
              value: `${currentPage}/${totalPages}`,
              icon: "📄",
              color: "text-purple-600 bg-purple-50",
            },
          ].map((s) => (
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
              <p className="text-xs text-gray-500 mt-0.5 uppercase">
                {s.label}
              </p>
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
                value={filterPlan}
                onChange={(e) => {
                  setFilterPlan(e.target.value);
                  setCurrentPage(1);
                }}
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="">Gói dịch vụ</option>
                <option value="Free">Free</option>
                <option value="Monthly">Monthly</option>
                <option value="Yearly">Yearly</option>
                <option value="PerFile">PerFile</option>
              </select>
              <select
                value={filterStatus}
                onChange={(e) => {
                  setFilterStatus(e.target.value);
                  setCurrentPage(1);
                }}
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="">Tất cả trạng thái</option>
                <option value="Active">Active</option>
                <option value="Banned">Banned</option>
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
                  onClick={fetchUsers}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Thử lại
                </button>
              </div>
            ) : users.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
                Không có người dùng nào
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-50">
                    {[
                      "USER",
                      "GÓI DỊCH VỤ",
                      "TRẠNG THÁI",
                      "HOẠT ĐỘNG GẦN NHẤT",
                      "NGÀY THAM GIA",
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
                  {users.map((u) => {
                    const initials = getInitials(u.name);
                    const avatarColor = getAvatarColor(u._id);
                    const status = u.isActive ? "Active" : "Banned";
                    const planStyle =
                      PLAN_STYLES[u.plan] || "bg-gray-100 text-gray-600";
                    return (
                      <tr
                        key={u._id}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div
                              className={`w-9 h-9 rounded-full ${avatarColor} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}
                            >
                              {initials}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-gray-900">
                                {u.name}
                              </p>
                              <p className="text-xs text-gray-400">{u.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`text-xs font-semibold px-2.5 py-1 rounded-full ${planStyle}`}
                          >
                            {u.plan}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`flex items-center gap-1.5 text-xs font-medium w-fit px-2.5 py-1 rounded-full ${statusStyle[status]}`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-current" />
                            {status}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-sm text-gray-500">
                          {formatLastActive(u.updatedAt)}
                        </td>
                        <td className="px-5 py-4 text-sm text-gray-500">
                          {formatDate(u.createdAt)}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors">
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => handleDelete(u._id)}
                              disabled={deleteId === u._id}
                              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
                            >
                              {deleteId === u._id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Trash2 size={14} />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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
                  <span
                    key={`ellipsis-${i}`}
                    className="px-2 text-gray-400 text-sm"
                  >
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
                onClick={() =>
                  setCurrentPage(Math.min(totalPages, currentPage + 1))
                }
                disabled={currentPage === totalPages}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40"
              >
                Sau <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Add User Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-gray-900 mb-4">
              Thêm người dùng mới
            </h2>
            <form onSubmit={handleAddUser} className="space-y-4">
              {[
                {
                  label: "Họ và tên",
                  key: "name",
                  placeholder: "Nguyễn Văn A",
                  type: "text",
                },
                {
                  label: "Email",
                  key: "email",
                  placeholder: "email@example.com",
                  type: "email",
                },
                {
                  label: "Mật khẩu",
                  key: "password",
                  placeholder: "••••••••",
                  type: "password",
                },
              ].map((f) => (
                <div key={f.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    {f.label}
                  </label>
                  <input
                    type={f.type}
                    placeholder={f.placeholder}
                    value={addForm[f.key]}
                    onChange={(e) =>
                      setAddForm((prev) => ({
                        ...prev,
                        [f.key]: e.target.value,
                      }))
                    }
                    required
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>
              ))}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Gói dịch vụ
                </label>
                <select
                  value={addForm.plan}
                  onChange={(e) =>
                    setAddForm((prev) => ({ ...prev, plan: e.target.value }))
                  }
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="Free">Free</option>
                  <option value="Monthly">Monthly</option>
                  <option value="Yearly">Yearly</option>
                  <option value="PerFile">PerFile</option>
                </select>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={addLoading}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {addLoading && <Loader2 size={14} className="animate-spin" />}
                  {addLoading ? "Đang tạo..." : "Tạo tài khoản"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
};

export default UsersPage;
