export const USER_GROWTH_RANGES = [
  { value: "30d", label: "30 ngày" },
  { value: "90d", label: "90 ngày" },
  { value: "all", label: "Toàn bộ" },
];

export function formatUserGrowthDate(value, granularity, full = false) {
  if (granularity === "month") {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value));
    return match ? `${match[2]}/${match[1]}` : "—";
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return "—";
  return full ? `${match[3]}/${match[2]}/${match[1]}` : `${match[3]}/${match[2]}`;
}
