export const FEEDBACK_STATUSES = [
  { value: "new", label: "Mới", className: "bg-slate-100 text-slate-700" },
  { value: "received", label: "Đã tiếp nhận", className: "bg-blue-100 text-blue-700" },
  {
    value: "in_progress",
    label: "Đang xử lý",
    className: "bg-amber-100 text-amber-700",
  },
  {
    value: "resolved",
    label: "Đã giải quyết",
    className: "bg-emerald-100 text-emerald-700",
  },
  { value: "rejected", label: "Không thực hiện", className: "bg-rose-100 text-rose-700" },
];

export const FEEDBACK_RATINGS = [
  {
    value: "satisfied",
    label: "Hài lòng",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  {
    value: "very_satisfied",
    label: "Vô cùng hài lòng",
    className: "border-blue-200 bg-blue-50 text-blue-700",
  },
  {
    value: "dissatisfied",
    label: "Chưa hài lòng",
    className: "border-rose-200 bg-rose-50 text-rose-700",
  },
];

export function getFeedbackStatusMeta(value) {
  return (
    FEEDBACK_STATUSES.find((status) => status.value === value) || FEEDBACK_STATUSES[0]
  );
}

export function getFeedbackRatingMeta(value) {
  return FEEDBACK_RATINGS.find((rating) => rating.value === value) || null;
}

export function formatFeedbackDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}
