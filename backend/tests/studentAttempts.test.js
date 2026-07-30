const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const StudentAttempt = require("../models/StudentAttempt");
const StudentFileSession = require("../models/StudentFileSession");
const StudentSkillProgress = require("../models/StudentSkillProgress");
const { createStudentContextToken } = require("../services/conversionContextService");
const { createConnectDB } = require("../config/db");
const {
  createStudentAttemptPersistence,
} = require("../services/studentAttemptPersistenceService");
const {
  ensureStudentAttemptPersistence,
} = require("../services/studentAttemptMigrationService");
const {
  buildStudentAttemptIdentity,
  cleanAttemptCompletedPayload,
  deleteStudentSession,
  getStudentAttempts,
  recordStudentAttempt,
  recordStudentHint,
} = require("../controllers/studentSessionController");

process.env.CONVERSION_CONTEXT_SECRET = "test-student-attempt-secret";

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

function attemptToken(overrides = {}) {
  return createStudentContextToken({
    sessionId: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    ownerScope: "user:507f1f77bcf86cd799439012",
    workspaceId: null,
    allowedScopes: ["analyze", "explain", "attempt"],
    ...overrides,
  });
}

function activeSession() {
  return {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "upload-1",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createQuery(resolveValue) {
  let mongoSession = null;
  let sort = null;
  return {
    session(value) {
      mongoSession = value;
      return this;
    },
    sort(value) {
      sort = value;
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve()
        .then(() => resolveValue({ mongoSession, sort }))
        .then(resolve, reject);
    },
  };
}

function cloneState(state) {
  return {
    attempts: state.attempts.map((attempt) => ({ ...attempt })),
    progress: state.progress
      ? { ...state.progress, skills: structuredClone(state.progress.skills) }
      : null,
  };
}

function createPersistenceHarness({ concurrent = false, retryCallback = false } = {}) {
  const committed = { attempts: [], progress: null };
  const bothCreatesStarted = deferred();
  let createCalls = 0;
  let transactionCallbacks = 0;
  let failAttempt = null;
  let failProgress = null;

  function stateFor(mongoSession) {
    return mongoSession?.state || committed;
  }

  const AttemptModel = {
    findOne(filter) {
      return createQuery(({ mongoSession, sort }) => {
        const matches = stateFor(mongoSession).attempts.filter((attempt) =>
          Object.entries(filter).every(([key, value]) => String(attempt[key]) === String(value)),
        );
        if (sort?.revision === -1) {
          return matches.sort((left, right) => right.revision - left.revision)[0] || null;
        }
        return matches[0] || null;
      });
    },
    async create(documents, { session }) {
      if (failAttempt) throw failAttempt;
      createCalls += 1;
      if (concurrent && createCalls <= 2) {
        if (createCalls === 2) bothCreatesStarted.resolve();
        await bothCreatesStarted.promise;
      }
      const [document] = documents;
      const attempt = {
        _id: `attempt-${createCalls}`,
        createdAt: new Date("2026-07-30T00:00:00Z"),
        ...document,
      };
      session.state.attempts.push(attempt);
      return [attempt];
    },
  };
  const ProgressModel = {
    findOne(filter) {
      return createQuery(({ mongoSession }) => {
        const progress = stateFor(mongoSession).progress;
        return progress && String(progress.userId) === String(filter.userId) ? progress : null;
      });
    },
    async findOneAndUpdate(filter, update, options) {
      if (failProgress) throw failProgress;
      const state = options.session.state;
      const skillPath = Object.keys(update.$set).find((key) => key.endsWith(".score"));
      const skill = skillPath.split(".")[1];
      const previous = state.progress?.skills?.[skill] || { score: 0, evidenceCount: 0 };
      state.progress = {
        userId: filter.userId,
        skills: {
          ...(state.progress?.skills || {}),
          [skill]: {
            score: update.$set[skillPath],
            evidenceCount:
              previous.evidenceCount + update.$inc[`skills.${skill}.evidenceCount`],
          },
        },
      };
      return state.progress;
    },
  };

  async function startSession() {
    const baseAttemptIds = new Set(committed.attempts.map((attempt) => attempt._id));
    return {
      state: cloneState(committed),
      async withTransaction(callback) {
        transactionCallbacks += 1;
        if (retryCallback && transactionCallbacks === 1) {
          await callback();
          this.state = cloneState(committed);
          transactionCallbacks += 1;
        }
        const result = await callback();
        for (const candidate of this.state.attempts) {
          if (baseAttemptIds.has(candidate._id)) continue;
          const duplicate = committed.attempts.find((attempt) =>
            String(attempt.sessionId) === String(candidate.sessionId) &&
            (attempt.idempotencyKeyHash === candidate.idempotencyKeyHash ||
              attempt.revision === candidate.revision),
          );
          if (duplicate) {
            const error = new Error("E11000 duplicate key");
            error.code = 11000;
            throw error;
          }
        }
        committed.attempts = this.state.attempts.map((attempt) => ({ ...attempt }));
        committed.progress = this.state.progress
          ? { ...this.state.progress, skills: structuredClone(this.state.progress.skills) }
          : null;
        return result;
      },
      async endSession() {},
    };
  }

  return {
    committed,
    failAttempt(error) {
      failAttempt = error;
    },
    failProgress(error) {
      failProgress = error;
    },
    get transactionCallbacks() {
      return transactionCallbacks;
    },
    persistence: createStudentAttemptPersistence({
      AttemptModel,
      ProgressModel,
      assertTransactionsReady() {},
      startSession,
    }),
  };
}

function validAttemptPayload() {
  return cleanAttemptCompletedPayload({
    event: "attempt_completed",
    kind: "mapping_attempt",
    submittedStateHash: "submitted-hash",
    sessionStateHash: "state-hash",
    rubricVersion: "student-v1",
    score: 82.5,
    completed: true,
    deterministic: true,
    summary: {
      issueIds: ["issue-1"],
      evidenceCount: 4,
      breakdown: [{ category: "mapping", earned: 20, maxScore: 30 }],
    },
  });
}

test("attempt payload keeps deterministic metadata and rejects raw rows", () => {
  assert.deepEqual(
    cleanAttemptCompletedPayload({
      event: "attempt_completed",
      kind: "mapping_attempt",
      submittedStateHash: " submitted-hash ",
      sessionStateHash: " state-hash ",
      rubricVersion: "student-v1",
      score: "82.5",
      completed: true,
      deterministic: true,
      summary: {
        issueIds: [" issue-1 ", "issue-2"],
        evidenceCount: 4,
        breakdown: [{ category: "mapping", earned: 20, maxScore: 30 }],
        rawRows: [{ confidential: true }],
        expected: { account: "131" },
      },
      rows: [{ confidential: true }],
    }),
    {
      event: "attempt_completed",
      kind: "mapping_attempt",
      submittedStateHash: "submitted-hash",
      sessionStateHash: "state-hash",
      rubricVersion: "student-v1",
      score: 82.5,
      completed: true,
      deterministic: true,
      summary: {
        issueIds: ["issue-1", "issue-2"],
        evidenceCount: 4,
        breakdown: [{ category: "mapping", earned: 20, maxScore: 30 }],
      },
    },
  );
});

test("attempt and progress schemas store metadata without raw workbook rows", () => {
  for (const field of ["revision", "kind", "submittedStateHash", "sessionStateHash", "score"]) {
    assert.equal(StudentAttempt.schema.path(field).options.immutable, true);
  }
  assert.equal(StudentAttempt.schema.path("rawRows"), undefined);
  assert.equal(StudentAttempt.schema.path("submitted"), undefined);
  assert.equal(StudentAttempt.schema.path("expected"), undefined);
  assert.equal(StudentSkillProgress.schema.path("rawRows"), undefined);
  assert.equal(StudentSkillProgress.schema.path("skills").instance, "Map");
});

test("attempt retention and idempotency indexes prevent permanent or duplicate records", () => {
  const retention = StudentAttempt.schema.path("retentionExpiresAt");
  assert.equal(retention.options.required, true);
  assert.equal(retention.options.immutable, true);
  assert.equal(retention.options.expires, 0);
  assert.equal(StudentAttempt.schema.path("idempotencyKeyHash").options.immutable, true);
  assert.equal(StudentAttempt.schema.path("requestFingerprint").options.immutable, true);

  const indexes = StudentAttempt.schema.indexes();
  assert.ok(indexes.some(([keys, options]) =>
    keys.sessionId === 1 && keys.idempotencyKeyHash === 1 && options.unique === true,
  ));
  assert.ok(indexes.some(([keys, options]) =>
    keys.sessionId === 1 && keys.revision === 1 && options.unique === true,
  ));
});

test("attempt identity is stable for retries and detects key reuse with changed payload", () => {
  const payload = validAttemptPayload();
  const first = buildStudentAttemptIdentity(payload, "retry-key");
  const repeated = buildStudentAttemptIdentity(structuredClone(payload), "retry-key");
  const changed = buildStudentAttemptIdentity({ ...payload, score: 99 }, "retry-key");

  assert.deepEqual(first, repeated);
  assert.equal(first.idempotencyKeyHash, changed.idempotencyKeyHash);
  assert.notEqual(first.requestFingerprint, changed.requestFingerprint);
  assert.match(first.idempotencyKeyHash, /^[a-f0-9]{64}$/);

  const natural = buildStudentAttemptIdentity(payload);
  const changedDeterministicResult = buildStudentAttemptIdentity({ ...payload, score: 99 });
  assert.equal(natural.idempotencyKeyHash, changedDeterministicResult.idempotencyKeyHash);
  assert.notEqual(natural.requestFingerprint, changedDeterministicResult.requestFingerprint);
});

test("attempt persistence makes retries idempotent without double-counting progress", async () => {
  const harness = createPersistenceHarness();
  const input = {
    session: activeSession(),
    payload: validAttemptPayload(),
    identity: buildStudentAttemptIdentity(validAttemptPayload(), "retry-key"),
  };

  const created = await harness.persistence.persistCompletion(input);
  const repeated = await harness.persistence.persistCompletion(input);

  assert.equal(created.idempotent, false);
  assert.equal(repeated.idempotent, true);
  assert.equal(harness.committed.attempts.length, 1);
  assert.equal(harness.committed.progress.skills.excel_mapping.evidenceCount, 4);
  assert.equal(
    harness.committed.attempts[0].retentionExpiresAt.getTime(),
    input.session.retentionExpiresAt.getTime(),
  );
});

test("concurrent duplicate completions commit one attempt and one progress increment", async () => {
  const harness = createPersistenceHarness({ concurrent: true });
  const input = {
    session: activeSession(),
    payload: validAttemptPayload(),
    identity: buildStudentAttemptIdentity(validAttemptPayload(), "concurrent-key"),
  };

  const results = await Promise.all([
    harness.persistence.persistCompletion(input),
    harness.persistence.persistCompletion(input),
  ]);

  assert.deepEqual(results.map((result) => result.idempotent).sort(), [false, true]);
  assert.equal(harness.committed.attempts.length, 1);
  assert.equal(harness.committed.progress.skills.excel_mapping.evidenceCount, 4);
});

test("concurrent distinct completions retry revision allocation without lost progress", async () => {
  const harness = createPersistenceHarness({ concurrent: true });
  const firstPayload = validAttemptPayload();
  const secondPayload = {
    ...validAttemptPayload(),
    submittedStateHash: "second-submitted-hash",
    score: 91,
  };

  await Promise.all([
    harness.persistence.persistCompletion({
      session: activeSession(),
      payload: firstPayload,
      identity: buildStudentAttemptIdentity(firstPayload, "first-concurrent-key"),
    }),
    harness.persistence.persistCompletion({
      session: activeSession(),
      payload: secondPayload,
      identity: buildStudentAttemptIdentity(secondPayload, "second-concurrent-key"),
    }),
  ]);

  assert.deepEqual(
    harness.committed.attempts.map((attempt) => attempt.revision).sort(),
    [1, 2],
  );
  assert.equal(harness.committed.progress.skills.excel_mapping.evidenceCount, 8);
});

test("idempotency key reuse with changed completion is rejected without mutation", async () => {
  const harness = createPersistenceHarness();
  const firstPayload = validAttemptPayload();
  const changedPayload = { ...validAttemptPayload(), score: 99 };
  await harness.persistence.persistCompletion({
    session: activeSession(),
    payload: firstPayload,
    identity: buildStudentAttemptIdentity(firstPayload, "reused-key"),
  });

  await assert.rejects(
    harness.persistence.persistCompletion({
      session: activeSession(),
      payload: changedPayload,
      identity: buildStudentAttemptIdentity(changedPayload, "reused-key"),
    }),
    (error) => error.statusCode === 409,
  );
  assert.equal(harness.committed.attempts.length, 1);
  assert.equal(harness.committed.progress.skills.excel_mapping.evidenceCount, 4);
});

test("Mongo transaction callback retry does not duplicate attempt progress", async () => {
  const harness = createPersistenceHarness({ retryCallback: true });
  await harness.persistence.persistCompletion({
    session: activeSession(),
    payload: validAttemptPayload(),
    identity: buildStudentAttemptIdentity(validAttemptPayload(), "transaction-retry-key"),
  });

  assert.equal(harness.transactionCallbacks, 2);
  assert.equal(harness.committed.attempts.length, 1);
  assert.equal(harness.committed.progress.skills.excel_mapping.evidenceCount, 4);
});

test("attempt or progress write failure rolls the whole completion back", async () => {
  for (const failedWrite of ["attempt", "progress"]) {
    const harness = createPersistenceHarness();
    harness[failedWrite === "attempt" ? "failAttempt" : "failProgress"](
      new Error(`${failedWrite} failed`),
    );
    await assert.rejects(
      harness.persistence.persistCompletion({
        session: activeSession(),
        payload: validAttemptPayload(),
        identity: buildStudentAttemptIdentity(validAttemptPayload(), `${failedWrite}-failure-key`),
      }),
      new RegExp(`${failedWrite} failed`),
    );
    assert.equal(harness.committed.attempts.length, 0);
    assert.equal(harness.committed.progress, null);
  }
});

test("attempt migration purges unbounded legacy rows and creates retention/idempotency indexes", async () => {
  const calls = { deletes: [], indexes: [] };
  const model = {
    collection: {
      async deleteMany(filter) {
        calls.deletes.push(filter);
        return { deletedCount: 3 };
      },
      async createIndex(keys, options) {
        calls.indexes.push({ keys, options });
      },
    },
  };

  const result = await ensureStudentAttemptPersistence(model, {
    now: new Date("2026-07-30T00:00:00Z"),
  });

  assert.equal(result.purged, 3);
  assert.match(JSON.stringify(calls.deletes[0]), /retentionExpiresAt/);
  assert.match(JSON.stringify(calls.deletes[0]), /idempotencyKeyHash/);
  assert.ok(calls.indexes.some(({ keys, options }) =>
    keys.retentionExpiresAt === 1 && options.expireAfterSeconds === 0,
  ));
  assert.ok(calls.indexes.some(({ keys, options }) =>
    keys.sessionId === 1 && keys.idempotencyKeyHash === 1 && options.unique === true,
  ));
});

test("manual student session deletion purges attempts before deleting session metadata", async () => {
  const session = activeSession();
  const originalSessionFind = StudentFileSession.findOne;
  const originalAttemptDelete = StudentAttempt.deleteMany;
  const order = [];
  session.deleteOne = async () => order.push("session");
  StudentFileSession.findOne = async () => session;
  StudentAttempt.deleteMany = async (filter) => {
    order.push("attempts");
    assert.equal(String(filter.sessionId), session._id);
    assert.equal(String(filter.userId), session.userId);
    assert.equal(filter.ownerScope, session.ownerScope);
  };
  try {
    const response = responseRecorder();
    await deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": attemptToken() },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(order, ["attempts", "session"]);
  } finally {
    StudentFileSession.findOne = originalSessionFind;
    StudentAttempt.deleteMany = originalAttemptDelete;
  }
});

test("manual session deletion keeps metadata when attempt purge fails", async () => {
  const session = activeSession();
  const originalSessionFind = StudentFileSession.findOne;
  const originalAttemptDelete = StudentAttempt.deleteMany;
  let sessionDeleted = false;
  session.deleteOne = async () => {
    sessionDeleted = true;
  };
  StudentFileSession.findOne = async () => session;
  StudentAttempt.deleteMany = async () => {
    throw new Error("attempt purge failed");
  };
  try {
    const response = responseRecorder();
    await deleteStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": attemptToken() },
      },
      response,
    );
    assert.equal(response.statusCode, 500);
    assert.equal(sessionDeleted, false);
  } finally {
    StudentFileSession.findOne = originalSessionFind;
    StudentAttempt.deleteMany = originalAttemptDelete;
  }
});

