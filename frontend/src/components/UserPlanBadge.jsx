const planLabels = {
  Free: "Gói miễn phí",
  Monthly: "Gói tháng",
  Yearly: "Gói năm",
  PerFile: "Theo lượt",
};

function formatExpiry(dateValue) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

const UserPlanBadge = ({ user, compact = false }) => {
  if (!user) return null;

  const plan = typeof user.plan === "object" && user.plan ? user.plan : null;
  const planCode = plan?.code || user.planCode || user.plan;
  const legacyPlan = planCode
    ? String(planCode).charAt(0).toUpperCase() + String(planCode).slice(1)
    : "Free";
  const normalizedLegacyPlan =
    legacyPlan === "Perfile" ? "PerFile" : legacyPlan;
  const planLabel =
    plan?.name || planLabels[normalizedLegacyPlan] || user.plan || "Gói miễn phí";
  const credits = Number(user.fileCredits || 0);
  const isFreeOrPerfile =
    planCode === "free" ||
    planCode === "perfile" ||
    normalizedLegacyPlan === "Free" ||
    normalizedLegacyPlan === "PerFile";
  const dailyCredit = Math.max(0, Number(user.dailyFileCredit || 0));
  const expiry = formatExpiry(user.planExpiresAt);
  const isTimePlan =
    planCode === "monthly" ||
    planCode === "yearly" ||
    normalizedLegacyPlan === "Monthly" ||
    normalizedLegacyPlan === "Yearly";
  const detailText =
    planCode === "perfile" || normalizedLegacyPlan === "PerFile"
      ? `${credits} lượt chuyển đổi`
      : isTimePlan && expiry
        ? `Hết hạn vào ${expiry}`
        : "";

  return (
    <div className="space-y-2">
      <div
        className={`rounded-2xl border border-blue-100 bg-blue-50/80 text-blue-900 ${
          compact ? "px-3 py-2" : "px-4 py-3"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-bold uppercase tracking-wide text-blue-600">
            {planLabel}
          </span>
          {detailText && (
            <span className="text-xs font-semibold text-blue-800">{detailText}</span>
          )}
        </div>
      </div>

      {isFreeOrPerfile && (
        <div
          className={`rounded-2xl border ${
            dailyCredit > 0
              ? "border-emerald-100 bg-emerald-50/80 text-emerald-900"
              : "border-gray-200 bg-gray-50 text-gray-500"
          } ${compact ? "px-3 py-2" : "px-4 py-3"}`}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className={`text-xs font-bold uppercase tracking-wide ${
                dailyCredit > 0 ? "text-emerald-600" : "text-gray-400"
              }`}
            >
              Lượt miễn phí hôm nay
            </span>
            <span
              className={`text-xs font-semibold ${
                dailyCredit > 0 ? "text-emerald-800" : "text-gray-500"
              }`}
            >
              {dailyCredit}/1
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserPlanBadge;
