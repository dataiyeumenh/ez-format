const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const {
  createStudentContextToken,
  verifyConversionContextToken,
  verifyStudentContextToken,
} = require("../services/conversionContextService");
const { buildOwnerScope } = require("../services/studentSessionService");
const StudentFileSession = require("../models/StudentFileSession");
const previousGatewayFlags = {
  CONVERTER_PUBLIC_PROXY_ENABLED: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
  CONVERTER_GATEWAY_USAGE_READY: process.env.CONVERTER_GATEWAY_USAGE_READY,
};
process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "true";
process.env.CONVERTER_GATEWAY_USAGE_READY = "true";
const studentRouter = require("../routes/student");
const previousStudentFlag = process.env.STUDENT_ASSISTANT_ENABLED;
process.env.STUDENT_ASSISTANT_ENABLED = "true";
const internalRouter = require("../routes/internal");
if (previousStudentFlag === undefined) delete process.env.STUDENT_ASSISTANT_ENABLED;
else process.env.STUDENT_ASSISTANT_ENABLED = previousStudentFlag;
const {
  mergeGatewayCapabilities,
} = require("../routes/converterGateway");
for (const [name, value] of Object.entries(previousGatewayFlags)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const {
  cleanAnalysisCompletedPayload,
  cleanStudentSessionPayload,
  createContextToken,
  getStudentSession,
  recordStudentAnalysisCompleted,
  refreshStudentContext,
  sessionIsExpired,
  serializeStudentSession,
  sessionIsOwnedByUser,
  studentContextMatchesSession,
  studentContextScopesFromFlags,
} = require("../controllers/studentSessionController");

process.env.CONVERSION_CONTEXT_SECRET = "test-student-session-secret";

test("student router exposes assistance without grading, attempts, or progress", () => {
  const routes = studentRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
  const routePaths = routes.map(({ path }) => path);

  assert.equal(routePaths.includes("/sessions/:id/attempts"), false);
  assert.equal(routePaths.includes("/progress"), false);
  assert.equal(routePaths.some((path) => path.includes("score")), false);
  assert.equal(routePaths.some((path) => path.includes("grade")), false);

  assert.equal(routePaths.includes("/sessions/:id/operations/*"), false);
  assert.deepEqual(
    routes.filter(({ path }) => path.includes("/operations/")),
    [
      { path: "/sessions/:id/operations/overview", methods: ["get"] },
      { path: "/sessions/:id/operations/questions", methods: ["post"] },
      { path: "/sessions/:id/operations/source-rows/:worksheetRow", methods: ["get"] },
      { path: "/sessions/:id/operations/accounting-map", methods: ["get"] },
      { path: "/sessions/:id/operations/reconciliation", methods: ["get"] },
      { path: "/sessions/:id/operations/anonymization/preview", methods: ["post"] },
      { path: "/sessions/:id/operations/anonymization/export", methods: ["post"] },
      { path: "/sessions/:id/operations/internship-report", methods: ["post"] },
    ],
  );
});

test("Student analyze preallocates a nonblank converter upload binding", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    status: "created",
    converterUploadId: "",
    targetTemplateId: "bsn_sales",
    retentionExpiresAt: new Date(Date.now() + 60_000),
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    retentionExpiresAt: session.retentionExpiresAt,
  });
  const originalFindOne = StudentFileSession.findOne;
  let forwarded;
  StudentFileSession.findOne = async () => session;
  const response = {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
  try {
    await studentRouter.analyzeStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
        body: { target_template_id: "bsn_sales" },
        file: { originalname: "sales.xlsx", buffer: Buffer.from("test") },
      },
      response,
      {
        forwardMultipartFn: async (request) => {
          forwarded = request;
          return { status: 200, headers: {}, data: { success: true } };
        },
      },
    );
  } finally {
    StudentFileSession.findOne = originalFindOne;
  }

  assert.equal(response.statusCode, 200);
  const claims = verifyConversionContextToken(forwarded.contextToken);
  assert.match(claims.upload_id, /^[0-9a-f-]{36}$/i);
  assert.notEqual(claims.upload_id, "");
  assert.equal(claims.operation_session_id, String(session._id));
});

