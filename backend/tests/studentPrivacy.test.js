const assert = require("node:assert/strict");
const test = require("node:test");

const StudentActivity = require("../models/StudentActivity");
const StudentFileSession = require("../models/StudentFileSession");
const StudentQuestionEvent = require("../models/StudentQuestionEvent");
const {
  deleteStudentSession,
  recordStudentActivity,
  recordStudentQuestionEvent,
} = require("../controllers/studentSessionController");
const { createStudentContextToken } = require("../services/conversionContextService");
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

function privacyModels({
  rawEvents = [],
  retiredAttempts = [],
  retiredProgresses = [],
} = {}) {
  const calls = [];
  const questionEventModel = {
    find(filter) {
      calls.push(["question-find", filter]);
      const scansRawFields = filter.$or?.some((item) => "question" in item);
      return emptyQuery(calls, scansRawFields ? rawEvents : []);
    },
    updateMany: async (...args) => {
      calls.push(["question-update", ...args]);
      return { modifiedCount: rawEvents.length };
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
  const model = (name, documents) => ({
    find(filter) {
      const rawScan = filter.$or?.some((item) => "question" in item);
      return retentionQuery(rawScan ? [] : documents);
    },
    updateMany: async (...args) => {
      calls.push([`${name}-update`, ...args]);
      return { modifiedCount: 1 };
    },
    deleteMany: async (...args) => {
      calls.push([`${name}-delete`, ...args]);
      return { deletedCount: args[0]._id.$in.length };
    },
  });
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
    assert.deepEqual(update, { $set: { status: "deleting" } });
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
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(order, [
      "session-deleting",
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
    ...overrides,
  };
}

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
  let calls = 0;
  let listenCalls = 0;
  const migration = async (_models, { mode }) => {
    calls += 1;
    assert.equal(mode, "dry-run");
    throw new Error("privacy migration failed");
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
      }))(),
      /privacy migration failed/,
    );
    assert.equal(calls, 1);
    assert.equal(listenCalls, 0);
  } finally {
    if (previousMode === undefined) delete process.env.STUDENT_PRIVACY_MIGRATION_MODE;
    else process.env.STUDENT_PRIVACY_MIGRATION_MODE = previousMode;
  }
});
