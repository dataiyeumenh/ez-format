import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Star, X } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";

const emptyForm = {
  code: "",
  name: "",
  price: 0,
  displayPrice: "",
  periodLabel: "",
  description: "",
  featuresText: "",
  durationDays: 0,
  fileCredits: 0,
  isPopular: false,
  isActive: true,
  sortOrder: 0,
};

function formatVnd(amount) {
  return new Intl.NumberFormat("vi-VN").format(Number(amount || 0));
}

function planToForm(plan) {
  return {
    code: plan.code || "",
    name: plan.name || "",
    price: plan.price || 0,
    displayPrice: plan.displayPrice || "",
    periodLabel: plan.periodLabel || "",
    description: plan.description || "",
    featuresText: (plan.features || []).join("\n"),
    durationDays: plan.durationDays || 0,
    fileCredits: plan.fileCredits || 0,
    isPopular: Boolean(plan.isPopular),
    isActive: plan.isActive !== false,
    sortOrder: plan.sortOrder || 0,
  };
}

const PlansPage = () => {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [modalMode, setModalMode] = useState(null);
  const [editingPlan, setEditingPlan] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const isEditing = modalMode === "edit";
  const modalTitle = isEditing ? "Chỉnh sửa gói dịch vụ" : "Thêm gói mới";

  const popularPlan = useMemo(() => plans.find((plan) => plan.isPopular), [plans]);

  const fetchPlans = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/admin/plans");
      setPlans(data.plans || []);
    } catch (err) {
      setError(err.response?.data?.message || "Không thể tải danh sách gói.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlans();
  }, []);

  const openCreateModal = () => {
    setEditingPlan(null);
    setForm(emptyForm);
    setModalMode("create");
  };

  const openEditModal = (plan) => {
    setEditingPlan(plan);
    setForm(planToForm(plan));
    setModalMode("edit");
  };

  const closeModal = () => {
    if (saving) return;
    setModalMode(null);
    setEditingPlan(null);
    setForm(emptyForm);
  };

  const updateForm = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        price: Number(form.price || 0),
        durationDays: Number(form.durationDays || 0),
        fileCredits: Number(form.fileCredits || 0),
        sortOrder: Number(form.sortOrder || 0),
      };
      if (isEditing) {
        await api.put(`/admin/plans/${editingPlan.id}`, payload);
      } else {
        await api.post("/admin/plans", payload);
      }
      closeModal();
      await fetchPlans();
    } catch (err) {
      setError(err.response?.data?.message || "Không thể lưu gói dịch vụ.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-gray-900">Quản lý gói dịch vụ</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Tạo/sửa gói và đồng bộ trực tiếp với trang Pricing.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
          >
            <Plus size={15} />
            Thêm gói mới
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center rounded-xl bg-white py-20 text-blue-600">
            <Loader2 size={26} className="animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className={`relative rounded-xl border bg-white p-5 ${
                  plan.isPopular
                    ? "border-blue-500 shadow-lg shadow-blue-100"
                    : "border-gray-200"
                }`}
              >
                {plan.isPopular && (
                  <span className="absolute right-4 top-4 rounded-full bg-blue-600 px-2.5 py-1 text-[10px] font-bold uppercase text-white">
                    PHỔ BIẾN
                  </span>
                )}
                {!plan.isActive && (
                  <span className="absolute right-4 top-4 rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-bold uppercase text-gray-500">
                    INACTIVE
                  </span>
                )}

                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
                  <span className="text-xl">📦</span>
                </div>
                <p className="mb-1 text-xs font-bold uppercase tracking-wider text-gray-500">
                  {plan.name}
                </p>
                <div className="mb-1 flex items-baseline gap-1">
                  <span className="text-xl font-black text-gray-900">
                    {plan.displayPrice}
                  </span>
                  <span className="text-xs text-gray-400">{plan.periodLabel}</span>
                </div>
                <p className="mb-2 text-xs text-gray-500">
                  Giá thật:{" "}
                  <span className="font-semibold">{formatVnd(plan.price)} VND</span>
                </p>
                <p className="mb-2 text-xs text-gray-500">
                  Active Users{" "}
                  <span className="ml-1 font-semibold text-gray-700">
                    {Number(plan.activeUsers || 0).toLocaleString("vi-VN")}
                  </span>
                </p>
                {plan.isPopular && popularPlan?.id === plan.id && (
                  <p className="mb-3 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">
                    <Star size={12} /> Đang nổi bật ở Pricing
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => openEditModal(plan)}
                  className="mt-2 w-full rounded-lg border border-gray-200 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                >
                  Chỉnh sửa
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={closeModal}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{modalTitle}</h2>
                <p className="text-sm text-gray-500">
                  Chọn Phổ biến để hiện nổi bật ở trang Bảng giá.
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

            <form
              onSubmit={handleSubmit}
              className="grid grid-cols-1 gap-4 md:grid-cols-2"
            >
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Mã gói (Code)
                </label>
                <input
                  aria-label="Mã gói (Code)"
                  value={form.code}
                  onChange={(event) => updateForm("code", event.target.value)}
                  disabled={isEditing}
                  required
                  placeholder="monthly"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-50"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Tên gói
                </label>
                <input
                  aria-label="Tên gói"
                  value={form.name}
                  onChange={(event) => updateForm("name", event.target.value)}
                  required
                  placeholder="GÓI THÁNG"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Giá thanh toán
                </label>
                <input
                  type="number"
                  aria-label="Giá thanh toán"
                  min="0"
                  value={form.price}
                  onChange={(event) => updateForm("price", event.target.value)}
                  required
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Giá hiển thị
                </label>
                <input
                  aria-label="Giá hiển thị"
                  value={form.displayPrice}
                  onChange={(event) => updateForm("displayPrice", event.target.value)}
                  required
                  placeholder="149k"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Chu kỳ hiển thị
                </label>
                <input
                  aria-label="Chu kỳ hiển thị"
                  value={form.periodLabel}
                  onChange={(event) => updateForm("periodLabel", event.target.value)}
                  placeholder="/tháng"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Sắp xếp
                </label>
                <input
                  type="number"
                  aria-label="Sắp xếp"
                  min="0"
                  value={form.sortOrder}
                  onChange={(event) => updateForm("sortOrder", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Thời hạn (ngày)
                </label>
                <input
                  type="number"
                  aria-label="Thời hạn (ngày)"
                  min="0"
                  value={form.durationDays}
                  onChange={(event) => updateForm("durationDays", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Lượt chuyển đổi (dành cho gói PerFile)
                </label>
                <input
                  type="number"
                  aria-label="Lượt chuyển đổi (dành cho gói PerFile)"
                  min="0"
                  value={form.fileCredits}
                  onChange={(event) => updateForm("fileCredits", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Mô tả
                </label>
                <textarea
                  aria-label="Mô tả"
                  rows={2}
                  value={form.description}
                  onChange={(event) => updateForm("description", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Tính năng, mỗi dòng một quyền lợi
                </label>
                <textarea
                  aria-label="Tính năng, mỗi dòng một quyền lợi"
                  rows={4}
                  value={form.featuresText}
                  onChange={(event) => updateForm("featuresText", event.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <label className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2 text-sm font-semibold text-blue-700">
                <input
                  type="checkbox"
                  checked={form.isPopular}
                  onChange={(event) => updateForm("isPopular", event.target.checked)}
                  className="h-4 w-4 rounded border-blue-300 text-blue-600"
                />
                Phổ biến
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) => updateForm("isActive", event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                />
                Active
              </label>
              <div className="mt-2 flex gap-3 md:col-span-2">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-400"
                >
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {saving ? "Đang lưu..." : "Lưu gói"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
};

export default PlansPage;
