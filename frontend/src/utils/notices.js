export function normalizeNoticeForm(form = {}) {
  const title = String(form.title || "").trim();
  const description = String(form.description || "").trim();

  if (!title) throw new Error("Tiêu đề thông báo là bắt buộc.");
  if (title.length > 120) throw new Error("Tiêu đề không được quá 120 ký tự.");
  if (!description) throw new Error("Nội dung thông báo là bắt buộc.");
  if (description.length > 1000) {
    throw new Error("Nội dung không được quá 1000 ký tự.");
  }

  return { title, description };
}

export function formatNoticeDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}

export function formatUnreadCount(value) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  return count > 99 ? "99+" : String(count);
}

export function getNoticeListParams(scope) {
  return {
    limit: 50,
    scope: scope === "individual" ? "individual" : "broadcast",
  };
}
