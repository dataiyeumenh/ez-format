const assert = require("node:assert/strict");
const test = require("node:test");

const StudentActivity = require("../models/StudentActivity");
const StudentFileSession = require("../models/StudentFileSession");
const StudentQuestionEvent = require("../models/StudentQuestionEvent");
const {
  deleteStudentSession,
  purgeStudentOperationSession,
  recordStudentActivity,
  recordStudentQuestionEvent,
  refreshStudentContext,
  sweepStaleStudentDeletions,
} = require("../controllers/studentSessionController");
const {
  createStudentContextToken,
  verifyConversionContextToken,
  verifyStudentContextToken,
} = require("../services/conversionContextService");
const { createStartServer } = require("../server");
const {
  migrateStudentPrivacy,
  normalizeStudentPrivacyMigrationMode,
  hashStudentQuestion,
} = require("../services/studentSessionService");

process.env.CONVERSION_CONTEXT_SECRET = "student-privacy-test-secret";

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

function emptyQuery(calls, documents = []) {
  return {
    sort(value) {
      calls.push(["sort", value]);
      return this;
    },
    limit(value) {
      calls.push(["limit", value]);
      return this;
    },
    select(value) {
      calls.push(["select", value]);
      return this;
    },
    lean: async () => documents,
  };
}

function retiredCollection(name, documents, calls) {
  let remaining = [...documents];
  return {
    find(filter, options) {
      calls.push([`${name}-find`, filter, options]);
      let limit = remaining.length;
      return {
        sort(value) {
          calls.push([`${name}-sort`, value]);
          return this;
        },
        limit(value) {
          calls.push([`${name}-limit`, value]);
          limit = value;
          return this;
        },
        toArray: async () => remaining.slice(0, limit),
      };
    },
    async deleteMany(filter) {
      calls.push([`${name}-delete`, filter]);
      const ids = new Set(filter._id.$in.map(String));
      const before = remaining.length;
      remaining = remaining.filter((item) => !ids.has(String(item._id)));
      return { deletedCount: before - remaining.length };
    },
  };
}

function drainingPrivacyModel(name, { raw = [], retention = [] }, calls) {
  let rawRemaining = [...raw];
  let retentionRemaining = [...retention];
  const boundedQuery = (source) => {
    let limit = source.length;
    return {
      sort(value) {
        calls.push([`${name}-sort`, value]);
        return this;
      },
      limit(value) {
        calls.push([`${name}-limit`, value]);
        limit = value;
        return this;
      },
      select(value) {
        calls.push([`${name}-select`, value]);
        return this;
      },
      lean: async () => source.slice(0, limit),
    };
  };
  return {
    find(filter) {
      const scansRawFields = filter.$or?.some((item) => "question" in item);
      return boundedQuery(scansRawFields ? rawRemaining : retentionRemaining);
    },
    async updateMany(filter, update) {
      const ids = new Set(filter._id?.$in?.map(String) || [String(filter._id)]);
      if (update.$unset) {
        const before = rawRemaining.length;
        rawRemaining = rawRemaining.filter((item) => !ids.has(String(item._id)));
        const modifiedCount = before - rawRemaining.length;
        calls.push([`${name}-raw-update`, filter, update, modifiedCount]);
        return { modifiedCount };
      }
      const before = retentionRemaining.length;
      retentionRemaining = retentionRemaining.filter((item) => !ids.has(String(item._id)));
      const modifiedCount = before - retentionRemaining.length;
      calls.push([`${name}-retention-update`, filter, update, modifiedCount]);
      return { modifiedCount };
    },
    async deleteMany(filter) {
      const ids = new Set(filter._id.$in.map(String));
      const before = retentionRemaining.length;
      retentionRemaining = retentionRemaining.filter((item) => !ids.has(String(item._id)));
      const deletedCount = before - retentionRemaining.length;
      calls.push([`${name}-delete`, filter, deletedCount]);
      return { deletedCount };
    },
    remaining() {
      return { raw: rawRemaining.length, retention: retentionRemaining.length };
    },
  };
}

function privacyModels({
  rawEvents = [],
  retiredAttempts = [],
  retiredProgresses = [],
} = {}) {
  const calls = [];
  let rawRemaining = [...rawEvents];
  const questionEventModel = {
    find(filter) {
      calls.push(["question-find", filter]);
      const scansRawFields = filter.$or?.some((item) => "question" in item);
      return emptyQuery(calls, scansRawFields ? rawRemaining : []);
    },
    updateMany: async (...args) => {
      calls.push(["question-update", ...args]);
      if (args[1]?.$unset) {
        const ids = new Set(args[0]._id.$in.map(String));
        const before = rawRemaining.length;
        rawRemaining = rawRemaining.filter((item) => !ids.has(String(item._id)));
        return { modifiedCount: before - rawRemaining.length };
      }
      return { modifiedCount: 0 };
    },
    deleteMany: async (...args) => {
      calls.push(["question-delete", ...args]);
      return { deletedCount: 0 };
    },
  };
  const activityModel = {
    find(filter) {
      calls.push(["activity-find", filter]);
      return emptyQuery(calls);
    },
    updateMany: async (...args) => {
      calls.push(["activity-update", ...args]);
      return { modifiedCount: 0 };
    },
    deleteMany: async (...args) => {
      calls.push(["activity-delete", ...args]);
      return { deletedCount: 0 };
    },
  };
  const sessionModel = {
    find(filter) {
      calls.push(["session-find", filter]);
      return emptyQuery(calls);
    },
  };
  return {
    models: {
      questionEventModel,
      activityModel,
      sessionModel,
      retiredCollections: {
        studentattempts: retiredCollection(
          "studentattempts",
          retiredAttempts,
          calls,
        ),
        studentskillprogresses: retiredCollection(
          "studentskillprogresses",
          retiredProgresses,
          calls,
        ),
      },
    },
    calls,
  };
}

