import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Pencil,
  Plus,
  TicketPercent,
  Trash2,
  X,
} from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";

const emptyForm = {
  code: "",
  description: "",
  discountPercent: 10,
  maxDiscountAmount: "",
  applicablePlans: [],
  usageLimit: 100,
  limitPerUser: 1,
  startDate: "",
  endDate: "",
  status: "active",
};

const STATUS_STYLES = {
  active: "bg-emerald-100 text-emerald-700",
  inactive: "bg-gray-100 text-gray-600",
  expired: "bg-amber-100 text-amber-700",
  exhausted: "bg-red-100 text-red-700",
};

const STATUS_LABELS = {
  active: "Đang hoạt động",
  inactive: "Tạm ngưng",
  expired: "Hết hạn",
  exhausted: "Hết lượt",
};

function toDateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
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

function formatVnd(amount) {
  if (amount === null || amount === undefined || amount === "") return "Không giới hạn";
  return `${new Intl.NumberFormat("vi-VN").format(Number(amount))} VND`;
}

function couponToForm(coupon) {
  return {
    code: coupon.code || "",
    description: coupon.description || "",
    discountPercent: coupon.discountPercent || 1,
    maxDiscountAmount:
      coupon.maxDiscountAmount === null || coupon.maxDiscountAmount === undefined
        ? ""
        : coupon.maxDiscountAmount,
    applicablePlans: (coupon.applicablePlans || []).map((plan) => plan.id),
    usageLimit: coupon.usageLimit || 1,
    limitPerUser: coupon.limitPerUser || 1,
    startDate: toDateInputValue(coupon.startDate),
    endDate: toDateInputValue(coupon.endDate),
    status: coupon.status === "inactive" ? "inactive" : "active",
  };
}

