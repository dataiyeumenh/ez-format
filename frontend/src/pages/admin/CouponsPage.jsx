import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CalendarClock,
  Loader2,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  TicketPercent,
  X,
} from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import api from "../../services/api";
import {
  COUPON_STATUS_OPTIONS,
  couponToForm,
  formToCouponPayload,
  getCouponStatusMeta,
} from "../../utils/coupons";

function createEmptyForm() {
  const start = new Date();
  start.setSeconds(0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  end.setHours(23, 59, 0, 0);
  return couponToForm({
    discountPercent: 10,
    usageLimit: 100,
    limitPerUser: 1,
    startDate: start,
    endDate: end,
    status: "active",
  });
}

function formatVnd(amount) {
  if (amount === null || amount === undefined) return "Không giới hạn";
  return `${new Intl.NumberFormat("vi-VN").format(Number(amount))} đ`;
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

function StatusBadge({ status }) {
  const meta = getCouponStatusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${meta.className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
}

function Field({ label, required = false, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-slate-700">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

function CouponDialog({ coupon, plans, open, saving, apiError, onClose, onSave }) {
  const [form, setForm] = useState(createEmptyForm);
  const isEditing = Boolean(coupon);

  useEffect(() => {
    if (open) setForm(coupon ? couponToForm(coupon) : createEmptyForm());
  }, [coupon, open]);

  const update = (field, value) =>
    setForm((current) => ({ ...current, [field]: value }));
  const togglePlan = (planId) => {
    setForm((current) => ({
      ...current,
      applicablePlans: current.applicablePlans.includes(planId)
        ? current.applicablePlans.filter((id) => id !== planId)
        : [...current.applicablePlans, planId],
    }));
  };

  const submit = (event) => {
    event.preventDefault();
    onSave(formToCouponPayload(form));
  };

  const inputClass =
    "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10";

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white shadow-2xl outline-none">
          <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-100 bg-white/95 px-6 py-5 backdrop-blur">
            <div>
              <Dialog.Title className="text-xl font-bold text-slate-950">
                {isEditing ? "Chỉnh sửa coupon" : "Thêm chương trình mới"}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-500">
                Thiết lập mức giảm, gói áp dụng và giới hạn sử dụng.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Đóng"
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={submit} className="space-y-6 px-6 py-5">
            {apiError && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
              >
                {apiError}
              </div>
            )}

            <section className="grid gap-4 md:grid-cols-2">
              <Field
                label="Mã coupon"
                required
                hint="Chữ in hoa, số, dấu gạch ngang hoặc gạch dưới."
              >
                <input
                  required
                  maxLength={40}
                  value={form.code}
                  onChange={(event) => update("code", event.target.value.toUpperCase())}
                  placeholder="VD: CHAOMUNG10"
                  className={`${inputClass} font-mono font-semibold uppercase`}
                />
              </Field>
              <Field label="Trạng thái" required>
                <select
                  value={form.status}
                  onChange={(event) => update("status", event.target.value)}
                  className={inputClass}
                >
                  <option value="active">Hoạt động</option>
                  <option value="inactive">Tạm ngưng</option>
                </select>
              </Field>
              <div className="md:col-span-2">
                <Field label="Mô tả">
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={form.description}
                    onChange={(event) => update("description", event.target.value)}
                    placeholder="Mục đích và đối tượng áp dụng chương trình"
                    className={`${inputClass} resize-none`}
                  />
                </Field>
              </div>
            </section>

            <section className="rounded-2xl border border-blue-100 bg-blue-50/45 p-4">
              <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800">
                <TicketPercent size={17} className="text-blue-600" />
                Giá trị ưu đãi
              </h3>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Phần trăm giảm" required>
                  <div className="relative">
                    <input
                      type="number"
                      required
                      min="1"
                      max="100"
                      step="1"
                      value={form.discountPercent}
                      onChange={(event) =>
                        update("discountPercent", event.target.value)
                      }
                      className={`${inputClass} pr-10`}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
                      %
                    </span>
                  </div>
                </Field>
                <Field label="Số tiền giảm tối đa" hint="Để trống nếu không giới hạn.">
                  <div className="relative">
                    <input
                      type="number"
                      min="1"
                      step="1000"
                      value={form.maxDiscountAmount}
                      onChange={(event) =>
                        update("maxDiscountAmount", event.target.value)
                      }
                      placeholder="Không giới hạn"
                      className={`${inputClass} pr-10`}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
                      đ
                    </span>
                  </div>
                </Field>
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-sm font-bold text-slate-800">
                Gói dịch vụ áp dụng <span className="text-rose-500">*</span>
              </h3>
              {plans.length === 0 ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  Chưa có gói trả phí đang hoạt động. Hãy cấu hình tại màn hình Gói dịch
                  vụ.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {plans.map((plan) => {
                    const selected = form.applicablePlans.includes(plan.id);
                    return (
                      <label
                        key={plan.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition ${
                          selected
                            ? "border-blue-400 bg-blue-50 text-blue-800"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => togglePlan(plan.id)}
                          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">
                            {plan.name}
                          </span>
                          <span className="block truncate text-xs opacity-65">
                            {plan.code}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <Field label="Tổng lượt sử dụng" required>
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={form.usageLimit}
                  onChange={(event) => update("usageLimit", event.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Giới hạn mỗi người dùng" required>
                <input
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={form.limitPerUser}
                  onChange={(event) => update("limitPerUser", event.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Bắt đầu" required>
                <input
                  type="datetime-local"
                  required
                  value={form.startDate}
                  onChange={(event) => update("startDate", event.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Kết thúc" required>
                <input
                  type="datetime-local"
                  required
                  min={form.startDate}
                  value={form.endDate}
                  onChange={(event) => update("endDate", event.target.value)}
                  className={inputClass}
                />
              </Field>
            </section>

            <div className="sticky bottom-0 -mx-6 -mb-5 flex justify-end gap-3 border-t border-slate-100 bg-white/95 px-6 py-4 backdrop-blur">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={saving}
                  className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  Hủy
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={
                  saving || plans.length === 0 || form.applicablePlans.length === 0
                }
                className="inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                {saving ? "Đang lưu..." : isEditing ? "Lưu thay đổi" : "Tạo coupon"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function CouponsPage() {
  const [coupons, setCoupons] = useState([]);
  const [plans, setPlans] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const [pageError, setPageError] = useState("");
  const [modalError, setModalError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState(null);

  const loadData = useCallback(
    async ({ silent = false } = {}) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setPageError("");
      try {
        const [couponResponse, planResponse] = await Promise.all([
          api.get("/admin/coupons", {
            params: statusFilter ? { status: statusFilter } : {},
          }),
          api.get("/admin/plans"),
        ]);
        setCoupons(couponResponse.data.coupons || []);
        setPlans(
          (planResponse.data.plans || []).filter(
            (plan) => plan.isActive !== false && plan.code !== "free",
          ),
        );
      } catch (error) {
        setPageError(error.response?.data?.message || "Không thể tải dữ liệu coupon.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  const visibleCoupons = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return coupons;
    return coupons.filter(
      (coupon) =>
        coupon.code.toLowerCase().includes(query) ||
        coupon.description.toLowerCase().includes(query),
    );
  }, [coupons, searchQuery]);

  const openCreate = () => {
    setEditingCoupon(null);
    setModalError("");
    setDialogOpen(true);
  };

  const openEdit = (coupon) => {
    setEditingCoupon(coupon);
    setModalError("");
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saving) return;
    setDialogOpen(false);
    setEditingCoupon(null);
    setModalError("");
  };

  const saveCoupon = async (payload) => {
    setSaving(true);
    setModalError("");
    try {
      if (editingCoupon) await api.put(`/admin/coupons/${editingCoupon.id}`, payload);
      else await api.post("/admin/coupons", payload);
      setNotice(editingCoupon ? "Đã cập nhật coupon." : "Đã tạo coupon mới.");
      setDialogOpen(false);
      setEditingCoupon(null);
      await loadData({ silent: true });
    } catch (error) {
      setModalError(error.response?.data?.message || "Không thể lưu coupon.");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (coupon) => {
    const nextStatus = coupon.status === "inactive" ? "active" : "inactive";
    setTogglingId(coupon.id);
    setPageError("");
    setNotice("");
    try {
      await api.patch(`/admin/coupons/${coupon.id}/status`, { status: nextStatus });
      setNotice(
        nextStatus === "active" ? "Đã kích hoạt coupon." : "Đã tạm ngưng coupon.",
      );
      await loadData({ silent: true });
    } catch (error) {
      setPageError(error.response?.data?.message || "Không thể đổi trạng thái coupon.");
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <AdminLayout>
      <main className="min-h-full bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
                <TicketPercent size={15} /> Quản lý ưu đãi
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
                Chương trình đặc biệt
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
                Tạo coupon, kiểm soát thời gian áp dụng và giới hạn sử dụng theo từng
                gói.
              </p>
            </div>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              <Plus size={18} /> Thêm chương trình
            </button>
          </div>

          <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-1 flex-col gap-3 sm:flex-row">
                <div className="relative max-w-md flex-1">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    size={17}
                  />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Tìm theo mã hoặc mô tả..."
                    aria-label="Tìm coupon"
                    className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                  />
                </div>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  aria-label="Lọc trạng thái coupon"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                >
                  {COUPON_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-3 lg:justify-end">
                <span className="text-sm text-slate-500">
                  <strong className="text-slate-800">{visibleCoupons.length}</strong>{" "}
                  coupon
                </span>
                <button
                  type="button"
                  onClick={() => loadData({ silent: true })}
                  disabled={refreshing}
                  aria-label="Làm mới danh sách"
                  className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-50"
                >
                  <RefreshCw size={17} className={refreshing ? "animate-spin" : ""} />
                </button>
              </div>
            </div>

            {(pageError || notice) && (
              <div
                role={pageError ? "alert" : "status"}
                className={`mx-4 mt-4 rounded-xl border px-4 py-3 text-sm ${
                  pageError
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                {pageError || notice}
              </div>
            )}

            {loading ? (
              <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-500">
                <Loader2 size={20} className="animate-spin text-blue-600" /> Đang tải
                coupon...
              </div>
            ) : visibleCoupons.length === 0 ? (
              <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                  <TicketPercent size={26} />
                </div>
                <h2 className="mt-4 text-base font-bold text-slate-900">
                  Không tìm thấy coupon
                </h2>
                <p className="mt-1 max-w-sm text-sm text-slate-500">
                  Thay đổi bộ lọc hoặc tạo chương trình đặc biệt đầu tiên.
                </p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-slate-100 md:hidden">
                  {visibleCoupons.map((coupon) => {
                    const usedPercent = coupon.usageLimit
                      ? Math.min(100, (coupon.usageCount / coupon.usageLimit) * 100)
                      : 0;
                    const paused = coupon.status === "inactive";
                    const toggling = togglingId === coupon.id;
                    return (
                      <article key={coupon.id} className="space-y-4 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="font-mono text-sm font-bold text-blue-700">
                              {coupon.code}
                            </h2>
                            <p className="mt-1 truncate text-xs text-slate-500">
                              {coupon.description || "Không có mô tả"}
                            </p>
                          </div>
                          <StatusBadge status={coupon.effectiveStatus} />
                        </div>

                        <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-xs">
                          <div>
                            <span className="block text-slate-400">Ưu đãi</span>
                            <strong className="mt-1 block text-sm text-slate-900">
                              Giảm {coupon.discountPercent}%
                            </strong>
                            <span className="mt-0.5 block text-slate-500">
                              Tối đa {formatVnd(coupon.maxDiscountAmount)}
                            </span>
                          </div>
                          <div>
                            <span className="block text-slate-400">Lượt sử dụng</span>
                            <strong className="mt-1 block text-sm text-slate-900">
                              {coupon.usageCount}/{coupon.usageLimit}
                            </strong>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
                              <div
                                className="h-full rounded-full bg-blue-500"
                                style={{ width: `${usedPercent}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          {coupon.applicablePlans.map((plan) => (
                            <span
                              key={plan.id}
                              className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600"
                            >
                              {plan.name || plan.code || "Gói đã ẩn"}
                            </span>
                          ))}
                        </div>

                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <CalendarClock size={14} className="shrink-0" />
                          <span>
                            {formatDateTime(coupon.startDate)} –{" "}
                            {formatDateTime(coupon.endDate)}
                          </span>
                        </div>

                        <div className="flex gap-2 border-t border-slate-100 pt-3">
                          <button
                            type="button"
                            onClick={() => openEdit(coupon)}
                            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <Pencil size={15} /> Chỉnh sửa
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleStatus(coupon)}
                            disabled={toggling}
                            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 disabled:opacity-50 ${
                              paused
                                ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus:ring-emerald-500"
                                : "bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500"
                            }`}
                          >
                            {toggling ? (
                              <Loader2 size={15} className="animate-spin" />
                            ) : paused ? (
                              <PlayCircle size={15} />
                            ) : (
                              <PauseCircle size={15} />
                            )}
                            {paused ? "Kích hoạt" : "Tạm ngưng"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>

                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[1080px] text-left">
                    <thead className="bg-slate-50/80 text-xs font-bold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-5 py-3.5">Mã giảm giá</th>
                        <th className="px-5 py-3.5">Ưu đãi</th>
                        <th className="px-5 py-3.5">Gói áp dụng</th>
                        <th className="px-5 py-3.5">Lượt dùng</th>
                        <th className="px-5 py-3.5">Thời gian</th>
                        <th className="px-5 py-3.5">Trạng thái</th>
                        <th className="px-5 py-3.5 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleCoupons.map((coupon) => {
                        const usedPercent = coupon.usageLimit
                          ? Math.min(100, (coupon.usageCount / coupon.usageLimit) * 100)
                          : 0;
                        const paused = coupon.status === "inactive";
                        const toggling = togglingId === coupon.id;
                        return (
                          <tr
                            key={coupon.id}
                            className="align-top transition hover:bg-slate-50/70"
                          >
                            <td className="px-5 py-4">
                              <div className="font-mono text-sm font-bold text-blue-700">
                                {coupon.code}
                              </div>
                              <div
                                className="mt-1 max-w-56 truncate text-xs text-slate-500"
                                title={coupon.description}
                              >
                                {coupon.description || "Không có mô tả"}
                              </div>
                            </td>
                            <td className="px-5 py-4">
                              <div className="text-sm font-bold text-slate-900">
                                Giảm {coupon.discountPercent}%
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                Tối đa {formatVnd(coupon.maxDiscountAmount)}
                              </div>
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex max-w-60 flex-wrap gap-1.5">
                                {coupon.applicablePlans.map((plan) => (
                                  <span
                                    key={plan.id}
                                    className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600"
                                  >
                                    {plan.name || plan.code || "Gói đã ẩn"}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="font-semibold text-slate-700">
                                  {coupon.usageCount}/{coupon.usageLimit}
                                </span>
                                <span className="text-slate-400">
                                  {coupon.limitPerUser}/user
                                </span>
                              </div>
                              <div className="mt-2 h-1.5 w-32 overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-blue-500"
                                  style={{ width: `${usedPercent}%` }}
                                />
                              </div>
                            </td>
                            <td className="px-5 py-4 text-xs text-slate-500">
                              <div className="flex items-center gap-1.5">
                                <CalendarClock size={13} />
                                {formatDateTime(coupon.startDate)}
                              </div>
                              <div className="mt-1 pl-[19px]">
                                đến {formatDateTime(coupon.endDate)}
                              </div>
                            </td>
                            <td className="px-5 py-4">
                              <StatusBadge status={coupon.effectiveStatus} />
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => openEdit(coupon)}
                                  title="Chỉnh sửa"
                                  aria-label={`Chỉnh sửa ${coupon.code}`}
                                  className="rounded-lg bg-blue-50 p-2 text-blue-700 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                  <Pencil size={16} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => toggleStatus(coupon)}
                                  disabled={toggling}
                                  title={paused ? "Kích hoạt" : "Tạm ngưng"}
                                  aria-label={`${paused ? "Kích hoạt" : "Tạm ngưng"} ${coupon.code}`}
                                  className={`rounded-lg p-2 focus:outline-none focus:ring-2 disabled:opacity-50 ${
                                    paused
                                      ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus:ring-emerald-500"
                                      : "bg-rose-50 text-rose-700 hover:bg-rose-100 focus:ring-rose-500"
                                  }`}
                                >
                                  {toggling ? (
                                    <Loader2 size={16} className="animate-spin" />
                                  ) : paused ? (
                                    <PlayCircle size={16} />
                                  ) : (
                                    <PauseCircle size={16} />
                                  )}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      <CouponDialog
        coupon={editingCoupon}
        plans={plans}
        open={dialogOpen}
        saving={saving}
        apiError={modalError}
        onClose={closeDialog}
        onSave={saveCoupon}
      />
    </AdminLayout>
  );
}