test("Student privacy migration defaults off and touches no model", async () => {
  assert.equal(normalizeStudentPrivacyMigrationMode(undefined), "off");
  assert.throws(
    () => normalizeStudentPrivacyMigrationMode("enabled"),
    /off, dry-run, or apply/i,
  );
  const untouched = new Proxy({}, { get() { throw new Error("model touched"); } });

  const report = await migrateStudentPrivacy(
    {
      questionEventModel: untouched,
      activityModel: untouched,
      sessionModel: untouched,
    },
    { mode: "off" },
  );

  assert.deepEqual(report, {
    mode: "off",
    scanned: 0,
    rawCandidates: 0,
    scrubbed: 0,
    backfilled: 0,
    orphansPurged: 0,
    retiredRawCandidates: 0,
    retiredRawPurged: 0,
    retiredCollections: {
      studentattempts: { candidates: 0, purged: 0 },
      studentskillprogresses: { candidates: 0, purged: 0 },
    },
  });
});

test("Student privacy dry-run is bounded and performs no mutation", async () => {
  const { models, calls } = privacyModels({
    rawEvents: [{ _id: "raw-1" }, { _id: "raw-2" }],
  });

  const report = await migrateStudentPrivacy(models, {
    mode: "dry-run",
    batchSize: 2,
    now: new Date("2026-07-30T00:00:00Z"),
  });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.rawCandidates, 2);
  assert.equal(report.scrubbed, 0);
  assert.ok(calls.some(([type, value]) => type === "limit" && value === 2));
  assert.equal(calls.some(([type]) => type.includes("update") || type.includes("delete")), false);
});

test("Student privacy apply scrubs one bounded batch and is idempotent", async () => {
  const { models, calls } = privacyModels({ rawEvents: [{ _id: "raw-1" }] });

  const first = await migrateStudentPrivacy(models, { mode: "apply", batchSize: 1 });
  assert.equal(first.scrubbed, 1);
  const mutation = calls.find(([type]) => type === "question-update");
  assert.deepEqual(mutation[1], { _id: { $in: ["raw-1"] } });
  assert.deepEqual(Object.keys(mutation[2].$unset).sort(), [
    "answer",
    "content",
    "evidence",
    "question",
    "rawRows",
    "rows",
    "workbook",
    "workbookBytes",
  ]);

  const secondModels = privacyModels().models;
  const second = await migrateStudentPrivacy(secondModels, { mode: "apply", batchSize: 1 });
  assert.equal(second.scrubbed, 0);
});

test("Student privacy migration counts and purges retired raw collections", async () => {
  const { models, calls } = privacyModels({
    retiredAttempts: [{ _id: "attempt-1" }],
    retiredProgresses: [{ _id: "progress-1" }],
  });

  const dryRun = await migrateStudentPrivacy(models, {
    mode: "dry-run",
    batchSize: 1,
  });
  assert.equal(dryRun.retiredRawCandidates, 2);
  assert.equal(dryRun.retiredRawPurged, 0);
  assert.deepEqual(dryRun.retiredCollections, {
    studentattempts: { candidates: 1, purged: 0 },
    studentskillprogresses: { candidates: 1, purged: 0 },
  });
  assert.equal(calls.some(([type]) => type.endsWith("-delete")), false);
  assert.deepEqual(
    calls.filter(([type]) => type.endsWith("-limit")).map(([, value]) => value),
    [1, 1],
  );

  const applied = await migrateStudentPrivacy(models, {
    mode: "apply",
    batchSize: 1,
  });
  assert.equal(applied.retiredRawCandidates, 2);
  assert.equal(applied.retiredRawPurged, 2);
  assert.deepEqual(applied.retiredCollections, {
    studentattempts: { candidates: 1, purged: 1 },
    studentskillprogresses: { candidates: 1, purged: 1 },
  });
  assert.deepEqual(
    calls.find(([type]) => type === "studentattempts-delete")[1],
    { _id: { $in: ["attempt-1"] } },
  );
  assert.deepEqual(
    calls.find(([type]) => type === "studentskillprogresses-delete")[1],
    { _id: { $in: ["progress-1"] } },
  );

  const repeated = await migrateStudentPrivacy(models, {
    mode: "apply",
    batchSize: 1,
  });
  assert.equal(repeated.retiredRawCandidates, 0);
  assert.equal(repeated.retiredRawPurged, 0);
  assert.deepEqual(repeated.retiredCollections, {
    studentattempts: { candidates: 0, purged: 0 },
    studentskillprogresses: { candidates: 0, purged: 0 },
  });
});

test("Student privacy apply drains 101+ retired records in bounded batches", async () => {
  const retiredAttempts = Array.from({ length: 101 }, (_, index) => ({
    _id: `attempt-${String(index + 1).padStart(3, "0")}`,
  }));
  const retiredProgresses = Array.from({ length: 101 }, (_, index) => ({
    _id: `progress-${String(index + 1).padStart(3, "0")}`,
  }));
  const { models, calls } = privacyModels({ retiredAttempts, retiredProgresses });

  const applied = await migrateStudentPrivacy(models, {
    mode: "apply",
    batchSize: 100,
    maxRetiredRecords: 1000,
    maxDurationMs: 30_000,
  });

  assert.equal(applied.retiredRawCandidates, 202);
  assert.equal(applied.retiredRawPurged, 202);
  assert.deepEqual(applied.retiredCollections, {
    studentattempts: { candidates: 101, purged: 101 },
    studentskillprogresses: { candidates: 101, purged: 101 },
  });
  assert.equal(applied.retiredDrain.status, "completed");
  assert.equal(applied.retiredDrain.batches, 4);
  assert.ok(
    calls
      .filter(([type]) => type === "studentattempts-delete")
      .every(([, filter]) => filter._id.$in.length <= 100),
  );
  assert.ok(
    calls
      .filter(([type]) => type === "studentskillprogresses-delete")
      .every(([, filter]) => filter._id.$in.length <= 100),
  );

  const repeated = await migrateStudentPrivacy(models, {
    mode: "apply",
    batchSize: 100,
    maxRetiredRecords: 1000,
    maxDurationMs: 30_000,
  });
  assert.equal(repeated.retiredRawCandidates, 0);
  assert.equal(repeated.retiredRawPurged, 0);
  assert.equal(repeated.retiredDrain.status, "completed");
  assert.equal(repeated.retiredDrain.batches, 0);
});

