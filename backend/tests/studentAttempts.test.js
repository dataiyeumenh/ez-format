const assert = require("node:assert/strict");
const test = require("node:test");

const StudentAttempt = require("../models/StudentAttempt");
const StudentFileSession = require("../models/StudentFileSession");
const StudentSkillProgress = require("../models/StudentSkillProgress");
const { createStudentContextToken } = require("../services/conversionContextService");
const {
  cleanAttemptCompletedPayload,
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

test("completed deterministic attempts create an immutable revision and update progress", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const session = activeSession();
  const originalSessionFind = StudentFileSession.findOne;
  const originalAttemptFind = StudentAttempt.findOne;
  const originalAttemptCreate = StudentAttempt.create;
  const originalProgressUpdate = StudentSkillProgress.findOneAndUpdate;
  const created = [];
  const progressUpdates = [];
  StudentFileSession.findOne = async () => session;
  StudentAttempt.findOne = () => ({ sort: async () => ({ revision: 1 }) });
  StudentAttempt.create = async (payload) => {
    created.push(payload);
    return { _id: "507f1f77bcf86cd799439099", ...payload };
  };
  StudentSkillProgress.findOneAndUpdate = async (filter, update, options) => {
    progressUpdates.push({ filter, update, options });
    return {
      userId: session.userId,
      skills: new Map([
        ["excel_mapping", { score: 82.5, evidenceCount: 4 }],
      ]),
    };
  };

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
    StudentSkillProgress.findOneAndUpdate = originalProgressUpdate;
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
