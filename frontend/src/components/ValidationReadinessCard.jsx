import { AlertTriangle, CheckCircle, ShieldAlert } from "lucide-react";

const STATE_STYLE = {
  ready: {
    label: "Sẵn sàng",
    icon: CheckCircle,
    className: "border-emerald-200 bg-emerald-50 text-emerald-900",
    badge: "bg-emerald-600 text-white",
  },
  needs_review: {
    label: "Cần kiểm tra cảnh báo",
    icon: AlertTriangle,
    className: "border-amber-200 bg-amber-50 text-amber-950",
    badge: "bg-amber-500 text-white",
  },
  blocked: {
    label: "Đang bị chặn",
    icon: ShieldAlert,
    className: "border-red-200 bg-red-50 text-red-950",
    badge: "bg-red-600 text-white",
  },
  fatal: {
    label: "Không thể xử lý",
    icon: ShieldAlert,
    className: "border-red-200 bg-red-50 text-red-950",
    badge: "bg-red-600 text-white",
  },
};

export default function ValidationReadinessCard({
  report,
  acknowledgeWarnings,
  onAcknowledgeWarnings,
}) {
  if (!report) return null;
  const state = STATE_STYLE[report.status] || STATE_STYLE.blocked;
  const Icon = state.icon;
  const summary = report.summary || {};
  const hasBlocking = (summary.fatal || 0) + (summary.blocker || 0) > 0;
  const hasWarnings = (summary.warning || 0) > 0;

  return (
    <section className={`rounded-2xl border p-4 ${state.className}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-white/70 p-2">
            <Icon size={20} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-black">{state.label}</h3>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${state.badge}`}>
                {report.score}/100
              </span>
            </div>
            <p className="mt-1 text-sm opacity-85">
              {hasBlocking
                ? "Còn lỗi nặng cần sửa trước khi tải file MISA."
                : hasWarnings
                  ? "Không có lỗi chặn, nhưng cần xác nhận đã kiểm tra cảnh báo."
                  : "Không phát hiện lỗi chặn theo rule đã cấu hình."}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          {[
            ["Fatal", summary.fatal || 0],
            ["Lỗi nặng", summary.blocker || 0],
            ["Cảnh báo", summary.warning || 0],
            ["Info", summary.info || 0],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-white/70 px-3 py-2">
              <div className="text-lg font-black">{value}</div>
              <div className="whitespace-nowrap opacity-75">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {hasWarnings && !hasBlocking && (
        <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-xl bg-white/70 p-3 text-sm font-semibold">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            checked={acknowledgeWarnings}
            onChange={(event) => onAcknowledgeWarnings?.(event.target.checked)}
          />
          <span>Tôi đã kiểm tra các cảnh báo và muốn tiếp tục tải file.</span>
        </label>
      )}

      {report.legal_disclaimer && (
        <p className="mt-3 text-xs leading-relaxed opacity-70">{report.legal_disclaimer}</p>
      )}
    </section>
  );
}