test("Student privacy apply fails closed with report at retired max-total", async () => {
  const retiredAttempts = Array.from({ length: 101 }, (_, index) => ({
    _id: `attempt-${index + 1}`,
  }));
  const { models } = privacyModels({ retiredAttempts });

  await assert.rejects(
    migrateStudentPrivacy(models, {
      mode: "apply",
      batchSize: 50,
      maxRetiredRecords: 100,
      maxDurationMs: 30_000,
    }),
    (error) => {
      assert.equal(error.code, "STUDENT_PRIVACY_MAX_TOTAL_EXCEEDED");
      assert.equal(error.report.retiredRawPurged, 100);
      assert.equal(error.report.retiredDrain.status, "failed");
      assert.equal(error.report.retiredDrain.reason, "max-total");
      assert.equal(error.report.retiredDrain.maxTotal, 100);
      return true;
    },
  );
});

test("Student privacy apply fails closed with report at retired time limit", async () => {
  const { models } = privacyModels({
    retiredAttempts: [{ _id: "attempt-1" }],
  });
  let elapsed = 0;
  const clock = () => {
    elapsed += 10;
    return elapsed;
  };

  await assert.rejects(
    migrateStudentPrivacy(models, {
      mode: "apply",
      batchSize: 100,
      maxRetiredRecords: 1000,
      maxDurationMs: 15,
      clock,
    }),
    (error) => {
      assert.equal(error.code, "STUDENT_PRIVACY_TIME_LIMIT_EXCEEDED");
      assert.equal(error.report.retiredRawPurged, 0);
      assert.equal(error.report.retiredDrain.status, "failed");
      assert.equal(error.report.retiredDrain.reason, "time-limit");
      assert.equal(error.report.retiredDrain.maxDurationMs, 15);
      return true;
    },
  );
});

test("Student privacy apply drains 150+ raw, orphan, and retired records with one bounded budget", async () => {
  const calls = [];
  const records = (prefix) => Array.from({ length: 151 }, (_, index) => ({
    _id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    sessionId: `missing-${prefix}-${index + 1}`,
  }));
  const questionEventModel = drainingPrivacyModel(
    "question",
    {
      raw: records("raw").map((item) => ({
        ...item,
        question: "legacy raw question",
        retentionExpiresAt: new Date("2027-01-01T00:00:00Z"),
      })),
      retention: records("question-orphan"),
    },
    calls,
  );
  const activityModel = drainingPrivacyModel(
    "activity",
    { retention: records("activity-orphan") },
    calls,
  );
  const models = {
    questionEventModel,
    activityModel,
    sessionModel: {
      find() {
        return { select() { return this; }, lean: async () => [] };
      },
    },
    retiredCollections: {
      studentattempts: retiredCollection("studentattempts", records("attempt"), calls),
      studentskillprogresses: retiredCollection("studentskillprogresses", records("progress"), calls),
    },
  };

  const applied = await migrateStudentPrivacy(models, {
    mode: "apply",
    batchSize: 50,
    maxRetiredRecords: 1000,
    maxDurationMs: 30_000,
    now: new Date("2026-07-30T00:00:00Z"),
  });

  assert.equal(applied.scrubbed, 151);
  assert.equal(applied.orphansPurged, 302);
  assert.equal(applied.retiredRawPurged, 302);
  assert.equal(applied.privacyDrain.status, "completed");
  assert.equal(applied.privacyDrain.mutated, 755);
  assert.deepEqual(questionEventModel.remaining(), { raw: 0, retention: 0 });
  assert.deepEqual(activityModel.remaining(), { raw: 0, retention: 0 });
  assert.ok(
    calls
      .filter(([type]) => type.endsWith("-update") || type.endsWith("-delete"))
      .every(([, filter]) => (filter._id?.$in?.length || 1) <= 50),
  );

  const repeated = await migrateStudentPrivacy(models, {
    mode: "apply",
    batchSize: 50,
    maxRetiredRecords: 1000,
    maxDurationMs: 30_000,
  });
  assert.equal(repeated.scrubbed, 0);
  assert.equal(repeated.orphansPurged, 0);
  assert.equal(repeated.retiredRawPurged, 0);
  assert.equal(repeated.privacyDrain.mutated, 0);
});

test("Student privacy apply fails closed when raw and metadata exceed shared max-total", async () => {
  const calls = [];
  const raw = Array.from({ length: 51 }, (_, index) => ({
    _id: `raw-${index + 1}`,
    question: "legacy raw question",
    retentionExpiresAt: new Date("2027-01-01T00:00:00Z"),
  }));
  const questionEventModel = drainingPrivacyModel("question", { raw }, calls);

  await assert.rejects(
    migrateStudentPrivacy(
      {
        questionEventModel,
        activityModel: drainingPrivacyModel("activity", {}, calls),
        sessionModel: { find: () => ({ select() { return this; }, lean: async () => [] }) },
        retiredCollections: {
          studentattempts: retiredCollection("studentattempts", [], calls),
          studentskillprogresses: retiredCollection("studentskillprogresses", [], calls),
        },
      },
      {
        mode: "apply",
        batchSize: 25,
        maxRetiredRecords: 50,
        maxDurationMs: 30_000,
      },
    ),
    (error) => {
      assert.equal(error.code, "STUDENT_PRIVACY_MAX_TOTAL_EXCEEDED");
      assert.equal(error.report.scrubbed, 50);
      assert.equal(error.report.privacyDrain.status, "failed");
      assert.equal(error.report.privacyDrain.reason, "max-total");
      assert.equal(error.report.privacyDrain.mutated, 50);
      return true;
    },
  );
  assert.deepEqual(questionEventModel.remaining(), { raw: 1, retention: 0 });
});

