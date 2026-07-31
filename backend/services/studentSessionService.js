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

const RAW_STUDENT_QUESTION_FIELDS = Object.freeze([
  "question",
  "answer",
  "rows",
  "rawRows",
  "evidence",
  "workbook",
  "workbookBytes",
  "content",
]);
const RETIRED_STUDENT_COLLECTION_NAMES = Object.freeze([
  "studentattempts",
  "studentskillprogresses",
]);
const DEFAULT_RETIRED_MAX_TOTAL = 10_000;
const DEFAULT_RETIRED_MAX_DURATION_MS = 30_000;

async function ensureStudentPrivacyIndexes({
  sessionModel,
  questionEventModel,
  activityModel,
} = {}) {
  const droppedIndexes = [];
  for (const [name, model] of [
    ["StudentFileSession", sessionModel],
    ["StudentQuestionEvent", questionEventModel],
    ["StudentActivity", activityModel],
  ]) {
    if (!model?.collection?.indexes || !model?.collection?.dropIndex || !model?.createIndexes) {
      throw new Error(`${name} index management is unavailable`);
    }
    let indexes = [];
    try {
      indexes = await model.collection.indexes();
    } catch (error) {
      if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") throw error;
    }
    for (const index of indexes) {
      if (index?.expireAfterSeconds == null || index?.key?.retentionExpiresAt !== 1) continue;
      await model.collection.dropIndex(index.name);
      droppedIndexes.push(`${name}.${index.name}`);
    }
    await model.createIndexes();
  }
  return { droppedIndexes };
}

function normalizeStudentPrivacyMigrationMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  if (!["off", "dry-run", "apply"].includes(mode)) {
    throw new Error("STUDENT_PRIVACY_MIGRATION_MODE must be off, dry-run, or apply");
  }
  return mode;
}

function boundedBatchSize(value) {
  return Math.min(Math.max(Math.floor(Number(value) || 100), 1), 1000);
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), maximum);
}

async function findBounded(model, filter, batchSize, projection) {
  if (!model || typeof model.find !== "function") {
    throw new Error("Student privacy model phải hỗ trợ find");
  }
  const query = model.find(filter);
  if (
    !query ||
    typeof query.sort !== "function" ||
    typeof query.limit !== "function" ||
    typeof query.select !== "function" ||
    typeof query.lean !== "function"
  ) {
    throw new Error("Student privacy query phải hỗ trợ bounded projection");
  }
  return query
    .sort({ _id: 1 })
    .limit(batchSize)
    .select(projection)
    .lean();
}

async function findRetiredCollectionBatch(collection, batchSize) {
  if (!collection || typeof collection.find !== "function") {
    throw new Error("Retired Student collection phải hỗ trợ find");
  }
  let cursor = collection.find({}, { projection: { _id: 1 } });
  if (
    !cursor ||
    typeof cursor.sort !== "function" ||
    typeof cursor.limit !== "function" ||
    typeof cursor.toArray !== "function"
  ) {
    throw new Error("Retired Student collection phải hỗ trợ bounded cursor");
  }
  cursor = cursor.sort({ _id: 1 });
  cursor = cursor.limit(batchSize);
  return cursor.toArray();
}

