const assert = require("node:assert/strict");
const test = require("node:test");

const StudentFileSession = require("../models/StudentFileSession");
const StudentQuestionEvent = require("../models/StudentQuestionEvent");
const { createStudentContextToken } = require("../services/conversionContextService");
const {
  checkStudentSessionActive,
  cleanQuestionEventPayload,
  recordStudentQuestionEvent,
} = require("../controllers/studentSessionController");
const { hashStudentQuestion } = require("../services/studentSessionService");

process.env.CONVERSION_CONTEXT_SECRET = "test-student-question-secret";

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

function questionToken(overrides = {}) {
  return createStudentContextToken({
    sessionId: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    ownerScope: "user:507f1f77bcf86cd799439012",
    workspaceId: null,
    allowedScopes: ["analyze", "explain", "ask"],
    ...overrides,
  });
}

test("question event payload keeps metadata only and rejects raw row fields", () => {
  const question = "Có bao nhiêu hóa đơn?";
  assert.deepEqual(
    cleanQuestionEventPayload({
      event: "question_answered",
      question: `  ${question}  `,
      category: "count_documents",
      operation: "ask",
      answerType: "deterministic_file_query",
      evidenceIds: [" evidence-1 ", "evidence-2"],
      evidenceCount: 22,
      outcome: "supported",
      rows: [{ customer: "confidential" }],
      rawRows: [{ supplier: "confidential" }],
      evidence: [{ actual: "secret" }],
      answer: "full answer",
    }),
    {
      event: "question_answered",
      questionHash: hashStudentQuestion(question),
      questionLength: question.length,
      category: "count_documents",
      operation: "ask",
      answerType: "deterministic_file_query",
      evidenceIds: ["evidence-1", "evidence-2"],
      evidenceCount: 22,
      outcome: "supported",
    },
  );
});

test("StudentQuestionEvent schema contains no full row or answer payload", () => {
  assert.equal(StudentQuestionEvent.schema.path("question"), undefined);
  assert.equal(StudentQuestionEvent.schema.path("questionHash").instance, "String");
  assert.equal(StudentQuestionEvent.schema.path("questionLength").instance, "Number");
  assert.equal(StudentQuestionEvent.schema.path("category").instance, "String");
  assert.equal(StudentQuestionEvent.schema.path("operation").instance, "String");
  assert.equal(StudentQuestionEvent.schema.path("answerType").instance, "String");
  assert.equal(StudentQuestionEvent.schema.path("evidenceIds").instance, "Array");
  assert.equal(StudentQuestionEvent.schema.path("evidenceCount").instance, "Number");
  assert.equal(StudentQuestionEvent.schema.path("outcome").instance, "String");
  assert.equal(StudentQuestionEvent.schema.path("rows"), undefined);
  assert.equal(StudentQuestionEvent.schema.path("rawRows"), undefined);
  assert.equal(StudentQuestionEvent.schema.path("evidence"), undefined);
  assert.equal(StudentQuestionEvent.schema.path("answer"), undefined);
});

test("internal question event is ask-scope and owner bounded", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "upload-1",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
  };
  const token = questionToken();
  const originalFindOne = StudentFileSession.findOne;
  const originalCreate = StudentQuestionEvent.create;
  const findCalls = [];
  const createCalls = [];
  StudentFileSession.findOne = async (filter) => {
    findCalls.push(filter);
    return session;
  };
  StudentQuestionEvent.create = async (payload) => {
    createCalls.push(payload);
    return { _id: "507f1f77bcf86cd799439099", ...payload };
  };

  try {
    const response = responseRecorder();
    await recordStudentQuestionEvent(
      {
        params: { id: session._id },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": token,
        },
        body: {
          event: "question_answered",
          questionHash: hashStudentQuestion("Có bao nhiêu hóa đơn?"),
          questionLength: "Có bao nhiêu hóa đơn?".length,
          category: "count_documents",
          operation: "ask",
          answerType: "deterministic_file_query",
          evidenceIds: ["evidence-1", "evidence-2"],
          evidenceCount: 2,
          outcome: "supported",
          rows: [{ confidential: true }],
        },
      },
      response,
    );

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.body, {
      success: true,
      event: {
        id: "507f1f77bcf86cd799439099",
        answerType: "deterministic_file_query",
        evidenceCount: 2,
        outcome: "supported",
      },
    });
    assert.equal(findCalls.length, 1);
    assert.equal(String(findCalls[0]._id), session._id);
    assert.equal(String(findCalls[0].userId), session.userId);
    assert.equal(findCalls[0].ownerScope, session.ownerScope);
    assert.equal(findCalls[0].workspaceId, null);
    assert.deepEqual(findCalls[0].status, { $nin: ["expired", "deleted"] });
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0], {
      sessionId: session._id,
      userId: session.userId,
      workspaceId: null,
      ownerScope: session.ownerScope,
      questionHash: hashStudentQuestion("Có bao nhiêu hóa đơn?"),
      questionLength: "Có bao nhiêu hóa đơn?".length,
      category: "count_documents",
      operation: "ask",
      answerType: "deterministic_file_query",
      evidenceIds: ["evidence-1", "evidence-2"],
      evidenceCount: 2,
      outcome: "supported",
      retentionExpiresAt: session.retentionExpiresAt,
    });
  } finally {
    StudentFileSession.findOne = originalFindOne;
    StudentQuestionEvent.create = originalCreate;
  }
});

