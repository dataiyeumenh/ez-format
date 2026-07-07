import { AlertTriangle, CheckCircle, ShieldAlert } from "lucide-react";

const STATUS_STYLES = {
  ready: {
    icon: CheckCircle,
    title: "Sẵn sàng import MISA",
    wrapper: "border-emerald-200 bg-emerald-50 text-emerald-900",
    badge: "bg-emerald-600 text-white",
  },
  needs_review: {
    icon: AlertTriangle,
    title: "Cần rà soát trước khi tải",
    wrapper: "border-amber-200 bg-amber-50 text-amber-950",
    badge: "bg-amber-500 text-white",
  },
  blocked: {
    icon: ShieldAlert,
    title: "Còn lỗi cần sửa",
    wrapper: "border-red-200 bg-red-50 text-red-950",
    badge: "bg-red-600 text-white",
  },
};

const fallbackStyle = STATUS_STYLES.needs_review;

export default function ValidationReadinessCard({
  report,
  loading = false,
  acknowledgeWarnings = false,
  onAcknowledgeWarningsChange,
}) {
  if (!report && !loading) return null;

  const style = report ? STATUS_STYLES[report.status] || fallbackStyle : fallbackStyle;
  const Icon = style.icon;
  const summary = report?.summary || {};
  const hasWarnings = Number(summary.warning || 0) > 0;
  const hasBlockers = Number(summary.blocker || 0) > 0;

  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${style.wrapper}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <Icon size={24} className="mt-0.5 shrink-0" />
          <div>
            <h3 className="text-base font-black">
              {loading ? "Đang kiểm tra dữ liệu MISA…" : style.title}
            </h3>
            <p className="mt-1 text-sm opacity-80">
              {loading
                ? "Hệ thống đang kiểm tra cột bắt buộc, định dạng ngày/số và công thức tiền/thuế."
                : report?.disclaimer}
            </p>
          </div>
        </div>
        {report && (
          <span
            className={`inline-flex w-fit shrink-0 rounded-full px-3 py-1 text-sm font-bold ${style.badge}`}
          >
            {report.score}/100
          </span>
        )}
      </div>

      {report && (
        <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-xl bg-white/70 px-3 py-2">
            <div className="text-lg font-black">{summary.blocker || 0}</div>
            <div className="text-xs opacity-70">Lỗi cần sửa</div>
          </div>
          <div className="rounded-xl bg-white/70 px-3 py-2">
            <div className="text-lg font-black">{summary.warning || 0}</div>
            <div className="text-xs opacity-70">Cảnh báo</div>
          </div>
          <div className="rounded-xl bg-white/70 px-3 py-2">
            <div className="text-lg font-black">
              {report.reconciliation?.output_rows || 0}
            </div>
            <div className="text-xs opacity-70">Dòng đầu ra</div>
          </div>
        </div>
      )}

      {report && hasBlockers && (
        <p className="mt-3 text-sm font-semibold">
          Còn lỗi chắc chắn cần sửa nên chưa thể tải file MISA.
        </p>
      )}

      {report && hasWarnings && !hasBlockers && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-white/75 p-3 text-sm font-semibold">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            checked={acknowledgeWarnings}
            onChange={(event) => onAcknowledgeWarningsChange?.(event.target.checked)}
          />
          <span>
            Tôi đã kiểm tra các cảnh báo nghiệp vụ/kế toán và vẫn muốn tải file.
          </span>
        </label>
      )}
    </section>
  );
}
