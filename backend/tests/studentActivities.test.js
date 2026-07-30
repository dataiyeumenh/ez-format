const assert = require("node:assert/strict");
const test = require("node:test");

const StudentActivity = require("../models/StudentActivity");
const StudentFileSession = require("../models/StudentFileSession");
const { createStudentContextToken } = require("../services/conversionContextService");
const {
  cleanStudentActivityPayload,
  deleteStudentActivities,
  getStudentActivities,
  recordStudentActivity,
} = require("../controllers/studentSessionController");

process.env.CONVERSION_CONTEXT_SECRET = "test-student-activity-secret";

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

function session() {
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

function token(overrides = {}) {
  const active = session();
  return createStudentContextToken({
    sessionId: active._id,
    userId: active.userId,
    ownerScope: active.ownerScope,
    workspaceId: null,
    allowedScopes: ["accounting_map", "reconcile", "export"],
    ...overrides,
  });
}

test("activity payload is allowlisted and never accepts raw values", () => {
  assert.deepEqual(
    cleanStudentActivityPayload({
      eventType: "reconciliation_completed",
      evidenceCount: 8,
      containsRawValues: false,
    }),
    {
      eventType: "reconciliation_completed",
      skill: "vat_reconciliation",
      summaryVi: "Đã hoàn thành đối chiếu deterministic có bằng chứng.",
      evidenceCount: 8,
      containsRawValues: false,
    },
  );
  assert.equal(cleanStudentActivityPayload({ eventType: "invented" }), null);
  assert.equal(
    cleanStudentActivityPayload({
      eventType: "accounting_map_reviewed",
      containsRawValues: true,
      rows: [{ account: "131" }],
    }),
    null,
  );
});

test("StudentActivity stores sanitized metadata only", () => {
  for (const field of ["sessionId", "userId", "ownerScope", "eventType", "skill", "summaryVi"]) {
    assert.ok(StudentActivity.schema.path(field));
  }
  assert.equal(StudentActivity.schema.path("containsRawValues").options.default, false);
  assert.equal(StudentActivity.schema.path("rows"), undefined);
  assert.equal(StudentActivity.schema.path("rawValues"), undefined);
  assert.equal(StudentActivity.schema.path("workbook"), undefined);
});

test("internal activity creation is scope and owner bounded", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const active = session();
  const originalFind = StudentFileSession.findOne;
  const originalCreate = StudentActivity.create;
  const created = [];
  StudentFileSession.findOne = async () => active;
  StudentActivity.create = async (payload) => {
    created.push(payload);
    return { _id: "507f1f77bcf86cd799439099", createdAt: new Date(0), ...payload };
  };
  try {
    const response = responseRecorder();
    await recordStudentActivity(
      {
        params: { id: active._id },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": token(),
        },
        body: {
          eventType: "accounting_map_reviewed",
          evidenceCount: 2,
          containsRawValues: false,
        },
      },
      response,
    );
    assert.equal(response.statusCode, 201);
    assert.equal(created[0].ownerScope, active.ownerScope);
    assert.equal(created[0].retentionExpiresAt, active.retentionExpiresAt);
    assert.equal(created[0].skill, "accounting_mapping");
    assert.equal(created[0].containsRawValues, false);
  } finally {
    StudentFileSession.findOne = originalFind;
    StudentActivity.create = originalCreate;
  }
});

test("cross-user activity reads and deletes fail before activity access", async () => {
  const originalSessionFind = StudentFileSession.findOne;
  const originalActivityFind = StudentActivity.find;
  const originalDelete = StudentActivity.deleteMany;
  let activityAccessed = false;
  StudentFileSession.findOne = async () => null;
  StudentActivity.find = () => { activityAccessed = true; return { sort: () => ({ limit: async () => [] }) }; };
  StudentActivity.deleteMany = async () => { activityAccessed = true; return { deletedCount: 0 }; };
  try {
    for (const handler of [getStudentActivities, deleteStudentActivities]) {
      const response = responseRecorder();
      await handler(
        {
          params: { id: session()._id },
          user: { _id: "507f1f77bcf86cd799439088" },
          headers: { "x-student-context": token() },
        },
        response,
      );
      assert.equal(response.statusCode, 404);
    }
    assert.equal(activityAccessed, false);
  } finally {
    StudentFileSession.findOne = originalSessionFind;
    StudentActivity.find = originalActivityFind;
    StudentActivity.deleteMany = originalDelete;
  }
});
