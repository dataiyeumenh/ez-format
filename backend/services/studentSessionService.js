const crypto = require("node:crypto");

function normalizeIdentifier(value) {
  return String(value ?? "").trim();
}

function buildOwnerScope({ userId, workspaceId } = {}) {
  const normalizedWorkspaceId = normalizeIdentifier(workspaceId);
  if (normalizedWorkspaceId) return `workspace:${normalizedWorkspaceId}`;

  const normalizedUserId = normalizeIdentifier(userId);
  if (normalizedUserId) return `user:${normalizedUserId}`;

  throw new Error("Student owner scope là bắt buộc");
}

function normalizeStudentQuestion(value) {
  return String(value ?? "").trim();
}

function hashStudentQuestion(value) {
  return crypto
    .createHash("sha256")
    .update(normalizeStudentQuestion(value), "utf8")
    .digest("hex");
}

async function migrateStudentQuestionEventPrivacy(model, { batchSize = 100 } = {}) {
  const collection = model?.collection || model;
  if (!collection || typeof collection.updateMany !== "function") {
    throw new Error("StudentQuestionEvent model là bắt buộc");
  }
  const rawFields = [
    "question",
    "answer",
    "rows",
    "rawRows",
    "evidence",
    "workbook",
    "workbookBytes",
    "content",
  ];
  if (typeof collection.find !== "function") {
    throw new Error("StudentQuestionEvent collection phải hỗ trợ truy vấn giới hạn");
  }
  const boundedBatchSize = Math.min(
    Math.max(Math.floor(Number(batchSize) || 100), 1),
    1000,
  );
  const rawContentFilter = {
    $or: rawFields.map((field) => ({ [field]: { $exists: true } })),
  };
  const legacyEvents = await collection
    .find(rawContentFilter)
    .sort({ _id: 1 })
    .limit(boundedBatchSize)
    .project({ _id: 1 })
    .toArray();
  const legacyIds = legacyEvents.map((event) => event?._id).filter(Boolean);
  if (!legacyIds.length) {
    return { purged: 0 };
  }
  const result = await collection.updateMany(
    { _id: { $in: legacyIds } },
    { $unset: Object.fromEntries(rawFields.map((field) => [field, 1])) },
  );
  return { purged: Number(result?.modifiedCount || 0) };
}

module.exports = {
  buildOwnerScope,
  hashStudentQuestion,
  migrateStudentQuestionEventPrivacy,
  normalizeStudentQuestion,
};