async function migrateRetentionMetadata({
  model,
  sessionModel,
  mode,
  batchSize,
  now,
  beforeMutate = () => {},
  afterMutate = () => {},
  afterBatch = () => {},
  failIncomplete,
  assertTimeRemaining = () => {},
}) {
  const candidates = await findBounded(
    model,
    {
      $or: [
        { retentionExpiresAt: { $exists: false } },
        { retentionExpiresAt: null },
        { retentionExpiresAt: { $lte: now } },
      ],
    },
    batchSize,
    { _id: 1, sessionId: 1, retentionExpiresAt: 1 },
  );
  if (!candidates.length) return { scanned: 0, backfilled: 0, purged: 0 };

  const missingRetention = candidates.filter((item) => !item?.retentionExpiresAt);
  let sessions = [];
  if (missingRetention.length) {
    if (!sessionModel || typeof sessionModel.find !== "function") {
      throw new Error("StudentFileSession model là bắt buộc cho orphan cleanup");
    }
    const query = sessionModel.find({
      _id: { $in: missingRetention.map((item) => item.sessionId).filter(Boolean) },
    });
    if (!query || typeof query.select !== "function" || typeof query.lean !== "function") {
      throw new Error("StudentFileSession query không hợp lệ");
    }
    sessions = await query.select({ _id: 1, retentionExpiresAt: 1 }).lean();
  }
  const retentionBySession = new Map(
    sessions.map((session) => [String(session._id), session.retentionExpiresAt]),
  );
  const purgeIds = [];
  const backfills = [];
  for (const candidate of candidates) {
    if (candidate.retentionExpiresAt) {
      purgeIds.push(candidate._id);
      continue;
    }
    const retentionExpiresAt = retentionBySession.get(String(candidate.sessionId));
    if (!retentionExpiresAt || new Date(retentionExpiresAt) <= now) {
      purgeIds.push(candidate._id);
    } else {
      backfills.push({ _id: candidate._id, retentionExpiresAt });
    }
  }
  if (mode !== "apply") {
    return { scanned: candidates.length, backfilled: 0, purged: 0 };
  }
  if (typeof model.updateMany !== "function" || typeof model.deleteMany !== "function") {
    throw new Error("Student privacy model phải hỗ trợ updateMany và deleteMany");
  }
  beforeMutate(candidates.length);
  let backfilled = 0;
  for (const item of backfills) {
    assertTimeRemaining();
    const result = await model.updateMany(
      { _id: item._id, retentionExpiresAt: { $in: [null] } },
      { $set: { retentionExpiresAt: item.retentionExpiresAt } },
    );
    const modified = Number(result?.modifiedCount || 0);
    backfilled += modified;
    afterMutate(modified);
    afterBatch();
    if (modified !== 1 && typeof failIncomplete === "function") {
      failIncomplete("Student retention metadata không được backfill đầy đủ");
    }
    assertTimeRemaining();
  }
  assertTimeRemaining();
  const deletion = purgeIds.length
    ? await model.deleteMany({ _id: { $in: purgeIds } })
    : { deletedCount: 0 };
  const purged = Number(deletion?.deletedCount || 0);
  if (purgeIds.length) {
    afterMutate(purged);
    afterBatch();
  }
  if (purged !== purgeIds.length && typeof failIncomplete === "function") {
    failIncomplete("Student orphan metadata không được purge đầy đủ");
  }
  assertTimeRemaining();
  return {
    scanned: candidates.length,
    backfilled,
    purged,
  };
}