test("Student privacy incomplete mutation report counts records already changed", async () => {
  const { models } = privacyModels({
    rawEvents: [{ _id: "raw-1" }, { _id: "raw-2" }],
  });
  models.questionEventModel.updateMany = async () => ({ modifiedCount: 1 });

  await assert.rejects(
    migrateStudentPrivacy(models, {
      mode: "apply",
      batchSize: 2,
      maxRetiredRecords: 10,
      maxDurationMs: 30_000,
    }),
    (error) => {
      assert.equal(error.code, "STUDENT_PRIVACY_DELETE_INCOMPLETE");
      assert.equal(error.report.scrubbed, 1);
      assert.equal(error.report.privacyDrain.mutated, 1);
      assert.equal(error.report.privacyDrain.status, "failed");
      return true;
    },
  );
});

test("Student privacy cleanup backfills live metadata and purges bounded orphans", async () => {
  const now = new Date("2026-07-30T00:00:00Z");
  const liveRetention = new Date("2026-07-31T00:00:00Z");
  const calls = [];
  const retentionQuery = (documents) => ({
    sort() { return this; },
    limit(value) { calls.push(["limit", value]); return this; },
    select() { return this; },
    lean: async () => documents,
  });
  const model = (name, documents) => {
    let remaining = [...documents];
    return {
      find(filter) {
        const rawScan = filter.$or?.some((item) => "question" in item);
        return retentionQuery(rawScan ? [] : remaining);
      },
      updateMany: async (...args) => {
        calls.push([`${name}-update`, ...args]);
        const id = String(args[0]._id);
        const before = remaining.length;
        remaining = remaining.filter((item) => String(item._id) !== id);
        return { modifiedCount: before - remaining.length };
      },
      deleteMany: async (...args) => {
        calls.push([`${name}-delete`, ...args]);
        const ids = new Set(args[0]._id.$in.map(String));
        const before = remaining.length;
        remaining = remaining.filter((item) => !ids.has(String(item._id)));
        return { deletedCount: before - remaining.length };
      },
    };
  };
  const questionEventModel = model("question", [
    { _id: "orphan-question", sessionId: "missing-session" },
    { _id: "expired-question", sessionId: "expired-session", retentionExpiresAt: now },
  ]);
  const activityModel = model("activity", [
    { _id: "live-activity", sessionId: "live-session" },
  ]);
  const sessionModel = {
    find(filter) {
      const requested = filter._id.$in;
      return {
        select() { return this; },
        lean: async () => requested.includes("live-session")
          ? [{ _id: "live-session", retentionExpiresAt: liveRetention }]
          : [],
      };
    },
  };

  const report = await migrateStudentPrivacy(
    {
      questionEventModel,
      activityModel,
      sessionModel,
      retiredCollections: {
        studentattempts: retiredCollection("studentattempts", [], calls),
        studentskillprogresses: retiredCollection(
          "studentskillprogresses",
          [],
          calls,
        ),
      },
    },
    { mode: "apply", batchSize: 2, now },
  );

  assert.equal(report.backfilled, 1);
  assert.equal(report.orphansPurged, 2);
  assert.ok(calls.every(([type, value]) => type !== "limit" || value === 2));
  assert.deepEqual(
    calls.find(([type]) => type === "question-delete")[1],
    { _id: { $in: ["orphan-question", "expired-question"] } },
  );
  assert.deepEqual(
    calls.find(([type]) => type === "activity-update").slice(1),
    [
      { _id: "live-activity", retentionExpiresAt: { $in: [null] } },
      { $set: { retentionExpiresAt: liveRetention } },
    ],
  );
});

test("Student metadata uses the session retention TTL", () => {
  assert.equal(StudentQuestionEvent.schema.path("retentionExpiresAt").options.expires, 0);
  assert.equal(StudentActivity.schema.path("retentionExpiresAt").options.expires, 0);
});

test("manual session deletion cascades question and activity metadata first", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    deleteOne: async () => order.push("session"),
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    retentionExpiresAt: session.retentionExpiresAt,
  });
  const order = [];
  const originals = {
    findOne: StudentFileSession.findOne,
    findOneAndUpdate: StudentFileSession.findOneAndUpdate,
    questions: StudentQuestionEvent.deleteMany,
    activities: StudentActivity.deleteMany,
  };
  StudentFileSession.findOne = async () => session;
  StudentFileSession.findOneAndUpdate = async (_filter, update) => {
    assert.equal(update.$set.status, "deleting");
    assert.ok(update.$set.deleteStartedAt instanceof Date);
    assert.equal(update.$set.deleteFailureCode, "");
    assert.equal(update.$set.deleteFailedAt, null);
    order.push("session-deleting");
    session.status = "deleting";
    return session;
  };
  StudentQuestionEvent.deleteMany = async () => {
    order.push("questions");
    return { deletedCount: 1 };
  };
  StudentActivity.deleteMany = async () => {
    order.push("activities");
    return { deletedCount: 1 };
  };

  try {
    const response = responseRecorder();
    await deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
      },
      response,
      {
        purgeOperationSession: async () => {
          order.push("converter-purge");
          return {
            success: true,
            session_id: String(session._id),
            upload_id: session.converterUploadId,
            raw_upload_deleted: true,
            local_operation_session_deleted: true,
            remote_operation_session_deleted: true,
            operation_session_deleted: true,
          };
        },
      },
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(order, [
      "session-deleting",
      "converter-purge",
      "questions",
      "activities",
      "session",
    ]);
  } finally {
    StudentFileSession.findOne = originals.findOne;
    StudentFileSession.findOneAndUpdate = originals.findOneAndUpdate;
    StudentQuestionEvent.deleteMany = originals.questions;
    StudentActivity.deleteMany = originals.activities;
  }
});

