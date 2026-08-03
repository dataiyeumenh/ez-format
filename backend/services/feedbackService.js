const CATEGORY_LABELS = {
  bug: "Lỗi",
  feature: "Tính năng",
  ui: "Giao diện",
  other: "Khác",
};

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_LABELS));

const STATUS_LABELS = {
  new: "Mới",
  received: "Đã tiếp nhận",
  in_progress: "Đang xử lý",
  resolved: "Đã giải quyết",
  rejected: "Không thực hiện",
};

const VALID_STATUSES = new Set(Object.keys(STATUS_LABELS));

const RATING_LABELS = {
  satisfied: "Hài lòng",
  very_satisfied: "Vô cùng hài lòng",
  dissatisfied: "Chưa hài lòng",
};

const VALID_RATINGS = new Set(Object.keys(RATING_LABELS));

function startOfDay(value) {
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00.000Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function endOfDay(value) {
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T23:59:59.999Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function buildFeedbackFilter(query = {}) {
  const filter = {};
  if (query.category && VALID_CATEGORIES.has(String(query.category))) {
    filter.category = String(query.category);
  }
  if (query.status && VALID_STATUSES.has(String(query.status))) {
    const status = String(query.status);
    if (status === "new") {
      filter.$or = [
        { status: "new" },
        { status: { $exists: false } },
        { status: null },
      ];
    } else {
      filter.status = status;
    }
  }

  const from = query.from ? startOfDay(query.from) : null;
  const to = query.to ? endOfDay(query.to) : null;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  return filter;
}

function serializeFeedback(item) {
  const user = item.user || {};
  const name = item.userNameSnapshot || user.name || "Không rõ";
  const email = item.userEmailSnapshot || user.email || "";
  const status = VALID_STATUSES.has(item.status) ? item.status : "new";
  const rating = VALID_RATINGS.has(item.rating) ? item.rating : null;

  return {
    id: String(item._id),
    user: {
      id: user._id ? String(user._id) : String(item.user || ""),
      name,
      email,
    },
    category: item.category,
    categoryLabel: CATEGORY_LABELS[item.category] || item.category,
    message: item.message || "",
    status,
    statusLabel: STATUS_LABELS[status],
    statusUpdatedAt: item.statusUpdatedAt || null,
    rating,
    ratingLabel: rating ? RATING_LABELS[rating] : null,
    ratedAt: rating ? item.ratedAt || null : null,
    createdAt: item.createdAt || null,
  };
}

function summarizeFeedback(items) {
  return items.reduce(
    (stats, item) => {
      stats.total += 1;
      if (stats[item.category] !== undefined) stats[item.category] += 1;
      return stats;
    },
    { total: 0, bug: 0, feature: 0, ui: 0, other: 0 },
  );
}

module.exports = {
  CATEGORY_LABELS,
  RATING_LABELS,
  STATUS_LABELS,
  VALID_CATEGORIES,
  VALID_RATINGS,
  VALID_STATUSES,
  buildFeedbackFilter,
  serializeFeedback,
  summarizeFeedback,
};