test("internal student routes expose assistance without grading or attempt routes", () => {
  const routePaths = internalRouter.stack
    .map((layer) => layer.route?.path)
    .filter((routePath) => routePath?.startsWith("/student/"));

  assert.equal(routePaths.some((routePath) => routePath.includes("attempt")), false);
  assert.equal(routePaths.some((routePath) => routePath.includes("score")), false);
  assert.ok(routePaths.includes("/student/sessions/:id/events"));
  assert.equal(
    internalRouter.studentInternalRoutesEnabled({
      STUDENT_ASSISTANT_ENABLED: "false",
    }),
    false,
  );
});

test("converter capability response preserves the student backend gate", () => {
  assert.deepEqual(
    mergeGatewayCapabilities({
      capabilities: { studentAssistant: true, studentFileExplain: true },
    }, { STUDENT_ASSISTANT_ENABLED: "true" }),
    {
      capabilities: { studentAssistant: true, studentFileExplain: true },
      misa_import_repair: {
        enabled: false,
        phase: 1,
        adapter: "manual_excel_v1",
        verified_adapter: false,
        auto_match: false,
        retry_unit: "document_group",
      },
      available: true,
      gateway: true,
      artifactStorage: "mongodb-gridfs",
    },
  );
  assert.equal(
    mergeGatewayCapabilities(
      { capabilities: { studentAssistant: true } },
      { STUDENT_ASSISTANT_ENABLED: "false" },
    ).capabilities.studentAssistant,
    false,
  );
});

test("owner scope uses the selected workspace or falls back to the user", () => {
  assert.equal(buildOwnerScope({ userId: " user-1 " }), "user:user-1");
  assert.equal(
    buildOwnerScope({ userId: "user-1", workspaceId: " workspace-1 " }),
    "workspace:workspace-1",
  );
});

test("owner scope rejects requests without a user or workspace", () => {
  assert.throws(() => buildOwnerScope({}), /owner scope/i);
  assert.throws(() => buildOwnerScope({ userId: " ", workspaceId: " " }), /owner scope/i);
});

test("student context contains its owner and allowed scopes", () => {
  const ownerScope = buildOwnerScope({ userId: "user-1" });
  const retentionExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const token = createStudentContextToken({
    sessionId: "session-1",
    userId: "user-1",
    ownerScope,
    workspaceId: null,
    snapshotSetHash: null,
    allowedScopes: ["analyze", "explain"],
    retentionExpiresAt,
  });

  const claims = verifyStudentContextToken(token, "analyze");
  assert.equal(claims.purpose, "student_file_session");
  assert.equal(claims.session_id, "session-1");
  assert.equal(claims.user_id, "user-1");
  assert.equal(claims.owner_scope, "user:user-1");
  assert.equal(claims.workspace_id, null);
  assert.equal(claims.snapshot_set_hash, null);
  assert.deepEqual(claims.allowed_scopes, ["analyze", "explain"]);
  assert.equal(claims.retention_expires_at, Math.floor(retentionExpiresAt.getTime() / 1000));
});

test("student context derives a safe signed retention boundary and rejects an expired one", () => {
  const token = createStudentContextToken({
    sessionId: "session-1",
    userId: "user-1",
    ownerScope: "user:user-1",
    allowedScopes: ["analyze"],
  });
  const claims = verifyStudentContextToken(token, "analyze");
  assert.equal(claims.retention_expires_at, claims.exp);
  assert.throws(
    () =>
      createStudentContextToken({
        sessionId: "session-1",
        userId: "user-1",
        ownerScope: "user:user-1",
        allowedScopes: ["analyze"],
        retentionExpiresAt: new Date(Date.now() - 1000),
      }),
    /retention/i,
  );
});

test("student context pins JWT iat to the retention clock", () => {
  const realDateNow = Date.now;
  let calls = 0;
  Date.now = () => (calls++ === 0 ? 1_000_000 : 1_001_000);

  try {
    const token = createStudentContextToken({
      sessionId: "session-clock-boundary",
      userId: "user-1",
      ownerScope: "user:user-1",
      allowedScopes: ["analyze"],
    });
    const claims = verifyStudentContextToken(token, "analyze");

    assert.equal(claims.iat, 1000);
    assert.equal(claims.retention_expires_at, claims.exp);
  } finally {
    Date.now = realDateNow;
  }
});