test("Student delete converter contract is owner-bound and metadata-only", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    targetTemplateId: "bsn_sales",
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    retentionExpiresAt: new Date(Date.now() + 60_000),
  });
  let forwarded;
  const result = await purgeStudentOperationSession(
    {
      requestId: "student-delete-request",
      headers: { "x-student-context": token },
    },
    session,
    async (request) => {
      forwarded = request;
      return {
        status: 200,
        data: {
          success: true,
          session_id: String(session._id),
          upload_id: session.converterUploadId,
          raw_upload_deleted: true,
          local_operation_session_deleted: true,
          remote_operation_session_deleted: true,
          operation_session_deleted: true,
        },
      };
    },
  );

  assert.equal(forwarded.path, `/api/v1/student/sessions/${session._id}/purge`);
  assert.equal(forwarded.method, "DELETE");
  assert.deepEqual(forwarded.body, {});
  const cleanupStudentToken = forwarded.extraHeaders["x-student-context"];
  assert.notEqual(cleanupStudentToken, token);
  const studentClaims = verifyStudentContextToken(cleanupStudentToken, "analyze");
  assert.equal(studentClaims.session_id, String(session._id));
  assert.equal(studentClaims.owner_scope, session.ownerScope);
  const claims = verifyConversionContextToken(forwarded.contextToken);
  assert.equal(claims.operation_session_id, String(session._id));
  assert.equal(claims.conversion_run_id, `student:${session._id}`);
  assert.equal(claims.upload_id, session.converterUploadId);
  assert.equal(JSON.stringify(forwarded).includes("raw-workbook"), false);
  assert.deepEqual(result, {
    success: true,
    session_id: String(session._id),
    upload_id: session.converterUploadId,
    raw_upload_deleted: true,
    local_operation_session_deleted: true,
    remote_operation_session_deleted: true,
    operation_session_deleted: true,
  });
});

test("Student purge never fabricates success without converterUploadId", async () => {
  let forwarded = false;
  await assert.rejects(
    purgeStudentOperationSession(
      { requestId: "student-delete-request" },
      {
        _id: "507f1f77bcf86cd799439011",
        userId: "507f1f77bcf86cd799439012",
        workspaceId: null,
        ownerScope: "user:507f1f77bcf86cd799439012",
        converterUploadId: "",
        targetTemplateId: "bsn_sales",
      },
      async () => {
        forwarded = true;
      },
    ),
    (error) => error.code === "STUDENT_UPLOAD_BINDING_MISSING",
  );
  assert.equal(forwarded, false);
});

test("manual Student delete fails closed when converter purge is unavailable", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    deleteOne: async () => { throw new Error("must not delete parent"); },
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    retentionExpiresAt: session.retentionExpiresAt,
  });
  const originals = {
    findOne: StudentFileSession.findOne,
    findOneAndUpdate: StudentFileSession.findOneAndUpdate,
    questions: StudentQuestionEvent.deleteMany,
    activities: StudentActivity.deleteMany,
  };
  let metadataDeletes = 0;
  StudentFileSession.findOne = async () => session;
  StudentFileSession.findOneAndUpdate = async (_filter, update) => {
    Object.assign(session, update.$set || {});
    return session;
  };
  StudentQuestionEvent.deleteMany = async () => { metadataDeletes += 1; };
  StudentActivity.deleteMany = async () => { metadataDeletes += 1; };

  try {
    const response = responseRecorder();
    await deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
      },
      response,
      {
        purgeOperationSession: async () => {
          const error = new Error("converter unavailable");
          error.code = "CONVERTER_UNREACHABLE";
          throw error;
        },
      },
    );

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body.purge, {
      completed: false,
      code: "CONVERTER_UNREACHABLE",
      pending: true,
      retryable: true,
      status: "delete_failed",
    });
    assert.equal(session.status, "delete_failed");
    assert.equal(metadataDeletes, 0);
  } finally {
    StudentFileSession.findOne = originals.findOne;
    StudentFileSession.findOneAndUpdate = originals.findOneAndUpdate;
    StudentQuestionEvent.deleteMany = originals.questions;
    StudentActivity.deleteMany = originals.activities;
  }
});

test("Student delete marks delete_failed when metadata deletion fails after purge", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    deleteOne: async () => { throw new Error("parent must remain retryable"); },
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    retentionExpiresAt: session.retentionExpiresAt,
  });
  const originals = {
    findOne: StudentFileSession.findOne,
    findOneAndUpdate: StudentFileSession.findOneAndUpdate,
    questions: StudentQuestionEvent.deleteMany,
    activities: StudentActivity.deleteMany,
  };
  StudentFileSession.findOne = async () => session;
  StudentFileSession.findOneAndUpdate = async (_filter, update) => {
    Object.assign(session, update.$set || {});
    return session;
  };
  StudentQuestionEvent.deleteMany = async () => ({ deletedCount: 1 });
  StudentActivity.deleteMany = async () => {
    throw new Error("activity metadata unavailable");
  };

  try {
    const response = responseRecorder();
    await deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
      },
      response,
      {
        purgeOperationSession: async () => ({
          success: true,
          session_id: String(session._id),
          upload_id: session.converterUploadId,
          raw_upload_deleted: true,
          local_operation_session_deleted: true,
          remote_operation_session_deleted: true,
          operation_session_deleted: true,
        }),
      },
    );

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.purge.pending, true);
    assert.equal(response.body.purge.retryable, true);
    assert.equal(response.body.purge.status, "delete_failed");
    assert.equal(response.body.purge.code, "STUDENT_DELETE_FAILED");
    assert.equal(session.status, "delete_failed");
  } finally {
    StudentFileSession.findOne = originals.findOne;
    StudentFileSession.findOneAndUpdate = originals.findOneAndUpdate;
    StudentQuestionEvent.deleteMany = originals.questions;
    StudentActivity.deleteMany = originals.activities;
  }
});