async function migrateStudentPrivacy(
  {
    questionEventModel,
    activityModel,
    sessionModel,
    retiredCollections,
  } = {},
  {
    mode: requestedMode = "off",
    batchSize = 100,
    now = new Date(),
    maxRetiredRecords = DEFAULT_RETIRED_MAX_TOTAL,
    maxDurationMs = DEFAULT_RETIRED_MAX_DURATION_MS,
    clock = Date.now,
  } = {},
) {
  const mode = normalizeStudentPrivacyMigrationMode(requestedMode);
  const report = {
    mode,
    scanned: 0,
    rawCandidates: 0,
    scrubbed: 0,
    backfilled: 0,
    orphansPurged: 0,
    retiredRawCandidates: 0,
    retiredRawPurged: 0,
    retiredCollections: Object.fromEntries(
      RETIRED_STUDENT_COLLECTION_NAMES.map((name) => [
        name,
        { candidates: 0, purged: 0 },
      ]),
    ),
  };
  if (mode === "off") return report;

  const limit = boundedBatchSize(batchSize);
  if (mode !== "apply") {
    const rawEvents = await findBounded(
      questionEventModel,
      {
        $or: RAW_STUDENT_QUESTION_FIELDS.map((field) => ({
          [field]: { $exists: true },
        })),
      },
      limit,
      { _id: 1 },
    );
    const rawIds = rawEvents.map((event) => event?._id).filter(Boolean);
    report.rawCandidates = rawIds.length;
    report.scanned += rawIds.length;
    for (const collectionName of RETIRED_STUDENT_COLLECTION_NAMES) {
      const collection = retiredCollections?.[collectionName];
      const candidates = await findRetiredCollectionBatch(collection, limit);
      const candidateIds = candidates.map((item) => item?._id).filter(Boolean);
      report.scanned += candidateIds.length;
      report.retiredRawCandidates += candidateIds.length;
      report.retiredCollections[collectionName].candidates = candidateIds.length;
    }
    for (const model of [questionEventModel, activityModel]) {
      const retention = await migrateRetentionMetadata({
        model,
        sessionModel,
        mode,
        batchSize: limit,
        now,
      });
      report.scanned += retention.scanned;
    }
    return report;
  }

  const maxTotal = boundedPositiveInteger(
    maxRetiredRecords,
    DEFAULT_RETIRED_MAX_TOTAL,
    1_000_000,
  );
  const timeLimitMs = boundedPositiveInteger(
    maxDurationMs,
    DEFAULT_RETIRED_MAX_DURATION_MS,
    10 * 60 * 1000,
  );
  if (typeof clock !== "function") {
    throw new Error("Student privacy migration clock không hợp lệ");
  }
  const startedAt = Number(clock());
  report.privacyDrain = {
    status: "running",
    reason: null,
    batches: 0,
    mutated: 0,
    maxTotal,
    maxDurationMs: timeLimitMs,
    elapsedMs: 0,
  };
  // Compatibility for startup reporting while the budget now covers every privacy category.
  report.retiredDrain = report.privacyDrain;
  const elapsedMs = () => Math.max(0, Number(clock()) - startedAt);
  const failDrain = (code, reason, message) => {
    report.privacyDrain.status = "failed";
    report.privacyDrain.reason = reason;
    report.privacyDrain.elapsedMs = elapsedMs();
    const error = new Error(message);
    error.code = code;
    error.report = report;
    throw error;
  };
  const assertTimeRemaining = () => {
    if (elapsedMs() > timeLimitMs) {
      failDrain(
        "STUDENT_PRIVACY_TIME_LIMIT_EXCEEDED",
        "time-limit",
        "Student privacy drain vượt quá giới hạn thời gian",
      );
    }
  };
  const remainingCapacity = () => maxTotal - report.privacyDrain.mutated;
  const queryLimit = () => {
    const remaining = remainingCapacity();
    return remaining >= limit ? limit : Math.max(1, remaining + 1);
  };
  const assertCapacity = (count) => {
    if (count > remainingCapacity()) {
      failDrain(
        "STUDENT_PRIVACY_MAX_TOTAL_EXCEEDED",
        "max-total",
        "Student privacy drain vượt quá giới hạn tổng record",
      );
    }
  };
  const recordMutation = (count) => {
    report.privacyDrain.mutated += Number(count || 0);
  };
  const recordBatch = () => {
    report.privacyDrain.batches += 1;
  };
  const failIncomplete = (message) => failDrain(
    "STUDENT_PRIVACY_DELETE_INCOMPLETE",
    "delete-incomplete",
    message,
  );

  try {
    if (typeof questionEventModel?.updateMany !== "function") {
      throw new Error("StudentQuestionEvent model phải hỗ trợ updateMany");
    }
    while (true) {
      assertTimeRemaining();
      const rawEvents = await findBounded(
        questionEventModel,
        {
          $or: RAW_STUDENT_QUESTION_FIELDS.map((field) => ({
            [field]: { $exists: true },
          })),
        },
        queryLimit(),
        { _id: 1 },
      );
      assertTimeRemaining();
      const rawIds = rawEvents.map((event) => event?._id).filter(Boolean);
      report.rawCandidates += rawIds.length;
      report.scanned += rawIds.length;
      if (rawIds.length === 0) break;
      if (rawIds.length !== rawEvents.length) {
        failDrain(
          "STUDENT_PRIVACY_INVALID_RAW_RECORD",
          "invalid-record",
          "StudentQuestionEvent raw chứa record không có _id",
        );
      }
      assertCapacity(rawIds.length);
      const result = await questionEventModel.updateMany(
        { _id: { $in: rawIds } },
        {
          $unset: Object.fromEntries(
            RAW_STUDENT_QUESTION_FIELDS.map((field) => [field, 1]),
          ),
        },
      );
      const scrubbed = Number(result?.modifiedCount || 0);
      report.scrubbed += scrubbed;
      recordMutation(scrubbed);
      recordBatch();
      if (scrubbed !== rawIds.length) {
        failIncomplete("StudentQuestionEvent raw không được scrub đầy đủ");
      }
      assertTimeRemaining();
    }

    for (const model of [questionEventModel, activityModel]) {
      while (true) {
        assertTimeRemaining();
        const retention = await migrateRetentionMetadata({
          model,
          sessionModel,
          mode,
          batchSize: queryLimit(),
          now,
          beforeMutate: assertCapacity,
          afterMutate: recordMutation,
          afterBatch: recordBatch,
          failIncomplete,
          assertTimeRemaining,
        });
        report.scanned += retention.scanned;
        report.backfilled += retention.backfilled;
        report.orphansPurged += retention.purged;
        assertTimeRemaining();
        if (retention.scanned === 0) break;
      }
    }

    for (const collectionName of RETIRED_STUDENT_COLLECTION_NAMES) {
      const collection = retiredCollections?.[collectionName];
      if (typeof collection?.deleteMany !== "function") {
        throw new Error("Retired Student collection phải hỗ trợ deleteMany");
      }
      while (true) {
        assertTimeRemaining();
        const candidates = await findRetiredCollectionBatch(collection, queryLimit());
        assertTimeRemaining();
        const candidateIds = candidates.map((item) => item?._id).filter(Boolean);
        report.scanned += candidateIds.length;
        report.retiredRawCandidates += candidateIds.length;
        report.retiredCollections[collectionName].candidates += candidateIds.length;
        if (candidateIds.length === 0) break;
        if (candidateIds.length !== candidates.length) {
          failDrain(
            "STUDENT_PRIVACY_INVALID_RETIRED_RECORD",
            "invalid-record",
            "Retired Student collection chứa record không có _id",
          );
        }
        assertCapacity(candidateIds.length);
        const deletion = await collection.deleteMany({ _id: { $in: candidateIds } });
        const purged = Number(deletion?.deletedCount || 0);
        report.retiredRawPurged += purged;
        report.retiredCollections[collectionName].purged += purged;
        recordMutation(purged);
        recordBatch();
        if (purged !== candidateIds.length) {
          failIncomplete("Retired Student batch không được purge đầy đủ");
        }
        assertTimeRemaining();
      }
    }
    report.privacyDrain.status = "completed";
    report.privacyDrain.elapsedMs = elapsedMs();
  } catch (error) {
    if (error?.report) throw error;
    report.privacyDrain.status = "failed";
    report.privacyDrain.reason = "error";
    report.privacyDrain.elapsedMs = elapsedMs();
    error.code ||= "STUDENT_PRIVACY_DRAIN_FAILED";
    error.report = report;
    throw error;
  }
  return report;
}

module.exports = {
  buildOwnerScope,
  ensureStudentPrivacyIndexes,
  hashStudentQuestion,
  migrateStudentPrivacy,
  normalizeStudentPrivacyMigrationMode,
  normalizeStudentQuestion,
};