test("student context rejects a token with another purpose", () => {
  const token = jwt.sign(
    { purpose: "misa_conversion", allowed_scopes: ["analyze"] },
    process.env.CONVERSION_CONTEXT_SECRET,
    { expiresIn: "10m" },
  );

  assert.throws(() => verifyStudentContextToken(token, "analyze"), /student context token/i);
});

test("student context rejects missing required scopes", () => {
  const token = createStudentContextToken({
    sessionId: "session-1",
    userId: "user-1",
    ownerScope: "user:user-1",
    allowedScopes: ["analyze"],
  });

  assert.throws(() => verifyStudentContextToken(token, "export"), /thiếu quyền export/i);
});

test("student context requires an explicit required scope during verification", () => {
  const token = createStudentContextToken({
    sessionId: "session-1",
    userId: "user-1",
    ownerScope: "user:user-1",
    allowedScopes: ["analyze"],
  });

  assert.throws(() => verifyStudentContextToken(token), /required scope/i);
  assert.throws(() => verifyStudentContextToken(token, " "), /required scope/i);
});

test("student context accepts a 24-hour lifetime", () => {
  assert.doesNotThrow(() =>
    createStudentContextToken({
      sessionId: "session-1",
      userId: "user-1",
      ownerScope: "user:user-1",
      allowedScopes: ["analyze"],
      expiresIn: "24h",
    }),
  );
});

test("student context rejects lifetimes longer than 24 hours", () => {
  for (const expiresIn of ["48h", "2d"]) {
    assert.throws(
      () =>
        createStudentContextToken({
          sessionId: "session-1",
          userId: "user-1",
          ownerScope: "user:user-1",
          allowedScopes: ["analyze"],
          expiresIn,
        }),
      /lifetime/i,
    );
  }
});

test("student context rejects unsupported lifetime formats", () => {
  assert.throws(
    () =>
      createStudentContextToken({
        sessionId: "session-1",
        userId: "user-1",
        ownerScope: "user:user-1",
        allowedScopes: ["analyze"],
        expiresIn: "1w",
      }),
    /lifetime/i,
  );
});

test("student context rejects expired tokens", () => {
  const token = createStudentContextToken({
    sessionId: "session-1",
    userId: "user-1",
    ownerScope: "user:user-1",
    allowedScopes: ["analyze"],
    expiresIn: "-1s",
  });

  assert.throws(() => verifyStudentContextToken(token, "analyze"), /jwt expired/i);
});

