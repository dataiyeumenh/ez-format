const Notice = require("../models/Notice");
const NoticeReadState = require("../models/NoticeReadState");
const {
  NoticeValidationError,
  normalizeNoticePayload,
  serializeNotice,
} = require("../services/noticeService");

function resolveLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 50);
}

async function listNotices(req, res) {
  try {
    const [notices, readState] = await Promise.all([
      Notice.find({})
        .sort({ createdAt: -1 })
        .limit(resolveLimit(req.query?.limit)),
      NoticeReadState.findOne({ user: req.user._id }),
    ]);
    const readThrough = readState?.readThrough
      ? new Date(readState.readThrough)
      : null;
    const unreadFilter = readThrough
      ? { createdAt: { $gt: readThrough } }
      : {};
    const unreadCount = await Notice.countDocuments(unreadFilter);
    const items = notices.map((notice) => ({
      ...serializeNotice(notice),
      isRead: Boolean(
        readThrough && new Date(notice.createdAt).getTime() <= readThrough.getTime(),
      ),
    }));
    const readCursor = notices[0]?.createdAt
      ? new Date(notices[0].createdAt).toISOString()
      : null;

    return res.json({
      success: true,
      total: items.length,
      unreadCount,
      readCursor,
      notices: items,
    });
  } catch (_error) {
    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách thông báo",
    });
  }
}

async function markNoticesRead(req, res) {
  const readThrough = new Date(req.body?.readThrough);
  if (
    !req.body?.readThrough ||
    Number.isNaN(readThrough.getTime()) ||
    readThrough.getTime() > Date.now()
  ) {
    return res.status(400).json({
      success: false,
      message: "Mốc đọc thông báo không hợp lệ",
    });
  }

  try {
    const state = await NoticeReadState.findOneAndUpdate(
      { user: req.user._id },
      { $max: { readThrough } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const effectiveReadThrough = state?.readThrough || readThrough;
    const unreadCount = await Notice.countDocuments({
      createdAt: { $gt: effectiveReadThrough },
    });

    return res.json({ success: true, unreadCount });
  } catch (_error) {
    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật trạng thái thông báo",
    });
  }
}

async function createNotice(req, res) {
  try {
    const payload = normalizeNoticePayload(req.body);
    const notice = await Notice.create(payload);
    return res.status(201).json({
      success: true,
      notice: serializeNotice(notice),
    });
  } catch (error) {
    if (error instanceof NoticeValidationError || error?.name === "ValidationError") {
      const message =
        error instanceof NoticeValidationError
          ? error.message
          : Object.values(error.errors || {})[0]?.message;
      return res.status(400).json({
        success: false,
        message: message || "Dữ liệu thông báo không hợp lệ",
      });
    }

    console.error("Không thể tạo thông báo:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể gửi thông báo",
    });
  }
}

module.exports = {
  createNotice,
  listNotices,
  markNoticesRead,
  resolveLimit,
};
