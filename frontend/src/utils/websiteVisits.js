export function formatVisitChartDate(value, full = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return "—";
  return full ? `${match[3]}/${match[2]}/${match[1]}` : `${match[3]}/${match[2]}`;
}
