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

async function migrateStudentQuestionEventPrivacy(model) {
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
  const result = await collection.updateMany(
    { $or: rawFields.map((field) => ({ [field]: { $exists: true } })) },
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