test("completed deterministic attempts create an immutable revision and update progress", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  await createConnectDB({
    env: { MONGO_URI: "mongodb://mongo.test:27017/ezformat" },
    dnsResolver: { resolveSrv: async () => {} },
    logger: { error() {}, log() {}, warn() {} },
    ensureCouponUsagePaymentUniqueIndex: async () => {},
    mongooseInstance: {
      connect: async () => ({
        connection: {
          host: "mongo.test",
          db: { admin: () => ({ command: async () => ({ setName: "rs0", logicalSessionTimeoutMinutes: 30 }) }) },
          getClient: () => ({ topology: { description: { type: "ReplicaSetWithPrimary" } } }),
        },
      }),
    },
  })();
  const session = activeSession();
  const originalSessionFind = StudentFileSession.findOne;
  const originalAttemptFind = StudentAttempt.findOne;
  const originalAttemptCreate = StudentAttempt.create;
  const originalProgressFind = StudentSkillProgress.findOne;
  const originalProgressUpdate = StudentSkillProgress.findOneAndUpdate;
  const originalStartSession = mongoose.startSession;
  const created = [];
  const progressUpdates = [];
  StudentFileSession.findOne = async () => session;
  StudentAttempt.findOne = (filter) => createQuery(() =>
    filter.idempotencyKeyHash ? null : { revision: 1 },
  );
  StudentAttempt.create = async ([payload]) => {
    created.push(payload);
    return [{ _id: "507f1f77bcf86cd799439099", ...payload }];
  };
  StudentSkillProgress.findOne = () => createQuery(() => null);
  StudentSkillProgress.findOneAndUpdate = async (filter, update, options) => {
    progressUpdates.push({ filter, update, options });
    return {
      userId: session.userId,
      skills: new Map([
        ["excel_mapping", { score: 82.5, evidenceCount: 4 }],
      ]),
    };
  };
  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      return callback();
    },
    async endSession() {},
  });

  try {
    const response = responseRecorder();
    await recordStudentAttempt(
      {
        params: { id: session._id },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": attemptToken(),
        },
        body: {
          event: "attempt_completed",
          kind: "mapping_attempt",
          submittedStateHash: "submitted-hash",
          sessionStateHash: "state-hash",
          rubricVersion: "student-v1",
          score: 82.5,
          completed: true,
          deterministic: true,
          summary: {
            issueIds: ["issue-1"],
            evidenceCount: 4,
            breakdown: [{ category: "mapping", earned: 20, maxScore: 30 }],
            rows: [{ confidential: true }],
          },
        },
      },
      response,
    );

    assert.equal(response.statusCode, 201);
    assert.equal(created.length, 1);
    assert.equal(created[0].revision, 2);
    assert.equal(created[0].ownerScope, session.ownerScope);
    assert.equal(created[0].retentionExpiresAt.getTime(), session.retentionExpiresAt.getTime());
    assert.equal(created[0].summary.rows, undefined);
    assert.equal(progressUpdates.length, 1);
    assert.equal(progressUpdates[0].update.$set["skills.excel_mapping.score"], 82.5);
    assert.equal(progressUpdates[0].update.$inc["skills.excel_mapping.evidenceCount"], 4);
    assert.deepEqual(response.body.attempt, {
      id: "507f1f77bcf86cd799439099",
      revision: 2,
      kind: "mapping_attempt",
      score: 82.5,
      rubricVersion: "student-v1",
      sessionStateHash: "state-hash",
      submittedStateHash: "submitted-hash",
      summary: {
        issueIds: ["issue-1"],
        evidenceCount: 4,
        breakdown: [{ category: "mapping", earned: 20, maxScore: 30 }],
      },
      hintLevelUsed: 0,
      createdAt: null,
    });
  } finally {
    StudentFileSession.findOne = originalSessionFind;
    StudentAttempt.findOne = originalAttemptFind;
    StudentAttempt.create = originalAttemptCreate;
    StudentSkillProgress.findOne = originalProgressFind;
    StudentSkillProgress.findOneAndUpdate = originalProgressUpdate;
    mongoose.startSession = originalStartSession;
  }
});

