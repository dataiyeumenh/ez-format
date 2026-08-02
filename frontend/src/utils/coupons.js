export const COUPON_STATUS_OPTIONS = [
  { value: "", label: "Tất cả trạng thái" },
  { value: "active", label: "Đang hoạt động" },
  { value: "scheduled", label: "Sắp diễn ra" },
  { value: "inactive", label: "Tạm ngưng" },
  { value: "expired", label: "Hết hạn" },
  { value: "exhausted", label: "Hết lượt" },
];

const STATUS_META = {
  active: {
    label: "Đang hoạt động",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  },
  scheduled: {
    label: "Sắp diễn ra",
    className: "bg-sky-50 text-sky-700 ring-sky-600/20",
  },
  inactive: {
    label: "Tạm ngưng",
    className: "bg-slate-100 text-slate-600 ring-slate-500/20",
  },
  expired: {
    label: "Hết hạn",
    className: "bg-amber-50 text-amber-700 ring-amber-600/20",
  },
  exhausted: {
    label: "Hết lượt",
    className: "bg-rose-50 text-rose-700 ring-rose-600/20",
  },
};

export function getCouponStatusMeta(status) {
  return STATUS_META[status] || STATUS_META.inactive;
}

export function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function couponToForm(coupon) {
  return {
    code: coupon?.code || "",
    description: coupon?.description || "",
    discountPercent: coupon?.discountPercent ?? 10,
    maxDiscountAmount: coupon?.maxDiscountAmount ?? "",
    applicablePlans: (coupon?.applicablePlans || []).map((plan) => plan.id),
    usageLimit: coupon?.usageLimit ?? 100,
    limitPerUser: coupon?.limitPerUser ?? 1,
    startDate: toDateTimeLocal(coupon?.startDate),
    endDate: toDateTimeLocal(coupon?.endDate),
    status: coupon?.status || "active",
  };
}

export function formToCouponPayload(form) {
  return {
    code: String(form.code || "")
      .trim()
      .toUpperCase(),
    description: String(form.description || "").trim(),
    discountPercent: Number(form.discountPercent),
    maxDiscountAmount:
      form.maxDiscountAmount === "" ? null : Number(form.maxDiscountAmount),
    applicablePlans: form.applicablePlans,
    usageLimit: Number(form.usageLimit),
    limitPerUser: Number(form.limitPerUser),
    startDate: new Date(form.startDate).toISOString(),
    endDate: new Date(form.endDate).toISOString(),
    status: form.status,
  };
}