test("owner can retry a stale deleting session with fresh internal cleanup", async () => {
  const now = new Date();
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    status: "deleting",
    deleteStartedAt: new Date(now.getTime() - 10 * 60_000),
    retentionExpiresAt: new Date(now.getTime() + 60_000),
    deleteOne: async () => { session.deleted = true; },
  };
  const originals = {
    findOne: StudentFileSession.findOne,
    findOneAndUpdate: StudentFileSession.findOneAndUpdate,
    questions: StudentQuestionEvent.deleteMany,
    activities: StudentActivity.deleteMany,
  };
  StudentFileSession.findOne = async () => session;
  StudentFileSession.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.status, "deleting");
    assert.ok(filter.deleteStartedAt.$lte instanceof Date);
    Object.assign(session, update.$set || {});
    return session;
  };
  StudentQuestionEvent.deleteMany = async () => ({ deletedCount: 0 });
  StudentActivity.deleteMany = async () => ({ deletedCount: 0 });

  try {
    const response = responseRecorder();
    await deleteStudentSession(
      { params: { id: session._id }, user: { _id: session.userId }, headers: {} },
      response,
      {
        now: () => now,
        purgeOperationSession: async () => ({
          success: true,
          session_id: String(session._id),
          upload_id: session.converterUploadId,
          raw_upload_deleted: true,
          local_operation_session_deleted: true,
          remote_operation_session_deleted: true,
          operation_session_deleted: true,
        }),
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(session.deleted, true);
  } finally {
    StudentFileSession.findOne = originals.findOne;
    StudentFileSession.findOneAndUpdate = originals.findOneAndUpdate;
    StudentQuestionEvent.deleteMany = originals.questions;
    StudentActivity.deleteMany = originals.activities;
  }
});

test("owner retries delete_failed with an expired old context and fresh internal binding", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    status: "delete_failed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    deleteOne: async () => { session.deleted = true; },
  };
  const expiredContext = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    expiresIn: "-1s",
    retentionExpiresAt: session.retentionExpiresAt,
  });
  const originals = {
    findOne: StudentFileSession.findOne,
    findOneAndUpdate: StudentFileSession.findOneAndUpdate,
    questions: StudentQuestionEvent.deleteMany,
    activities: StudentActivity.deleteMany,
  };
  const updates = [];
  StudentFileSession.findOne = async () => session;
  StudentFileSession.findOneAndUpdate = async (filter, update) => {
    updates.push({ filter, update });
    if (filter.status !== session.status) return null;
    Object.assign(session, update.$set || {});
    return session;
  };
  StudentQuestionEvent.deleteMany = async () => ({ deletedCount: 1 });
  StudentActivity.deleteMany = async () => ({ deletedCount: 1 });

  try {
    const response = responseRecorder();
    await deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": expiredContext },
      },
      response,
      {
        purgeOperationSession: async () => ({
          success: true,
          session_id: String(session._id),
          upload_id: session.converterUploadId,
          raw_upload_deleted: true,
          local_operation_session_deleted: true,
          remote_operation_session_deleted: true,
          operation_session_deleted: true,
        }),
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(session.deleted, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].filter.status, "delete_failed");
    assert.equal(updates[0].update.$set.status, "deleting");
  } finally {
    StudentFileSession.findOne = originals.findOne;
    StudentFileSession.findOneAndUpdate = originals.findOneAndUpdate;
    StudentQuestionEvent.deleteMany = originals.questions;
    StudentActivity.deleteMany = originals.activities;
  }
});

test("concurrent delete_failed retry permits only one purge owner", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    status: "delete_failed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    deleteOne: async () => {},
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    retentionExpiresAt: session.retentionExpiresAt,
  });
  const originals = {
    findOne: StudentFileSession.findOne,
    findOneAndUpdate: StudentFileSession.findOneAndUpdate,
    questions: StudentQuestionEvent.deleteMany,
    activities: StudentActivity.deleteMany,
  };
  let purgeCalls = 0;
  let startPurge;
  let releasePurge;
  const purgeStarted = new Promise((resolve) => { startPurge = resolve; });
  const purgeBlocked = new Promise((resolve) => { releasePurge = resolve; });
  StudentFileSession.findOne = async () => session;
  StudentFileSession.findOneAndUpdate = async (filter, update) => {
    const matches = typeof filter.status === "string"
      ? filter.status === session.status
      : !filter.status?.$nin?.includes(session.status);
    if (!matches) return null;
    Object.assign(session, update.$set || {});
    return session;
  };
  StudentQuestionEvent.deleteMany = async () => ({ deletedCount: 0 });
  StudentActivity.deleteMany = async () => ({ deletedCount: 0 });
  const purgeOperationSession = async () => {
    purgeCalls += 1;
    if (purgeCalls === 1) {
      startPurge();
      await purgeBlocked;
    }
    return {
      success: true,
      session_id: String(session._id),
      upload_id: session.converterUploadId,
      raw_upload_deleted: true,
      local_operation_session_deleted: true,
      remote_operation_session_deleted: true,
      operation_session_deleted: true,
    };
  };

  try {
    const firstResponse = responseRecorder();
    const first = deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
      },
      firstResponse,
      { purgeOperationSession },
    );
    await purgeStarted;

    const concurrentResponse = responseRecorder();
    await deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
      },
      concurrentResponse,
      { purgeOperationSession },
    );
    assert.equal(concurrentResponse.statusCode, 409);
    assert.equal(purgeCalls, 1);

    releasePurge();
    await first;
    assert.equal(firstResponse.statusCode, 200);
  } finally {
    releasePurge();
    StudentFileSession.findOne = originals.findOne;
    StudentFileSession.findOneAndUpdate = originals.findOneAndUpdate;
    StudentQuestionEvent.deleteMany = originals.questions;
    StudentActivity.deleteMany = originals.activities;
  }
});

test("refresh reports delete_failed as retryable without issuing usable context", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    status: "delete_failed",
    deleteFailureCode: "CONVERTER_UNREACHABLE",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    file: { originalName: "sales.xlsx", sizeBytes: 1, rawRetained: false },
  };
  const originalFindOne = StudentFileSession.findOne;
  StudentFileSession.findOne = async () => session;
  try {
    const response = responseRecorder();
    await refreshStudentContext(
      { params: { id: session._id }, user: { _id: session.userId }, headers: {} },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.contextToken, null);
    assert.equal(response.body.session.status, "delete_failed");
    assert.deepEqual(response.body.purge, {
      completed: false,
      pending: true,
      retryable: true,
      status: "delete_failed",
      code: "CONVERTER_UNREACHABLE",
    });
  } finally {
    StudentFileSession.findOne = originalFindOne;
  }
});

