export const FILE_HISTORY_COLUMNS = [
  "NGƯỜI DÙNG",
  "TÊN FILE",
  "ĐỊNH DẠNG",
  "KÍCH THƯỚC",
  "TRẠNG THÁI",
  "NGÀY",
];

export function formatFileHistoryDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}