const CouponsPage = () => {
  const [coupons, setCoupons] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [modalMode, setModalMode] = useState(null);
  const [editingCoupon, setEditingCoupon] = useState(null);
  const [deletingCoupon, setDeletingCoupon] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const isEditing = modalMode === "edit";
  const modalTitle = isEditing ? "Chỉnh sửa coupon" : "Thêm coupon mới";

  const filteredCountLabel = useMemo(() => {
    if (!filterStatus) return `${coupons.length} coupon`;
    return `${coupons.length} coupon · ${STATUS_LABELS[filterStatus] || filterStatus}`;
  }, [coupons.length, filterStatus]);

  const fetchPlans = async () => {
    const { data } = await api.get("/admin/coupon-plan-options");
    setPlans(data.plans || []);
  };

  const fetchCoupons = async (status = filterStatus) => {
    setLoading(true);
    setError("");
    try {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      const { data } = await api.get(`/admin/coupons${query}`);
      setCoupons(data.coupons || []);
    } catch (err) {
      setError(err.response?.data?.message || "Không thể tải danh sách coupon.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    Promise.all([fetchPlans(), fetchCoupons()]).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchCoupons(filterStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus]);

  const openCreateModal = () => {
    setEditingCoupon(null);
    setForm(emptyForm);
    setError("");
    setModalMode("create");
  };

  const openEditModal = (coupon) => {
    setEditingCoupon(coupon);
    setForm(couponToForm(coupon));
    setError("");
    setModalMode("edit");
  };

  const closeModal = () => {
    if (saving) return;
    setModalMode(null);
    setEditingCoupon(null);
    setForm(emptyForm);
  };

  const updateForm = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const togglePlan = (planId) => {
    setForm((prev) => {
      const exists = prev.applicablePlans.includes(planId);
      return {
        ...prev,
        applicablePlans: exists
          ? prev.applicablePlans.filter((id) => id !== planId)
          : [...prev.applicablePlans, planId],
      };
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        discountPercent: Number(form.discountPercent || 0),
        usageLimit: Number(form.usageLimit || 0),
        limitPerUser: Number(form.limitPerUser || 0),
        maxDiscountAmount:
          form.maxDiscountAmount === "" ? null : Number(form.maxDiscountAmount),
        startDate: form.startDate ? new Date(form.startDate).toISOString() : "",
        endDate: form.endDate ? new Date(form.endDate).toISOString() : "",
      };

      if (isEditing) {
        await api.put(`/admin/coupons/${editingCoupon.id}`, payload);
      } else {
        await api.post("/admin/coupons", payload);
      }
      closeModal();
      await fetchCoupons(filterStatus);
    } catch (err) {
      setError(err.response?.data?.message || "Không thể lưu coupon.");
    } finally {
      setSaving(false);
    }
  };

  const openDeleteModal = (coupon) => {
    setError("");
    setDeletingCoupon(coupon);
  };

  const closeDeleteModal = () => {
    if (deleting) return;
    setDeletingCoupon(null);
  };

  const handleDeleteCoupon = async () => {
    if (!deletingCoupon) return;
    setDeleting(true);
    setError("");
    try {
      await api.delete(`/admin/coupons/${deletingCoupon.id}`);
      setDeletingCoupon(null);
      await fetchCoupons(filterStatus);
    } catch (err) {
      setError(err.response?.data?.message || "Không thể xoá coupon.");
      setDeletingCoupon(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AdminLayout>
      <div className="p-6 space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900">Chương trình đặc biệt</h1>
            <p className="mt-0.5 text-sm text-gray-500">
              Quản lý coupon giảm giá áp dụng cho các gói dịch vụ.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            <Plus size={15} />
            Thêm coupon
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <TicketPercent size={16} className="text-blue-600" />
              <span className="font-medium text-gray-700">{filteredCountLabel}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-500">Bộ lọc:</span>
              <select
                aria-label="Lọc coupon theo trạng thái"
                value={filterStatus}
                onChange={(event) => setFilterStatus(event.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="">Tất cả trạng thái</option>
                <option value="active">Đang hoạt động</option>
                <option value="inactive">Tạm ngưng</option>
                <option value="expired">Hết hạn</option>
                <option value="exhausted">Hết lượt</option>
              </select>
              {filterStatus && (
                <button
                  type="button"
                  onClick={() => setFilterStatus("")}
                  className="text-sm text-gray-400 transition-colors hover:text-gray-600"
                >
                  Reset
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center gap-3 py-16 text-gray-400">
                <Loader2 size={20} className="animate-spin" />
                <span className="text-sm">Đang tải...</span>
              </div>
            ) : coupons.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-gray-400">
                Chưa có coupon nào
              </div>
            ) : (
              <table className="w-full min-w-[1100px]">
                <thead>
                  <tr className="border-b border-gray-50">
                    {[
                      "Mã",
                      "Giảm giá",
                      "Gói áp dụng",
                      "Lượt dùng",
                      "Mỗi user",
                      "Thời gian",
                      "Trạng thái",
                      "Hành động",
                    ].map((header) => (
                      <th
                        key={header}
                        className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {coupons.map((coupon) => {
                    const effective = coupon.effectiveStatus || coupon.status;
                    return (
                      <tr
                        key={coupon.id}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60"
                      >
                        <td className="px-5 py-4">
                          <p className="font-mono text-sm font-bold text-gray-900">
                            {coupon.code}
                          </p>
                          <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
                            {coupon.description || "Không có mô tả"}
                          </p>
                        </td>
                        <td className="px-5 py-4 text-sm text-gray-700">
                          <p className="font-semibold">{coupon.discountPercent}%</p>
                          <p className="text-xs text-gray-500">
                            Max: {formatVnd(coupon.maxDiscountAmount)}
                          </p>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-1">
                            {(coupon.applicablePlans || []).map((plan) => (
                              <span
                                key={plan.id}
                                className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700"
                              >
                                {plan.name || plan.code}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-4 text-sm text-gray-700">
                          <span className="font-semibold">{coupon.usageCount}</span>
                          <span className="text-gray-400"> / {coupon.usageLimit}</span>
                        </td>
                        <td className="px-5 py-4 text-sm font-semibold text-gray-700">
                          {coupon.limitPerUser}
                        </td>
                        <td className="px-5 py-4 text-xs text-gray-600">
                          <p>{formatDateTime(coupon.startDate)}</p>
                          <p className="text-gray-400">→ {formatDateTime(coupon.endDate)}</p>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${
                              STATUS_STYLES[effective] || STATUS_STYLES.inactive
                            }`}
                          >
                            {STATUS_LABELS[effective] || effective}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditModal(coupon)}
                              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-white"
                            >
                              <Pencil size={13} />
                              Sửa
                            </button>
                            <button
                              type="button"
                              onClick={() => openDeleteModal(coupon)}
                              className="inline-flex items-center justify-center rounded-lg border border-red-200 px-2.5 py-1.5 text-red-600 hover:bg-red-50"
                              title="Xoá coupon"
                            >
                              <Trash2 size={13} />
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
        </div>
      </div>

      {modalMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={closeModal}
        >
          <div
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{modalTitle}</h2>
                <p className="text-sm text-gray-500">
                  Code do admin nhập. Max discount là tuỳ chọn.
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Đóng"
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-50"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Mã coupon (Code)
                </label>
                <input
                  aria-label="Mã coupon"
                  value={form.code}
                  onChange={(event) =>
                    updateForm("code", event.target.value.toUpperCase())
                  }
                  required
                  placeholder="SUMMER20"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 font-mono text-sm uppercase focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Trạng thái
                </label>
                <select
                  aria-label="Trạng thái coupon"
                  value={form.status}
                  onChange={(event) => updateForm("status", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="active">Đang hoạt động</option>
                  <option value="inactive">Tạm ngưng</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Mô tả
                </label>
                <textarea
                  aria-label="Mô tả coupon"
                  rows={2}
                  value={form.description}
                  onChange={(event) => updateForm("description", event.target.value)}
                  placeholder="Giảm giá chương trình hè..."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  % giảm giá (1–100)
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  required
                  aria-label="Phần trăm giảm giá"
                  value={form.discountPercent}
                  onChange={(event) => updateForm("discountPercent", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Giảm tối đa (VND, tuỳ chọn)
                </label>
                <input
                  type="number"
                  min="1"
                  aria-label="Số tiền giảm tối đa"
                  value={form.maxDiscountAmount}
                  onChange={(event) => updateForm("maxDiscountAmount", event.target.value)}
                  placeholder="VD: 50000"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Usage limit
                </label>
                <input
                  type="number"
                  min="1"
                  required
                  aria-label="Giới hạn lượt dùng"
                  value={form.usageLimit}
                  onChange={(event) => updateForm("usageLimit", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Limit per user
                </label>
                <input
                  type="number"
                  min="1"
                  required
                  aria-label="Giới hạn mỗi user"
                  value={form.limitPerUser}
                  onChange={(event) => updateForm("limitPerUser", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Ngày bắt đầu
                </label>
                <input
                  type="datetime-local"
                  required
                  aria-label="Ngày bắt đầu"
                  value={form.startDate}
                  onChange={(event) => updateForm("startDate", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Ngày kết thúc
                </label>
                <input
                  type="datetime-local"
                  required
                  aria-label="Ngày kết thúc"
                  value={form.endDate}
                  onChange={(event) => updateForm("endDate", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Gói áp dụng
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {plans
                    .filter((plan) => plan.isActive !== false && plan.code !== "free")
                    .map((plan) => {
                    const checked = form.applicablePlans.includes(plan.id);
                    return (
                      <label
                        key={plan.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                          checked
                            ? "border-blue-200 bg-blue-50 text-blue-800"
                            : "border-gray-200 bg-white text-gray-700"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePlan(plan.id)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600"
                        />
                        <span className="font-semibold">{plan.name}</span>
                        <span className="text-xs text-gray-400">({plan.code})</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="mt-2 flex gap-3 md:col-span-2">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Huỷ
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-400"
                >
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {saving ? "Đang lưu..." : "Lưu coupon"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deletingCoupon && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={closeDeleteModal}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
              <Trash2 size={22} />
            </div>
            <h2 className="text-lg font-bold text-gray-900">Xoá coupon?</h2>
            <p className="mt-2 text-sm text-gray-600">
              Bạn sắp xoá mã{" "}
              <span className="font-mono font-semibold text-gray-900">
                {deletingCoupon.code}
              </span>
              . Hành động này không thể hoàn tác.
            </p>
            {Number(deletingCoupon.usageCount || 0) > 0 && (
              <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Coupon này đã dùng {deletingCoupon.usageCount} lần. Hệ thống sẽ từ chối
                xoá — hãy đặt Inactive thay thế.
              </p>
            )}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={closeDeleteModal}
                disabled={deleting}
                className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Huỷ
              </button>
              <button
                type="button"
                onClick={handleDeleteCoupon}
                disabled={deleting}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-red-400"
              >
                {deleting && <Loader2 size={14} className="animate-spin" />}
                {deleting ? "Đang xoá..." : "Xoá coupon"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
};

export default CouponsPage;