test("incomplete or non-deterministic evaluations never update progress", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const originalCreate = StudentAttempt.create;
  const originalUpdate = StudentSkillProgress.findOneAndUpdate;
  let mutated = false;
  StudentAttempt.create = async () => {
    mutated = true;
  };
  StudentSkillProgress.findOneAndUpdate = async () => {
    mutated = true;
  };
  try {
    const response = responseRecorder();
    await recordStudentAttempt(
      {
        params: { id: activeSession()._id },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": attemptToken(),
        },
        body: {
          event: "attempt_completed",
          kind: "mapping_attempt",
          submittedStateHash: "submitted-hash",
          sessionStateHash: "state-hash",
          rubricVersion: "student-v1",
          score: 82,
          completed: false,
          deterministic: true,
          summary: {},
        },
      },
      response,
    );
    assert.equal(response.statusCode, 400);
    assert.equal(mutated, false);
  } finally {
    StudentAttempt.create = originalCreate;
    StudentSkillProgress.findOneAndUpdate = originalUpdate;
  }
});

test("attempt history is owner scoped and cross-user reads do not query attempts", async () => {
  const originalSessionFind = StudentFileSession.findOne;
  const originalAttemptFind = StudentAttempt.find;
  let attemptsQueried = false;
  StudentFileSession.findOne = async () => null;
  StudentAttempt.find = () => {
    attemptsQueried = true;
    return { sort: () => ({ limit: async () => [] }) };
  };
  try {
    const response = responseRecorder();
    await getStudentAttempts(
      {
        params: { id: activeSession()._id },
        user: { _id: "507f1f77bcf86cd799439088" },
        headers: { "x-student-context": attemptToken() },
      },
      response,
    );
    assert.equal(response.statusCode, 404);
    assert.equal(attemptsQueried, false);
  } finally {
    StudentFileSession.findOne = originalSessionFind;
    StudentAttempt.find = originalAttemptFind;
  }
});