test("internal question event rejects a different session before database access", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const originalFindOne = StudentFileSession.findOne;
  const originalCreate = StudentQuestionEvent.create;
  let databaseCalled = false;
  StudentFileSession.findOne = async () => {
    databaseCalled = true;
    return null;
  };
  StudentQuestionEvent.create = async () => {
    databaseCalled = true;
    return null;
  };

  try {
    const response = responseRecorder();
    await recordStudentQuestionEvent(
      {
        params: { id: "507f1f77bcf86cd799439099" },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": questionToken(),
        },
        body: { event: "question_answered" },
      },
      response,
    );

    assert.equal(response.statusCode, 403);
    assert.equal(databaseCalled, false);
  } finally {
    StudentFileSession.findOne = originalFindOne;
    StudentQuestionEvent.create = originalCreate;
  }
});

test("internal active check validates session user owner workspace and ask scope", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: "507f1f77bcf86cd799439013",
    ownerScope: "workspace:507f1f77bcf86cd799439013",
    converterUploadId: "upload-1",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
  };
  const token = questionToken({
    ownerScope: session.ownerScope,
    workspaceId: session.workspaceId,
  });
  const originalFindById = StudentFileSession.findById;
  const calls = [];
  StudentFileSession.findById = async (sessionId) => {
    calls.push(String(sessionId));
    return session;
  };

  try {
    const response = responseRecorder();
    await checkStudentSessionActive(
      {
        params: { id: session._id },
        query: { uploadId: "upload-1" },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": token,
        },
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      success: true,
      active: true,
      sessionId: session._id,
    });
    assert.deepEqual(calls, [session._id]);
  } finally {
    StudentFileSession.findById = originalFindById;
  }
});

test("internal active check returns 410 for expired or deleted sessions", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const originalFindById = StudentFileSession.findById;
  StudentFileSession.findById = async () => ({
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    status: "deleted",
    retentionExpiresAt: new Date(Date.now() + 60_000),
  });

  try {
    const response = responseRecorder();
    await checkStudentSessionActive(
      {
        params: { id: "507f1f77bcf86cd799439011" },
        query: { uploadId: "upload-1" },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": questionToken(),
        },
      },
      response,
    );
    assert.equal(response.statusCode, 410);
  } finally {
    StudentFileSession.findById = originalFindById;
  }
});

test("internal active check returns 403 for owner or workspace mismatch", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const originalFindById = StudentFileSession.findById;
  StudentFileSession.findById = async () => ({
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: "507f1f77bcf86cd799439013",
    ownerScope: "workspace:507f1f77bcf86cd799439013",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
  });

  try {
    const response = responseRecorder();
    await checkStudentSessionActive(
      {
        params: { id: "507f1f77bcf86cd799439011" },
        query: { uploadId: "upload-1" },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": questionToken(),
        },
      },
      response,
    );
    assert.equal(response.statusCode, 403);
  } finally {
    StudentFileSession.findById = originalFindById;
  }
});

test("internal active check requires exact non-empty converter upload binding", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const originalFindById = StudentFileSession.findById;
  StudentFileSession.findById = async () => ({
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    converterUploadId: "upload-bound",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
  });

  try {
    for (const uploadId of [undefined, "", "upload-other"]) {
      const response = responseRecorder();
      await checkStudentSessionActive(
        {
          params: { id: "507f1f77bcf86cd799439011" },
          query: { uploadId },
          headers: {
            "x-converter-service-token": "converter-service-secret",
            "x-student-context": questionToken(),
          },
        },
        response,
      );
      assert.equal(response.statusCode, 409);
    }
  } finally {
    StudentFileSession.findById = originalFindById;
  }
});
