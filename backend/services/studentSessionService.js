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
  let backfilled = 0;
  for (const item of backfills) {
    const result = await model.updateMany(
      { _id: item._id, retentionExpiresAt: { $in: [null] } },
      { $set: { retentionExpiresAt: item.retentionExpiresAt } },
    );
    backfilled += Number(result?.modifiedCount || 0);
  }
  const deletion = purgeIds.length
    ? await model.deleteMany({ _id: { $in: purgeIds } })
    : { deletedCount: 0 };
  return {
    scanned: candidates.length,
    backfilled,
    purged: Number(deletion?.deletedCount || 0),
  };
}

async function migrateStudentPrivacy(
  {
    questionEventModel,
    activityModel,
    sessionModel,
    retiredCollections,
  } = {},
  { mode: requestedMode = "off", batchSize = 100, now = new Date() } = {},
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
  if (mode === "apply" && rawIds.length) {
    if (typeof questionEventModel.updateMany !== "function") {
      throw new Error("StudentQuestionEvent model phải hỗ trợ updateMany");
    }
    const result = await questionEventModel.updateMany(
      { _id: { $in: rawIds } },
      {
        $unset: Object.fromEntries(
          RAW_STUDENT_QUESTION_FIELDS.map((field) => [field, 1]),
        ),
      },
    );
    report.scrubbed = Number(result?.modifiedCount || 0);
  }

  for (const collectionName of RETIRED_STUDENT_COLLECTION_NAMES) {
    const collection = retiredCollections?.[collectionName];
    const candidates = await findRetiredCollectionBatch(collection, limit);
    const candidateIds = candidates.map((item) => item?._id).filter(Boolean);
    report.scanned += candidateIds.length;
    report.retiredRawCandidates += candidateIds.length;
    report.retiredCollections[collectionName].candidates = candidateIds.length;
    if (mode !== "apply" || candidateIds.length === 0) continue;
    if (typeof collection.deleteMany !== "function") {
      throw new Error("Retired Student collection phải hỗ trợ deleteMany");
    }
    const deletion = await collection.deleteMany({
      _id: { $in: candidateIds },
    });
    const purged = Number(deletion?.deletedCount || 0);
    report.retiredRawPurged += purged;
    report.retiredCollections[collectionName].purged = purged;
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
    report.backfilled += retention.backfilled;
    report.orphansPurged += retention.purged;
  }
  return report;
}

module.exports = {
  buildOwnerScope,
  hashStudentQuestion,
  migrateStudentPrivacy,
  normalizeStudentPrivacyMigrationMode,
  normalizeStudentQuestion,
};