test("attempt history requires the attempt scope before querying revisions", async () => {
  const session = activeSession();
  const originalSessionFind = StudentFileSession.findOne;
  const originalAttemptFind = StudentAttempt.find;
  let attemptsQueried = false;
  StudentFileSession.findOne = async () => session;
  StudentAttempt.find = () => {
    attemptsQueried = true;
    return { sort: () => ({ limit: async () => [] }) };
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze", "explain"],
  });
  try {
    const response = responseRecorder();
    await getStudentAttempts(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
      },
      response,
    );
    assert.equal(response.statusCode, 401);
    assert.equal(attemptsQueried, false);
  } finally {
    StudentFileSession.findOne = originalSessionFind;
    StudentAttempt.find = originalAttemptFind;
  }
});

test("hint updates use the signed owner scope and only raise the highest level", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const session = activeSession();
  const originalSessionFind = StudentFileSession.findOne;
  const originalAttemptUpdate = StudentAttempt.findOneAndUpdate;
  const calls = [];
  StudentFileSession.findOne = async () => session;
  StudentAttempt.findOneAndUpdate = async (filter, update, options) => {
    calls.push({ filter, update, options });
    return { _id: "507f1f77bcf86cd799439099", hintLevelUsed: 3 };
  };
  try {
    const response = responseRecorder();
    await recordStudentHint(
      {
        params: { id: session._id, attemptId: "507f1f77bcf86cd799439099" },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": attemptToken(),
        },
        body: { event: "hint_revealed", issueId: "issue-1", level: 3 },
      },
      response,
    );
    assert.equal(response.statusCode, 202);
    assert.equal(calls[0].filter.ownerScope, session.ownerScope);
    assert.equal(String(calls[0].filter.sessionId), session._id);
    assert.deepEqual(calls[0].update, { $max: { hintLevelUsed: 3 } });
    assert.equal(calls[0].options.new, true);
  } finally {
    StudentFileSession.findOne = originalSessionFind;
    StudentAttempt.findOneAndUpdate = originalAttemptUpdate;
  }
});
