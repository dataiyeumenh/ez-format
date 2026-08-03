class NoticeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoticeValidationError";
  }
}

function normalizeRequiredText(value, label, maxLength) {
  if (value === undefined || value === null || value === "") {
    throw new NoticeValidationError(`${label} thông báo là bắt buộc`);
  }
  if (typeof value !== "string") {
    throw new NoticeValidationError(`${label} thông báo phải là văn bản`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new NoticeValidationError(`${label} thông báo là bắt buộc`);
  }
  if (normalized.length > maxLength) {
    throw new NoticeValidationError(
      `${label} không được quá ${maxLength} ký tự`,
    );
  }
  return normalized;
}

function normalizeNoticePayload(payload = {}) {
  const title = normalizeRequiredText(payload.title, "Tiêu đề", 120);
  const description = normalizeRequiredText(payload.description, "Nội dung", 1000);

  return { title, description };
}

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeNotice(notice) {
  return {
    id: String(notice._id || notice.id),
    title: notice.title,
    description: notice.description,
    createdAt: toIsoString(notice.createdAt),
    updatedAt: toIsoString(notice.updatedAt),
  };
}

module.exports = {
  NoticeValidationError,
  normalizeNoticePayload,
  serializeNotice,
};
