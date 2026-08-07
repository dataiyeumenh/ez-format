const Feedback = require("../models/Feedback");
const Notice = require("../models/Notice");
const {
  STATUS_LABELS,
  VALID_CATEGORIES,
  VALID_RATINGS,
  VALID_STATUSES,
  buildFeedbackFilter,
  serializeFeedback,
} = require("../services/feedbackService");

function buildStatusNotice(feedback, status) {
  const normalizedMessage = String(feedback.message || "")
    .replace(/\s+/g, " ")
    .trim();
  const excerpt =
    normalizedMessage.length > 80
      ? `${normalizedMessage.slice(0, 77)}...`
      : normalizedMessage;

  if (status === "resolved") {
    return {
      title: "Góp ý của bạn đã được giải quyết",
      description: `Góp ý “${excerpt}” đã được giải quyết. Hãy mở mục Góp ý, chọn “Góp ý của tôi” để đánh giá mức độ hài lòng.`,
    };
  }

  return {
    title: "Trạng thái góp ý đã được cập nhật",
    description: `Góp ý “${excerpt}” đã chuyển sang trạng thái “${STATUS_LABELS[status]}”.`,
  };
}

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

async function getMyFeedback(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const filter = { user: req.user._id };

    const [total, items] = await Promise.all([
      Feedback.countDocuments(filter),
      Feedback.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ]);

    return res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      feedback: items.map(serializeFeedback),
    });
  } catch (_error) {
    return res.status(500).json({
      success: false,
      message: "Không thể tải lịch sử góp ý",
    });
  }
}

async function updateFeedbackStatus(req, res) {
  const status = String(req.body.status || "").trim();
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({
      success: false,
      message: "Trạng thái góp ý không hợp lệ",
    });
  }

  try {
    let feedback = await Feedback.findOneAndUpdate(
      { _id: req.params.id, status: { $ne: status } },
      {
        status,
        statusUpdatedAt: new Date(),
        statusUpdatedBy: req.user._id,
      },
      { new: true, runValidators: true },
    ).populate("user", "name email");

    if (!feedback) {
      feedback = await Feedback.findById(req.params.id).populate(
        "user",
        "name email",
      );
      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy góp ý",
        });
      }
    } else {
      const recipient = feedback.user?._id || feedback.user;
      await Notice.create({
        ...buildStatusNotice(feedback, status),
        recipient,
      });
    }

    return res.json({
      success: true,
      feedback: serializeFeedback(feedback),
    });
  } catch (error) {
    if (error?.name === "CastError") {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy góp ý",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật trạng thái góp ý",
    });
  }
}

async function rateFeedback(req, res) {
  const rating = String(req.body.rating || "").trim();
  if (!VALID_RATINGS.has(rating)) {
    return res.status(400).json({
      success: false,
      message: "Đánh giá mức độ hài lòng không hợp lệ",
    });
  }

  try {
    const feedback = await Feedback.findOneAndUpdate(
      {
        _id: req.params.id,
        user: req.user._id,
        status: "resolved",
      },
      { rating, ratedAt: new Date() },
      { new: true, runValidators: true },
    );

    if (feedback) {
      return res.json({
        success: true,
        feedback: serializeFeedback(feedback),
      });
    }

    const ownedFeedback = await Feedback.exists({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!ownedFeedback) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy góp ý",
      });
    }

    return res.status(409).json({
      success: false,
      message: "Chỉ có thể đánh giá góp ý đã ở trạng thái Đã giải quyết",
    });
  } catch (error) {
    if (error?.name === "CastError") {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy góp ý",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Không thể lưu đánh giá góp ý",
    });
  }
}

module.exports = {
  createFeedback,
  getAdminFeedback,
  getMyFeedback,
  rateFeedback,
  updateFeedbackStatus,
};
