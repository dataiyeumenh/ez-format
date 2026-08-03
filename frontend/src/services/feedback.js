import api from "./api";

// Loại góp ý — value khớp enum backend, label hiển thị tiếng Việt.
export const FEEDBACK_CATEGORIES = [
  { value: "bug", label: "Lỗi" },
  { value: "feature", label: "Tính năng" },
  { value: "ui", label: "Giao diện" },
  { value: "other", label: "Khác" },
];

export async function submitFeedback({ category, message }) {
  const { data } = await api.post("/feedback", { category, message });
  return data;
}

export async function fetchMyFeedback({ page = 1, limit = 20 } = {}) {
  const { data } = await api.get("/feedback/mine", {
    params: { page, limit },
  });
  return data;
}

export async function rateFeedback(id, rating) {
  const { data } = await api.patch(`/feedback/${id}/rating`, { rating });
  return data;
}

export async function fetchAdminFeedback({
  page = 1,
  limit = 10,
  category,
  status,
} = {}) {
  const { data } = await api.get("/admin/feedback", {
    params: {
      page,
      limit,
      category: category || undefined,
      status: status || undefined,
    },
  });
  return data;
}

export async function updateAdminFeedbackStatus(id, status) {
  const { data } = await api.patch(`/admin/feedback/${id}/status`, { status });
  return data;
}
