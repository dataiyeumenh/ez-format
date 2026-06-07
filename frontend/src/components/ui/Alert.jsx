import { AlertCircle, CheckCircle, Info, AlertTriangle } from "lucide-react";

const STYLES = {
  error: {
    wrap: "bg-red-50 border-red-100 text-red-800",
    icon: AlertCircle,
    iconClass: "text-red-500",
  },
  warning: {
    wrap: "bg-amber-50 border-amber-100 text-amber-900",
    icon: AlertTriangle,
    iconClass: "text-amber-500",
  },
  success: {
    wrap: "bg-emerald-50 border-emerald-100 text-emerald-900",
    icon: CheckCircle,
    iconClass: "text-emerald-500",
  },
  info: {
    wrap: "bg-blue-50 border-blue-100 text-blue-900",
    icon: Info,
    iconClass: "text-blue-500",
  },
};

export default function Alert({ variant = "info", title, children, className = "" }) {
  const style = STYLES[variant] || STYLES.info;
  const Icon = style.icon;

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${style.wrap} ${className}`}
    >
      <Icon size={18} className={`mt-0.5 flex-shrink-0 ${style.iconClass}`} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold mb-0.5">{title}</p>}
        <div className="leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