test("student context requires a numeric future exp claim", () => {
  const noExpiry = jwt.sign(
    {
      purpose: "student_file_session",
      session_id: "session-1",
      user_id: "user-1",
      owner_scope: "user:user-1",
      allowed_scopes: ["analyze"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", noTimestamp: true },
  );

  assert.throws(
    () => verifyStudentContextToken(noExpiry, "analyze"),
    /exp/i,
  );
});

test("student context rejects scalar scopes", () => {
  const token = jwt.sign(
    {
      purpose: "student_file_session",
      session_id: "session-1",
      user_id: "user-1",
      owner_scope: "user:user-1",
      allowed_scopes: "analyze",
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" },
  );

  assert.throws(
    () => verifyStudentContextToken(token, "analyze"),
    /scopes/i,
  );
});

test("student context rejects non-HS256 tokens", () => {
  const token = jwt.sign(
    {
      purpose: "student_file_session",
      session_id: "session-1",
      user_id: "user-1",
      owner_scope: "user:user-1",
      allowed_scopes: ["analyze"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS512", expiresIn: "10m" },
  );

  assert.throws(
    () => verifyStudentContextToken(token, "analyze"),
    /algorithm/i,
  );
});

test("student context never grants grading or attempt scopes", () => {
  const flags = {
    STUDENT_ASSISTANT_ENABLED: "true",
    STUDENT_FILE_EXPLAIN_ENABLED: "true",
    STUDENT_FILE_QA_ENABLED: "false",
    STUDENT_CHECK_WORK_ENABLED: "false",
    STUDENT_ACCOUNTING_MAP_ENABLED: "false",
    STUDENT_RECONCILIATION_ENABLED: "false",
    STUDENT_INTERNSHIP_ENABLED: "false",
  };

  assert.deepEqual(studentContextScopesFromFlags(flags), ["analyze", "explain"]);
  assert.deepEqual(
    studentContextScopesFromFlags({ ...flags, STUDENT_FILE_QA_ENABLED: "true" }),
    ["analyze", "explain", "ask"],
  );
  assert.deepEqual(
    studentContextScopesFromFlags({
      ...flags,
      STUDENT_FILE_QA_ENABLED: "true",
      STUDENT_CHECK_WORK_ENABLED: "true",
      STUDENT_ACCOUNTING_MAP_ENABLED: "true",
      STUDENT_RECONCILIATION_ENABLED: "true",
    }),
    ["analyze", "explain", "ask", "accounting_map", "reconcile"],
  );
  assert.deepEqual(
    studentContextScopesFromFlags({ ...flags, STUDENT_INTERNSHIP_ENABLED: "true" }),
    ["analyze", "explain", "export"],
  );
  assert.deepEqual(
    studentContextScopesFromFlags({ ...flags, STUDENT_ASSISTANT_ENABLED: "false" }),
    [],
  );
});

test("student context issuance rejects removed attempt scopes", () => {
  assert.throws(
    () =>
      createStudentContextToken({
        sessionId: "session-1",
        userId: "user-1",
        ownerScope: "user:user-1",
        allowedScopes: ["analyze", "attempt"],
      }),
    /scope.*attempt|attempt.*scope/i,
  );
});

test("student context verification rejects legacy attempt scopes", () => {
  const token = jwt.sign(
    {
      purpose: "student_file_session",
      session_id: "session-1",
      user_id: "user-1",
      owner_scope: "user:user-1",
      allowed_scopes: ["analyze", "attempt"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" },
  );

  assert.throws(
    () => verifyStudentContextToken(token, "analyze"),
    /scope.*attempt|attempt.*scope/i,
  );
});

test("Phase 1 context token cannot confirm or export", () => {
  const flagNames = [
    "STUDENT_ASSISTANT_ENABLED",
    "STUDENT_FILE_EXPLAIN_ENABLED",
    "STUDENT_FILE_QA_ENABLED",
    "STUDENT_CHECK_WORK_ENABLED",
    "STUDENT_ACCOUNTING_MAP_ENABLED",
    "STUDENT_RECONCILIATION_ENABLED",
    "STUDENT_INTERNSHIP_ENABLED",
  ];
  const previous = Object.fromEntries(flagNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    STUDENT_ASSISTANT_ENABLED: "true",
    STUDENT_FILE_EXPLAIN_ENABLED: "true",
    STUDENT_FILE_QA_ENABLED: "false",
    STUDENT_CHECK_WORK_ENABLED: "false",
    STUDENT_ACCOUNTING_MAP_ENABLED: "false",
    STUDENT_RECONCILIATION_ENABLED: "false",
    STUDENT_INTERNSHIP_ENABLED: "false",
  });
  try {
    const token = createContextToken({
      _id: "session-1",
      userId: "user-1",
      ownerScope: "user:user-1",
      workspaceId: null,
    });
    assert.deepEqual(verifyStudentContextToken(token, "analyze").allowed_scopes, [
      "analyze",
      "explain",
    ]);
    assert.throws(() => verifyStudentContextToken(token, "attempt"), /thiếu quyền attempt/i);
    assert.throws(() => verifyStudentContextToken(token, "export"), /thiếu quyền export/i);
  } finally {
    for (const name of flagNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("unanalyzed student session payload cannot bind raw converter state", () => {
  assert.deepEqual(
    cleanStudentSessionPayload({
      workspaceId: " workspace-1 ",
      file: {
        originalName: " ../sales.xlsx ",
        sizeBytes: "1024",
        extension: "XLSX",
        contentHash: " sha256:example ",
      },
      converterUploadId: " upload-1 ",
      targetTemplateId: " bsn_sales ",
      sourceSignatureHash: " source-hash ",
      rawRows: [{ customer: "confidential" }],
      workbookBytes: "confidential bytes",
    }),
    {
      workspaceId: "workspace-1",
      file: {
        originalName: "student-upload.xlsx",
        sizeBytes: 1024,
        extension: ".xlsx",
        contentHash: "sha256:example",
        rawRetained: false,
      },
      converterUploadId: "",
      targetTemplateId: "bsn_sales",
      sourceSignatureHash: "",
    },
  );
});

test("student session serializer never exposes raw workbook content", () => {
  const session = {
    _id: "session-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    ownerScope: "workspace:workspace-1",
    mode: "student_assistant",
    status: "created",
    file: {
      originalName: "sales.xlsx",
      sizeBytes: 1024,
      extension: ".xlsx",
      contentHash: "sha256:example",
      rawRetained: false,
      rawRows: [{ customer: "confidential" }],
    },
    summary: { sheetCount: 2, rawRows: [{ customer: "confidential" }] },
    retentionExpiresAt: new Date("2026-07-18T00:00:00Z"),
    rawRows: [{ customer: "confidential" }],
    workbookBytes: "confidential bytes",
  };

  const payload = serializeStudentSession(session);
  assert.equal(payload.id, "session-1");
  assert.equal(payload.file.originalName, "student-upload.xlsx");
  assert.equal(payload.file.extension, ".xlsx");
  assert.equal(payload.file.rawRows, undefined);
  assert.equal(payload.summary.rawRows, undefined);
  assert.equal(payload.rawRows, undefined);
  assert.equal(payload.workbookBytes, undefined);
});

test("StudentFileSession validation replaces raw filenames with a generic label", async () => {
  const session = new StudentFileSession({
    userId: "507f1f77bcf86cd799439011",
    ownerScope: "user:507f1f77bcf86cd799439011",
    file: {
      originalName: "Nguyen Van A - MSSV 22123456.XLSX",
      sizeBytes: 1024,
      extension: "XLSX",
    },
    retentionExpiresAt: new Date(Date.now() + 60_000),
  });

  await session.validate();

  assert.equal(session.file.originalName, "student-upload.xlsx");
  assert.equal(session.file.extension, ".xlsx");
});

test("student session ownership requires the matching user and owner scope", () => {
  const session = {
    userId: "user-1",
    workspaceId: "workspace-1",
    ownerScope: "workspace:workspace-1",
  };

  assert.equal(sessionIsOwnedByUser(session, "user-1"), true);
  assert.equal(sessionIsOwnedByUser(session, "user-2"), false);
  assert.equal(
    sessionIsOwnedByUser({ ...session, ownerScope: "user:user-1" }, "user-1"),
    false,
  );
});

test("student context must match the requested session owner", () => {
  const session = {
    _id: "session-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    ownerScope: "workspace:workspace-1",
  };
  const claims = verifyStudentContextToken(
    createStudentContextToken({
      sessionId: "session-1",
      userId: "user-1",
      ownerScope: "workspace:workspace-1",
      workspaceId: "workspace-1",
      allowedScopes: ["analyze"],
    }),
    "analyze",
  );

  assert.equal(studentContextMatchesSession(claims, session), true);
  assert.equal(
    studentContextMatchesSession({ ...claims, session_id: "session-2" }, session),
    false,
  );
  assert.equal(
    studentContextMatchesSession({ ...claims, owner_scope: "user:user-1" }, session),
    false,
  );
});

test("student session expiry includes elapsed retention and terminal statuses", () => {
  const now = new Date("2026-07-17T12:00:00Z");

  assert.equal(
    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:00:00Z"), status: "created" }, now),
    true,
  );
  assert.equal(
    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:01:00Z"), status: "expired" }, now),
    true,
  );
  assert.equal(
    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:01:00Z"), status: "deleted" }, now),
    true,
  );
  assert.equal(
    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:01:00Z"), status: "delete_failed" }, now),
    true,
  );
  assert.equal(
    sessionIsExpired({ retentionExpiresAt: new Date("2026-07-17T12:01:00Z"), status: "created" }, now),
    false,
  );
});

test("GET rejects an expired student session before the Mongo TTL sweep", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "user-1",
    workspaceId: null,
    ownerScope: "user:user-1",
    status: "created",
    retentionExpiresAt: new Date(0),
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
  });
  const originalFindOne = StudentFileSession.findOne;
  const response = {
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

  StudentFileSession.findOne = async () => session;
  try {
    await getStudentSession(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": token },
      },
      response,
    );
  } finally {
    StudentFileSession.findOne = originalFindOne;
  }

  assert.equal(response.statusCode, 410);
  assert.match(response.body.message, /hết hạn/i);
});

test("authenticated owner can refresh an active session with an expired old context", async () => {
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    status: "analyzed",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    file: { originalName: "sales.xlsx", sizeBytes: 100, rawRetained: false },
  };
  const expiredContext = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze"],
    expiresIn: "-1s",
  });
  const originalFindOne = StudentFileSession.findOne;
  const response = {
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

  StudentFileSession.findOne = async () => session;
  try {
    await refreshStudentContext(
      {
        params: { id: session._id },
        user: { _id: session.userId },
        headers: { "x-student-context": expiredContext },
      },
      response,
    );
  } finally {
    StudentFileSession.findOne = originalFindOne;
  }

  assert.equal(response.statusCode, 200);
  const refreshedClaims = jwt.verify(
    response.body.contextToken,
    process.env.CONVERSION_CONTEXT_SECRET,
  );
  assert.equal(refreshedClaims.session_id, session._id);
  assert.equal(refreshedClaims.user_id, session.userId);
  assert.ok(refreshedClaims.exp > Math.floor(Date.now() / 1000));
});

test("student session metadata has no direct retention TTL or raw workbook fields", () => {
  const retentionExpiresAt = StudentFileSession.schema.path("retentionExpiresAt");
  assert.equal(retentionExpiresAt.options.expires, undefined);
  const ttlIndexes = StudentFileSession.schema.indexes().filter(([, options]) => options.expireAfterSeconds === 0);
  assert.equal(ttlIndexes.every(([, options]) => options.partialFilterExpression?.status === "deleted"), true);
  assert.equal(StudentFileSession.schema.path("rawRows"), undefined);
  assert.equal(StudentFileSession.schema.path("workbookBytes"), undefined);
  assert.equal(StudentFileSession.schema.path("file.rawBytes"), undefined);
});

test("analysis_completed payload keeps only safe converter metadata", () => {
  assert.deepEqual(
    cleanAnalysisCompletedPayload({
      event: "analysis_completed",
      converterUploadId: " upload-1 ",
      targetTemplateId: " bsn_sales ",
      sourceSignatureHash: " source-hash ",
      status: "exported",
      summary: {
        dataRowCount: 2,
        documentCount: 1,
        recognizedColumns: 6,
        unresolvedColumns: 0,
        mappingCounts: { mapped: 6, default: 1, formula: 4, rawRows: 99 },
        issueCounts: { blocker: 2, warning: 1, info: 0 },
        masterDataStatus: "not_configured",
        explanationCount: 77,
        readinessScore: 93,
        stateHash: " state-1 ",
        rawRows: [{ customer: "confidential" }],
        preview: { rows: [{ customer: "confidential" }] },
      },
      rows: [{ customer: "confidential" }],
    }),
    {
      event: "analysis_completed",
      converterUploadId: "upload-1",
      targetTemplateId: "bsn_sales",
      sourceSignatureHash: "source-hash",
      summary: {
        dataRowCount: 2,
        documentCount: 1,
        recognizedColumns: 6,
        unresolvedColumns: 0,
        mappingCounts: { mapped: 6, default: 1, formula: 4 },
        issueCounts: { blocker: 2, warning: 1, info: 0 },
        masterDataStatus: "not_configured",
        explanationCount: 77,
        stateHash: "state-1",
      },
      status: "analyzed",
    },
  );
});

test("internal analysis_completed uses an atomic conditional update and remains idempotent", async () => {
  process.env.CONVERTER_SERVICE_TOKEN = "converter-service-secret";
  const session = {
    _id: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439012",
    workspaceId: null,
    ownerScope: "user:507f1f77bcf86cd799439012",
    status: "created",
    retentionExpiresAt: new Date(Date.now() + 60_000),
    file: { originalName: "sales.xlsx", sizeBytes: 100, rawRetained: false },
  };
  const token = createStudentContextToken({
    sessionId: session._id,
    userId: session.userId,
    ownerScope: session.ownerScope,
    allowedScopes: ["analyze", "explain"],
  });
  const originalFindOne = StudentFileSession.findOne;
  const originalFindOneAndUpdate = StudentFileSession.findOneAndUpdate;
  const updateCalls = [];
  let fallbackReads = 0;
  StudentFileSession.findOne = async () => {
    fallbackReads += 1;
    return session;
  };
  StudentFileSession.findOneAndUpdate = async (filter, update, options) => {
    updateCalls.push({ filter, update, options });
    const incomingUploadId = update.$set.converterUploadId;
    if (session.converterUploadId && session.converterUploadId !== incomingUploadId) {
      return null;
    }
    Object.assign(session, update.$set);
    return session;
  };

  const response = {
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
  try {
    await recordStudentAnalysisCompleted(
      {
        params: { id: session._id },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": token,
        },
        body: {
          event: "analysis_completed",
          converterUploadId: "upload-1",
          targetTemplateId: "bsn_sales",
          sourceSignatureHash: "source-hash",
          summary: { dataRowCount: 2, rawRows: [{ secret: true }] },
        },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(session.status, "analyzed");
    assert.equal(session.converterUploadId, "upload-1");
    assert.equal(session.targetTemplateId, "bsn_sales");
    assert.equal(session.sourceSignatureHash, "source-hash");
    assert.deepEqual(session.summary, { dataRowCount: 2 });
    assert.equal(fallbackReads, 0);
    assert.deepEqual(updateCalls[0].filter.$or, [
      { converterUploadId: "" },
      { converterUploadId: "upload-1" },
      { converterUploadId: { $exists: false } },
      { converterUploadId: null },
    ]);
    assert.equal(updateCalls[0].filter.ownerScope, session.ownerScope);
    assert.equal(updateCalls[0].filter.workspaceId, null);
    assert.equal(updateCalls[0].options.new, true);
    assert.equal(updateCalls[0].options.runValidators, true);

    const idempotent = { ...response, statusCode: 200, body: null };
    await recordStudentAnalysisCompleted(
      {
        params: { id: session._id },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": token,
        },
        body: {
          event: "analysis_completed",
          converterUploadId: "upload-1",
          targetTemplateId: "bsn_sales",
          sourceSignatureHash: "source-hash-refreshed",
          summary: { dataRowCount: 2, explanationCount: 5 },
        },
      },
      idempotent,
    );
    assert.equal(idempotent.statusCode, 200);
    assert.equal(session.converterUploadId, "upload-1");
    assert.equal(session.sourceSignatureHash, "source-hash-refreshed");
    assert.equal(fallbackReads, 0);

    const conflict = { ...response, statusCode: 200, body: null };
    await recordStudentAnalysisCompleted(
      {
        params: { id: session._id },
        headers: {
          "x-converter-service-token": "converter-service-secret",
          "x-student-context": token,
        },
        body: {
          event: "analysis_completed",
          converterUploadId: "upload-2",
          targetTemplateId: "bsn_sales",
          sourceSignatureHash: "source-hash-2",
          summary: { dataRowCount: 3 },
        },
      },
      conflict,
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal(session.converterUploadId, "upload-1");
    assert.equal(session.sourceSignatureHash, "source-hash-refreshed");
    assert.equal(fallbackReads, 1);
  } finally {
    StudentFileSession.findOne = originalFindOne;
    StudentFileSession.findOneAndUpdate = originalFindOneAndUpdate;
  }

  const rejected = { ...response, statusCode: 200, body: null };
  await recordStudentAnalysisCompleted(
    {
      params: { id: session._id },
      headers: {
        "x-converter-service-token": "wrong",
        "x-student-context": token,
      },
      body: { event: "analysis_completed" },
    },
    rejected,
  );
  assert.equal(rejected.statusCode, 401);
});
