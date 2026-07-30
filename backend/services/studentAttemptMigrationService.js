const StudentAttempt = require("../models/StudentAttempt");

const STUDENT_ATTEMPT_INDEXES = Object.freeze([
  Object.freeze({
    keys: Object.freeze({ retentionExpiresAt: 1 }),
    options: Object.freeze({ expireAfterSeconds: 0 }),
  }),
  Object.freeze({
    keys: Object.freeze({ sessionId: 1, revision: 1 }),
    options: Object.freeze({ unique: true }),
  }),
  Object.freeze({
    keys: Object.freeze({ sessionId: 1, idempotencyKeyHash: 1 }),
    options: Object.freeze({ unique: true }),
  }),
]);

async function ensureStudentAttemptPersistence(
  model = StudentAttempt,
  { now = new Date() } = {},
) {
  const collection = model?.collection || model;
  if (
    !collection ||
    typeof collection.deleteMany !== "function" ||
    typeof collection.createIndex !== "function"
  ) {
    throw new Error("StudentAttempt collection phải hỗ trợ purge và index migration");
  }

  const purgeResult = await collection.deleteMany({
    $or: [
      { retentionExpiresAt: { $exists: false } },
      { retentionExpiresAt: null },
      { retentionExpiresAt: { $lte: now } },
      { idempotencyKeyHash: { $exists: false } },
      { idempotencyKeyHash: "" },
      { requestFingerprint: { $exists: false } },
      { requestFingerprint: "" },
    ],
  });
  for (const { keys, options } of STUDENT_ATTEMPT_INDEXES) {
    await collection.createIndex(keys, options);
  }
  return { purged: Number(purgeResult?.deletedCount || 0) };
}

module.exports = {
  STUDENT_ATTEMPT_INDEXES,
  ensureStudentAttemptPersistence,
};
