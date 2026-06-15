const Feedback = require("../models/Feedback");
const {
  VALID_CATEGORIES,
  buildFeedbackFilter,
  serializeFeedback,
} = require("../services/feedbackService");

async function createFeedback(req, res) {
  try {
    const category = String(req.body.category || "").trim();
    const message = String(req.body.message || "").trim();

    if (!VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ success: false, message: "Loại góp ý không hợp lệ" });
    }
    if (!message) {
      return res.status(400).json({ success: false, message: "Nội dung góp ý là bắt buộc" });
    }
    if (message.length > 2000) {
      return res
        .status(400)
        .json({ success: false, message: "Nội dung góp ý không được quá 2000 ký tự" });
    }

    const feedback = await Feedback.create({
      user: req.user._id,
      userNameSnapshot: req.user.name || "",
      userEmailSnapshot: req.user.email || "",
      category,
      message,
    });

    res.status(201).json({ success: true, feedback: serializeFeedback(feedback) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
}

async function getAdminFeedback(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = buildFeedbackFilter(req.query);
    const statsFilter = buildFeedbackFilter({
      from: req.query.from,
      to: req.query.to,
    });

    const [total, items, totalAll, bug, feature, ui, other] = await Promise.all([
      Feedback.countDocuments(filter),
      Feedback.find(filter)
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Feedback.countDocuments(statsFilter),
      Feedback.countDocuments({ ...statsFilter, category: "bug" }),
      Feedback.countDocuments({ ...statsFilter, category: "feature" }),
      Feedback.countDocuments({ ...statsFilter, category: "ui" }),
      Feedback.countDocuments({ ...statsFilter, category: "other" }),
    ]);

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      stats: { total: totalAll, bug, feature, ui, other },
      feedback: items.map(serializeFeedback),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
}

module.exports = {
  createFeedback,
  getAdminFeedback,
};
