const CATEGORY_LABELS = {
  bug: "Lỗi",
  feature: "Tính năng",
  ui: "Giao diện",
  other: "Khác",
};

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_LABELS));

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
  VALID_CATEGORIES,
  buildFeedbackFilter,
  serializeFeedback,
  summarizeFeedback,
};
