const mongoose = require("mongoose");
const StudentAttempt = require("../models/StudentAttempt");
const StudentSkillProgress = require("../models/StudentSkillProgress");
const { assertMongoTransactionReady } = require("../config/db");

const MAX_REVISION_RETRIES = 5;
const STUDENT_SKILL_BY_ATTEMPT = Object.freeze({
  mapping_attempt: "excel_mapping",
  data_cleanup_attempt: "excel_mapping",
  document_classification_attempt: "document_classification",
  voucher_review_attempt: "misa_template_readiness",
  reconciliation_attempt: "vat_reconciliation",
});

function duplicateKeyError(error) {
  return Number(error?.code) === 11000;
}

function idempotencyConflict() {
  const error = new Error("Idempotency-Key đã được dùng cho bài làm khác");
  error.code = "STUDENT_ATTEMPT_IDEMPOTENCY_CONFLICT";
  error.statusCode = 409;
  return error;
}

function createStudentAttemptPersistence({
  AttemptModel = StudentAttempt,
  ProgressModel = StudentSkillProgress,
  assertTransactionsReady = () =>
    assertMongoTransactionReady("Student attempt completion"),
  startSession = () => mongoose.startSession(),
} = {}) {
  async function findProgress(userId, mongoSession = null) {
    const query = ProgressModel.findOne({ userId });
    return mongoSession ? query.session(mongoSession) : query;
  }

  async function findIdempotentAttempt(sessionId, identity, mongoSession = null) {
    const query = AttemptModel.findOne({
      sessionId,
      idempotencyKeyHash: identity.idempotencyKeyHash,
    });
    const attempt = await (mongoSession ? query.session(mongoSession) : query);
    if (!attempt) return null;
    if (attempt.requestFingerprint !== identity.requestFingerprint) {
      throw idempotencyConflict();
    }
    return attempt;
  }

  async function loadReplay(sessionRecord, identity, mongoSession = null) {
    const attempt = await findIdempotentAttempt(
      sessionRecord._id,
      identity,
      mongoSession,
    );
    if (!attempt) return null;
    const progress = await findProgress(sessionRecord.userId, mongoSession);
    if (!progress) {
      const error = new Error("Student progress không tồn tại cho bài làm đã ghi nhận");
      error.code = "STUDENT_ATTEMPT_PROGRESS_INCONSISTENT";
      throw error;
    }
    return { attempt, progress, idempotent: true };
  }

  async function persistInTransaction(sessionRecord, payload, identity, mongoSession) {
    const replay = await loadReplay(sessionRecord, identity, mongoSession);
    if (replay) return replay;

    const latest = await AttemptModel.findOne({ sessionId: sessionRecord._id })
      .sort({ revision: -1 })
      .session(mongoSession);
    const revision = Number(latest?.revision || 0) + 1;
    const [attempt] = await AttemptModel.create(
      [
        {
          sessionId: sessionRecord._id,
          userId: sessionRecord.userId,
          workspaceId: sessionRecord.workspaceId || null,
          ownerScope: sessionRecord.ownerScope,
          revision,
          idempotencyKeyHash: identity.idempotencyKeyHash,
          requestFingerprint: identity.requestFingerprint,
          kind: payload.kind,
          submittedStateHash: payload.submittedStateHash,
          sessionStateHash: payload.sessionStateHash,
          rubricVersion: payload.rubricVersion,
          score: payload.score,
          summary: payload.summary,
          hintLevelUsed: 0,
          retentionExpiresAt: new Date(sessionRecord.retentionExpiresAt),
        },
      ],
      { session: mongoSession },
    );
    const skill = STUDENT_SKILL_BY_ATTEMPT[payload.kind];
    const progress = await ProgressModel.findOneAndUpdate(
      { userId: sessionRecord.userId },
      {
        $set: { [`skills.${skill}.score`]: payload.score },
        $inc: {
          [`skills.${skill}.evidenceCount`]: payload.summary.evidenceCount,
        },
        $setOnInsert: { userId: sessionRecord.userId },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        session: mongoSession,
      },
    );
    return { attempt, progress, idempotent: false };
  }

  async function persistCompletion({ session: sessionRecord, payload, identity }) {
    assertTransactionsReady();
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry += 1) {
      const mongoSession = await startSession();
      try {
        let result;
        await mongoSession.withTransaction(
          async () => {
            result = await persistInTransaction(
              sessionRecord,
              payload,
              identity,
              mongoSession,
            );
            return result;
          },
          {
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
            readPreference: "primary",
          },
        );
        return result;
      } catch (error) {
        if (!duplicateKeyError(error)) throw error;
      } finally {
        await mongoSession.endSession();
      }

      const replay = await loadReplay(sessionRecord, identity);
      if (replay) return replay;
    }
    const error = new Error("Không thể cấp revision duy nhất cho bài làm student");
    error.code = "STUDENT_ATTEMPT_REVISION_CONFLICT";
    throw error;
  }

  return { persistCompletion };
}

const studentAttemptPersistence = createStudentAttemptPersistence();

module.exports = {
  createStudentAttemptPersistence,
  studentAttemptPersistence,
};