test("refresh truthfully reports stale deleting as retryable without context", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    status: "deleting",
    deleteStartedAt: new Date(Date.now() - 10 * 60_000),
    retentionExpiresAt: new Date(Date.now() + 60_000),
    file: { originalName: "sales.xlsx", sizeBytes: 1, rawRetained: false },
  };
  const originalFindOne = StudentFileSession.findOne;
  StudentFileSession.findOne = async () => session;
  try {
    const response = responseRecorder();
    await refreshStudentContext(
      { params: { id: session._id }, user: { _id: session.userId }, headers: {} },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.contextToken, null);
    assert.deepEqual(response.body.purge, {
      completed: false,
      pending: true,
      retryable: true,
      status: "deleting",
      code: "STUDENT_DELETE_STALE",
    });
  } finally {
    StudentFileSession.findOne = originalFindOne;
  }
});

test("bounded Student deletion sweeper retries stale jobs with fresh cleanup", async () => {
  const now = new Date("2026-07-31T00:10:00.000Z");
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "student-upload-1",
    targetTemplateId: "bsn_sales",
    status: "deleting",
    deleteStartedAt: new Date("2026-07-31T00:00:00.000Z"),
  };
  let queryLimit;
  let parentDeletes = 0;
  const sessionModel = {
    find() {
      return {
        sort() { return this; },
        limit(value) { queryLimit = value; return this; },
        select() { return this; },
        lean: async () => [{ _id: session._id, status: session.status }],
      };
    },
    async findOneAndUpdate(_filter, update) {
      Object.assign(session, update.$set || {});
      return session;
    },
    async deleteOne() {
      parentDeletes += 1;
      return { deletedCount: 1 };
    },
  };
  let purgeCalls = 0;
  const report = await sweepStaleStudentDeletions({
    now: () => now,
    limit: 2,
    sessionModel,
    questionModel: { deleteMany: async () => ({ deletedCount: 0 }) },
    activityModel: { deleteMany: async () => ({ deletedCount: 0 }) },
    purgeOperationSession: async (_req, deletingSession) => {
      purgeCalls += 1;
      return {
        success: true,
        session_id: String(deletingSession._id),
        upload_id: deletingSession.converterUploadId,
        raw_upload_deleted: true,
        local_operation_session_deleted: true,
        remote_operation_session_deleted: true,
        operation_session_deleted: true,
      };
    },
  });

  assert.equal(queryLimit, 2);
  assert.equal(purgeCalls, 1);
  assert.equal(parentDeletes, 1);
  assert.deepEqual(report, { scanned: 1, deleted: 1, failed: 0 });
});

test("delete racing authorized question and activity writes leaves no orphan", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const sessionId = "507f1f77bcf86cd799439011";
  const userId = "507f1f77bcf86cd799439012";
  const retentionExpiresAt = new Date(Date.now() + 60_000);
  const token = createStudentContextToken({
    sessionId,
    userId,
    ownerScope: `user:${userId}`,
    allowedScopes: ["analyze", "ask", "accounting_map"],
    retentionExpiresAt,
  });
  const cases = [
    {
      name: "question",
      handler: recordStudentQuestionEvent,
      model: StudentQuestionEvent,
      body: {
        event: "question_answered",
        questionHash: hashStudentQuestion("Có bao nhiêu hóa đơn?"),
        questionLength: "Có bao nhiêu hóa đơn?".length,
        category: "count_documents",
        operation: "ask",
        answerType: "deterministic_file_query",
        evidenceIds: [],
        evidenceCount: 0,
        outcome: "supported",
      },
    },
    {
      name: "activity",
      handler: recordStudentActivity,
      model: StudentActivity,
      body: {
        eventType: "accounting_map_reviewed",
        evidenceCount: 0,
        containsRawValues: false,
      },
    },
  ];

  for (const item of cases) {
    let parentExists = true;
    let releaseInsert;
    let signalInsert;
    const insertBlocked = new Promise((resolve) => { releaseInsert = resolve; });
    const insertStarted = new Promise((resolve) => { signalInsert = resolve; });
    const orphans = new Set();
    const session = {
      _id: sessionId,
      userId,
      workspaceId: null,
      ownerScope: `user:${userId}`,
      converterUploadId: "upload-1",
      status: "analyzed",
      retentionExpiresAt,
      deleteOne: async () => { parentExists = false; },
    };
    const originals = {
      findOne: StudentFileSession.findOne,
      findOneAndUpdate: StudentFileSession.findOneAndUpdate,
      questionCreate: StudentQuestionEvent.create,
      questionDeleteMany: StudentQuestionEvent.deleteMany,
      questionDeleteOne: StudentQuestionEvent.deleteOne,
      activityCreate: StudentActivity.create,
      activityDeleteMany: StudentActivity.deleteMany,
      activityDeleteOne: StudentActivity.deleteOne,
    };
    StudentFileSession.findOne = async (filter) => (
      filter.status && !parentExists ? null : session
    );
    StudentFileSession.findOneAndUpdate = async () => {
      session.status = "deleting";
      return session;
    };
    item.model.create = async (payload) => {
      signalInsert();
      await insertBlocked;
      const id = `${item.name}-event`;
      orphans.add(id);
      return { _id: id, createdAt: new Date(0), ...payload };
    };
    item.model.deleteOne = async (filter) => {
      orphans.delete(String(filter._id));
      return { deletedCount: 1 };
    };
    StudentQuestionEvent.deleteMany = async () => {
      if (item.model === StudentQuestionEvent) orphans.clear();
      return { deletedCount: 0 };
    };
    StudentActivity.deleteMany = async () => {
      if (item.model === StudentActivity) orphans.clear();
      return { deletedCount: 0 };
    };

    try {
      const writeResponse = responseRecorder();
      const write = item.handler(
        {
          params: { id: sessionId },
          headers: {
            "x-converter-service-token": "converter-service-secret",
            "x-student-context": token,
          },
          body: item.body,
        },
        writeResponse,
      );
      await insertStarted;

      const deleteResponse = responseRecorder();
      await deleteStudentSession(
        {
          params: { id: sessionId },
          user: { _id: userId },
          headers: { "x-student-context": token },
        },
        deleteResponse,
        {
          purgeOperationSession: async () => ({
            success: true,
            session_id: sessionId,
            upload_id: session.converterUploadId,
            raw_upload_deleted: true,
            local_operation_session_deleted: true,
            remote_operation_session_deleted: true,
            operation_session_deleted: true,
          }),
        },
      );
      assert.equal(deleteResponse.statusCode, 200);
      releaseInsert();
      await write;

      assert.equal(writeResponse.statusCode, 409);
      assert.equal(orphans.size, 0);
    } finally {
      releaseInsert();
      StudentFileSession.findOne = originals.findOne;
      StudentFileSession.findOneAndUpdate = originals.findOneAndUpdate;
      StudentQuestionEvent.create = originals.questionCreate;
      StudentQuestionEvent.deleteMany = originals.questionDeleteMany;
      StudentQuestionEvent.deleteOne = originals.questionDeleteOne;
      StudentActivity.create = originals.activityCreate;
      StudentActivity.deleteMany = originals.activityDeleteMany;
      StudentActivity.deleteOne = originals.activityDeleteOne;
    }
  }
});

