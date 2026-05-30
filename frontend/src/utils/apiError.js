export function getApiErrorMessage(err, fallback = "Đã xảy ra lỗi") {
  const data = err?.response?.data;
  if (!data) {
    return err?.message?.includes("Network Error")
      ? "Không kết nối được máy chủ. Kiểm tra backend đang chạy."
      : err?.message || fallback;
  }
  if (typeof data.message === "string") return data.message;
  if (Array.isArray(data.errors) && data.errors[0]?.msg) {
    return data.errors[0].msg;
  }
  if (Array.isArray(data.errors) && data.errors[0]?.message) {
    return data.errors[0].message;
  }
  return fallback;
}
