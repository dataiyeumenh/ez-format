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
  return date.toLocaleDateString("vi-VN");
}

const UserPlanBadge = ({ user, compact = false }) => {
  if (!user) return null;

  const planLabel = planLabels[user.plan] || user.plan || "Gói miễn phí";
  const credits = Number(user.fileCredits || 0);
  const expiry = formatExpiry(user.planExpiresAt);

  return (
    <div
      className={`rounded-2xl border border-blue-100 bg-blue-50/80 text-blue-900 ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-bold uppercase tracking-wide text-blue-600">
          {planLabel}
        </span>
        <span className="text-xs font-semibold text-blue-800">
          {credits} lượt chuyển đổi
        </span>
      </div>
      {!compact && expiry && (
        <p className="mt-1 text-xs text-blue-700">Hạn gói: {expiry}</p>
      )}
    </div>
  );
};

export default UserPlanBadge;