function startupOptions(overrides = {}) {
  return {
    connectDatabase: async () => ({}),
    migrateMappingProfiles: async () => ({ skipped: true }),
    migrateMappingProfilesV2: async () => ({ skipped: true }),
    listen: () => ({ once() {} }),
    logger: { error() {}, log() {} },
    startStudentDeletionSweeper: () => null,
    ...overrides,
  };
}

test("Student startup wires stale deletion retry sweeper only when enabled", async () => {
  let starts = 0;
  await createStartServer(startupOptions({
    studentEnabled: true,
    startStudentDeletionSweeper: () => {
      starts += 1;
      return { stop() {} };
    },
  }))();
  assert.equal(starts, 1);

  await createStartServer(startupOptions({
    studentEnabled: false,
    startStudentDeletionSweeper: () => {
      starts += 1;
      return { stop() {} };
    },
  }))();
  assert.equal(starts, 1);
});

test("feature-off startup performs zero Student migration or model loading", async () => {
  const previousMode = process.env.STUDENT_PRIVACY_MIGRATION_MODE;
  process.env.STUDENT_PRIVACY_MIGRATION_MODE = "apply";
  let migrationCalls = 0;
  let modelLoads = 0;
  const migration = async () => {
    migrationCalls += 1;
    return { mode: "apply" };
  };
  try {
    await createStartServer(startupOptions({
      studentEnabled: false,
      migrateQuestionEvents: migration,
      migrateStudentPrivacy: migration,
      loadStudentPrivacyModels: () => {
        modelLoads += 1;
        return {};
      },
    }))();
    assert.equal(migrationCalls, 0);
    assert.equal(modelLoads, 0);
  } finally {
    if (previousMode === undefined) delete process.env.STUDENT_PRIVACY_MIGRATION_MODE;
    else process.env.STUDENT_PRIVACY_MIGRATION_MODE = previousMode;
  }
});

test("Student privacy migration defaults off and active modes fail closed", async () => {
  const previousMode = process.env.STUDENT_PRIVACY_MIGRATION_MODE;
  const previousMaxTotal = process.env.STUDENT_PRIVACY_MIGRATION_MAX_TOTAL;
  const previousMaxDuration = process.env.STUDENT_PRIVACY_MIGRATION_MAX_DURATION_MS;
  let calls = 0;
  let listenCalls = 0;
  const errorLogs = [];
  const failureReport = {
    mode: "dry-run",
    retiredDrain: { status: "failed", reason: "time-limit" },
  };
  const migration = async (_models, { mode, maxRetiredRecords, maxDurationMs }) => {
    calls += 1;
    assert.equal(mode, "dry-run");
    assert.equal(maxRetiredRecords, "100");
    assert.equal(maxDurationMs, "1500");
    const error = new Error("privacy migration failed");
    error.report = failureReport;
    throw error;
  };
  try {
    delete process.env.STUDENT_PRIVACY_MIGRATION_MODE;
    await createStartServer(startupOptions({
      studentEnabled: true,
      migrateQuestionEvents: migration,
      migrateStudentPrivacy: migration,
      loadStudentPrivacyModels: () => ({}),
    }))();
    assert.equal(calls, 0);

    process.env.STUDENT_PRIVACY_MIGRATION_MODE = "dry-run";
    process.env.STUDENT_PRIVACY_MIGRATION_MAX_TOTAL = "100";
    process.env.STUDENT_PRIVACY_MIGRATION_MAX_DURATION_MS = "1500";
    await assert.rejects(
      createStartServer(startupOptions({
        studentEnabled: true,
        migrateQuestionEvents: migration,
        migrateStudentPrivacy: migration,
        loadStudentPrivacyModels: () => ({}),
        listen: () => {
          listenCalls += 1;
          return { once() {} };
        },
        logger: {
          error(message) { errorLogs.push(JSON.parse(message)); },
          log() {},
        },
      }))(),
      /privacy migration failed/,
    );
    assert.equal(calls, 1);
    assert.equal(listenCalls, 0);
    assert.deepEqual(errorLogs, [{
      event: "student-privacy-migration-failed",
      report: failureReport,
    }]);
  } finally {
    if (previousMode === undefined) delete process.env.STUDENT_PRIVACY_MIGRATION_MODE;
    else process.env.STUDENT_PRIVACY_MIGRATION_MODE = previousMode;
    if (previousMaxTotal === undefined) {
      delete process.env.STUDENT_PRIVACY_MIGRATION_MAX_TOTAL;
    } else {
      process.env.STUDENT_PRIVACY_MIGRATION_MAX_TOTAL = previousMaxTotal;
    }
    if (previousMaxDuration === undefined) {
      delete process.env.STUDENT_PRIVACY_MIGRATION_MAX_DURATION_MS;
    } else {
      process.env.STUDENT_PRIVACY_MIGRATION_MAX_DURATION_MS = previousMaxDuration;
    }
  }
});
