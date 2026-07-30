const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  ARTIFACT_TYPES,
  IMPORT_STATUSES,
  MATCH_STATUSES,
  REPAIR_STATUSES,
  RESOLUTION_SCOPES,
  RESOLUTION_STATUSES,
  RETRY_STATUSES,
} = require("../constants/misaImportRepair");
const MisaImportRepairSession = require("../models/MisaImportRepairSession");
const MisaImportRepairConfirmation = require("../models/MisaImportRepairConfirmation");
const MisaImportIssue = require("../models/MisaImportIssue");
const MisaRetryBatch = require("../models/MisaRetryBatch");
const ConversionArtifact = require("../models/ConversionArtifact");
const {
  ensureMisaImportRepairIndexes,
} = require("../services/misaImportRepairMigrationService");
const {
  createConversionArtifactService,
} = require("../services/conversionArtifactService");

const OBJECT_ID = "507f1f77bcf86cd799439011";
const FUTURE = new Date(Date.now() + 60_000);
const RETRY_CONFIRMATION_STATEMENT = "Toàn bộ chứng từ này chưa được MISA nhập";

function sessionInput(summary = {}) {
  return {
    user: OBJECT_ID,
    conversionRun: "507f1f77bcf86cd799439012",
    ownerScope: `user:${OBJECT_ID}`,
    operationSessionId: "session-1",
    targetTemplateId: "bsn_sales",
    manifestArtifactKey: "manifest-key",
    manifestSha256: "a".repeat(64),
    errorArtifactKey: "error-key",
    errorSha256: "b".repeat(64),
    expiresAt: FUTURE,
    status: "retry_ready",
    summary,
  };
}

function retryBatchInput(overrides = {}) {
  return {
    repairSession: "507f1f77bcf86cd799439013",
    ownerScope: `user:${OBJECT_ID}`,
    exportBatchId: "export-batch-1",
    idempotencyKey: "retry-batch-1",
    documentGroupIds: ["document-group-1"],
    createdBy: OBJECT_ID,
    expiresAt: FUTURE,
    confirmation: {
      statement: RETRY_CONFIRMATION_STATEMENT,
      confirmedBy: OBJECT_ID,
      confirmedAt: FUTURE,
    },
    ...overrides,
  };
}

function memoryArtifactRepository() {
  const documents = [];
  return {
    documents,
    async create(metadata) {
      documents.push({ ...metadata });
      return documents.at(-1);
    },
    async findLatest() {
      return null;
    },
  };
}

test("repair constants define the approved persistence vocabularies", () => {
  assert.deepEqual(REPAIR_STATUSES, [
    "uploaded",
    "needs_schema_mapping",
    "needs_match_review",
    "ready_for_repair",
    "retry_blocked",
    "retry_ready",
    "retry_exported",
    "closed",
    "failed",
  ]);
  assert.deepEqual(MATCH_STATUSES, ["unmatched", "suggested", "ambiguous", "confirmed", "rejected"]);
  assert.deepEqual(IMPORT_STATUSES, ["unknown", "failed", "imported"]);
  assert.deepEqual(RETRY_STATUSES, ["pending", "validating", "blocked", "exporting", "completed", "failed", "expired"]);
  assert.deepEqual(RESOLUTION_STATUSES, ["unresolved", "resolved", "dismissed"]);
  assert.deepEqual(RESOLUTION_SCOPES, ["once", "profile_proposal", "master_data_proposal"]);
  assert.deepEqual(ARTIFACT_TYPES, ["precheck_result", "failed_rows", "unrecognized"]);
});

test("unknown import status cannot be retry-ready", async () => {
  const doc = new MisaImportRepairSession(sessionInput({ unknownDocumentGroups: 1 }));

  await assert.rejects(doc.validate(), /chưa xác định trạng thái import/i);
});

for (const [summaryField, label] of [
  ["ambiguousIssues", "match mơ hồ"],
  ["unmatchedIssues", "issue chưa match"],
  ["unresolvedIssues", "issue chưa được xử lý"],
]) {
  test(`retry-ready requires zero ${summaryField}`, async () => {
    const doc = new MisaImportRepairSession(sessionInput({ [summaryField]: 1 }));

    await assert.rejects(doc.validate(), new RegExp(label, "i"));
  });
}

test("issue confirmation requires one document group", async () => {
  const issue = new MisaImportIssue({
    repairSession: "507f1f77bcf86cd799439013",
    ownerScope: `user:${OBJECT_ID}`,
    issueKey: "issue-1",
    technicalMessage: "Mã đối tượng không tồn tại",
    matchStatus: "confirmed",
    expiresAt: FUTURE,
  });

  await assert.rejects(issue.validate(), /document group/i);
});

test("retry batch requires the explicit MISA non-import acknowledgement", async () => {
  const batch = new MisaRetryBatch(retryBatchInput({ confirmation: undefined }));

  await assert.rejects(batch.validate(), /confirmation/i);
});

for (const missingField of ["statement", "confirmedBy", "confirmedAt"]) {
  test(`retry batch requires confirmation ${missingField}`, async () => {
    const confirmation = {
      statement: RETRY_CONFIRMATION_STATEMENT,
      confirmedBy: OBJECT_ID,
      confirmedAt: FUTURE,
    };
    delete confirmation[missingField];
    const batch = new MisaRetryBatch(retryBatchInput({ confirmation }));

    await assert.rejects(batch.validate(), /confirmation/i);
  });
}

test("retry batch only accepts the exact MISA non-import acknowledgement", async () => {
  const batch = new MisaRetryBatch(retryBatchInput({
    confirmation: {
      statement: "Chứng từ có thể chưa được MISA nhập",
      confirmedBy: OBJECT_ID,
      confirmedAt: FUTURE,
    },
  }));

  await assert.rejects(batch.validate(), /toàn bộ chứng từ này chưa được misa nhập/i);
});

test("retry batch persists the acknowledgement, confirmer, and timestamp", async () => {
  const batch = new MisaRetryBatch(retryBatchInput());

  await batch.validate();

  assert.equal(batch.confirmation.statement, RETRY_CONFIRMATION_STATEMENT);
  assert.equal(String(batch.confirmation.confirmedBy), OBJECT_ID);
  assert.equal(batch.confirmation.confirmedAt.getTime(), FUTURE.getTime());
});

test("human confirmation tokens persist immutable action, payload, ownership, and TTL bindings", async () => {
  const confirmation = new MisaImportRepairConfirmation({
    repairSession: "507f1f77bcf86cd799439013",
    user: OBJECT_ID,
    ownerScope: `user:${OBJECT_ID}`,
    action: "retry_export",
    payloadHash: "c".repeat(64),
    sessionVersion: 4,
    tokenHash: "d".repeat(64),
    issuedAt: new Date(),
    expiresAt: FUTURE,
  });
  await confirmation.validate();
  assert.equal(confirmation.consumedAt, null);
  assert.equal(MisaImportRepairConfirmation.schema.path("tokenHash").options.unique, true);
  assert.ok(MisaImportRepairConfirmation.schema.indexes().some(([fields, options]) =>
    fields.expiresAt === 1 && options.expireAfterSeconds === 0,
  ));
  assert.ok(MisaRetryBatch.schema.path("mutationId"));
  assert.ok(MisaRetryBatch.schema.path("recoveryState"));
});

test("human confirmation consumption is atomic in real Mongo", {
  skip: !(process.env.MISA_IMPORT_REPAIR_TEST_MONGO_URI || process.env.MONGO_URI),
}, async () => {
  const uri = process.env.MISA_IMPORT_REPAIR_TEST_MONGO_URI || process.env.MONGO_URI;
  const wasConnected = mongoose.connection.readyState === 1;
  if (!wasConnected) await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const collectionName = `misa_repair_confirmation_${Date.now()}_${process.pid}`;
  const modelName = `MisaRepairConfirmation_${Date.now()}_${process.pid}`;
  const TestModel = mongoose.model(modelName, MisaImportRepairConfirmation.schema, collectionName);
  try {
    await TestModel.createIndexes();
    await TestModel.create({
      repairSession: "507f1f77bcf86cd799439013",
      user: OBJECT_ID,
      ownerScope: `user:${OBJECT_ID}`,
      action: "retry_export",
      payloadHash: "c".repeat(64),
      sessionVersion: 4,
      tokenHash: "d".repeat(64),
      issuedAt: new Date(),
      expiresAt: FUTURE,
    });
    const filter = {
      tokenHash: "d".repeat(64),
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    };
    const consumed = await Promise.all([
      TestModel.findOneAndUpdate(filter, { $set: { consumedAt: new Date() } }, { new: true }),
      TestModel.findOneAndUpdate(filter, { $set: { consumedAt: new Date() } }, { new: true }),
    ]);
    assert.equal(consumed.filter(Boolean).length, 1);
  } finally {
    await TestModel.collection.drop();
    mongoose.deleteModel(modelName);
    if (!wasConnected) await mongoose.disconnect();
  }
});

for (const documentGroupIds of [[""], ["   "], ["document-group-1", "document-group-1"]]) {
  test(`retry batch rejects invalid document groups: ${JSON.stringify(documentGroupIds)}`, async () => {
    const batch = new MisaRetryBatch(retryBatchInput({ documentGroupIds }));

    await assert.rejects(batch.validate(), /document group/i);
  });
}

test("Phase 1 adapter cannot claim verification", async () => {
  const session = new MisaImportRepairSession({
    ...sessionInput(),
    adapter: { verified: true },
  });

  await assert.rejects(session.validate(), /unverified|false/i);
  assert.equal(MisaImportRepairSession.schema.path("adapter.verified").options.immutable, true);
});

test("repair models expose tenant, expiry, and status contracts", () => {
  for (const [Model, statusValues] of [
    [MisaImportRepairSession, REPAIR_STATUSES],
    [MisaRetryBatch, RETRY_STATUSES],
  ]) {
    assert.ok(Model.schema.path("ownerScope"));
    assert.ok(Model.schema.path("workspace"));
    assert.ok(Model.schema.path("expiresAt"));
    assert.ok(Model.schema.indexes().some(([fields, options]) =>
      fields.expiresAt === 1 && options.expireAfterSeconds === 0,
    ));
    assert.deepEqual(Model.schema.path("status").enumValues, statusValues);
  }
  assert.ok(MisaImportIssue.schema.path("ownerScope"));
  assert.ok(MisaImportIssue.schema.path("workspace"));
  assert.ok(MisaImportIssue.schema.path("expiresAt"));
  assert.ok(MisaImportIssue.schema.indexes().some(([fields, options]) =>
    fields.expiresAt === 1 && options.expireAfterSeconds === 0,
  ));
  assert.deepEqual(MisaImportIssue.schema.path("matchStatus").enumValues, MATCH_STATUSES);
  assert.deepEqual(
    MisaImportIssue.schema.path("resolution.status").enumValues,
    RESOLUTION_STATUSES,
  );
  assert.deepEqual(
    MisaImportIssue.schema.path("resolution.scope").enumValues,
    RESOLUTION_SCOPES,
  );
  assert.ok(MisaRetryBatch.schema.path("documentGroupIds"));
});

test("repair create idempotency is scoped and bound to an immutable request fingerprint", () => {
  assert.ok(MisaImportRepairSession.schema.path("requestFingerprint"));
  assert.ok(MisaImportRepairSession.schema.path("uploadSha256"));
  const idempotencyIndex = MisaImportRepairSession.schema.indexes().find(([fields]) =>
    fields.user === 1 &&
    fields.ownerScope === 1 &&
    fields.idempotencyKey === 1,
  );
  assert.ok(idempotencyIndex);
  assert.equal(MisaImportRepairSession.schema.path("idempotencyKey").options.default, undefined);
  assert.ok(idempotencyIndex && idempotencyIndex[1].partialFilterExpression);
  assert.deepEqual(idempotencyIndex[1].partialFilterExpression, {
    idempotencyKey: { $type: "string" },
  });
  assert.ok(idempotencyIndex && idempotencyIndex[1].unique === true);
  assert.ok(MisaImportRepairSession.schema.indexes().some(([fields, options]) =>
    fields.user === 1 &&
    fields.ownerScope === 1 &&
    fields.idempotencyKey === 1 &&
    options.unique === true &&
    options.partialFilterExpression?.idempotencyKey?.$type === "string",
  ));
  assert.ok(MisaImportRepairSession.schema.path("activeSchemaGenerationId"));
  assert.ok(MisaImportIssue.schema.path("schemaGenerationId"));
});

test("repair idempotency startup migration drops legacy index and unsets persisted null keys", async () => {
  const calls = [];
  const model = {
    db: { readyState: 1 },
    collection: {
      async indexes() {
        return [
          {
            name: "user_1_idempotencyKey_1",
            key: { user: 1, idempotencyKey: 1 },
            unique: true,
          },
          {
            name: "user_1_ownerScope_1_idempotencyKey_1",
            key: { user: 1, ownerScope: 1, idempotencyKey: 1 },
            unique: true,
          },
        ];
      },
      async dropIndex(name) { calls.push(["dropIndex", name]); },
    },
    async updateMany(filter, update) {
      calls.push(["updateMany", filter, update]);
      return { modifiedCount: 2 };
    },
    async createIndexes() { calls.push(["createIndexes"]); },
  };

  const result = await ensureMisaImportRepairIndexes({ model });

  assert.deepEqual(calls, [
    ["dropIndex", "user_1_idempotencyKey_1"],
    ["dropIndex", "user_1_ownerScope_1_idempotencyKey_1"],
    ["updateMany", { idempotencyKey: { $type: "null" } }, { $unset: { idempotencyKey: 1 } }],
    ["createIndexes"],
  ]);
  assert.deepEqual(result, {
    skipped: false,
    droppedIndexes: [
      "user_1_idempotencyKey_1",
      "user_1_ownerScope_1_idempotencyKey_1",
    ],
    unsetNullKeys: 2,
  });
});

test("repair idempotency permits no-key siblings and arbitrates keyed races in real Mongo", {
  skip: !(process.env.MISA_IMPORT_REPAIR_TEST_MONGO_URI || process.env.MONGO_URI),
}, async () => {
  const uri = process.env.MISA_IMPORT_REPAIR_TEST_MONGO_URI || process.env.MONGO_URI;
  const wasConnected = mongoose.connection.readyState === 1;
  if (!wasConnected) await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const collectionName = `misa_repair_idempotency_${Date.now()}_${process.pid}`;
  const modelName = `MisaRepairIdempotency_${Date.now()}_${process.pid}`;
  const TestModel = mongoose.model(modelName, MisaImportRepairSession.schema, collectionName);
  try {
    await TestModel.createIndexes();
    const base = {
      user: OBJECT_ID,
      ownerScope: `user:${OBJECT_ID}`,
      operationSessionId: "operation-",
      targetTemplateId: "bsn_sales",
      manifestArtifactKey: "manifest-key",
      manifestSha256: "a".repeat(64),
      errorArtifactKey: "error-key",
      errorSha256: "b".repeat(64),
      expiresAt: FUTURE,
      status: "uploaded",
    };
    await Promise.all([
      TestModel.create({ ...base, conversionRun: "507f1f77bcf86cd799439021", operationSessionId: "operation-1" }),
      TestModel.create({ ...base, conversionRun: "507f1f77bcf86cd799439022", operationSessionId: "operation-2" }),
    ]);
    const keyed = await Promise.allSettled([
      TestModel.create({ ...base, conversionRun: "507f1f77bcf86cd799439023", operationSessionId: "operation-3", idempotencyKey: "race-key" }),
      TestModel.create({ ...base, conversionRun: "507f1f77bcf86cd799439024", operationSessionId: "operation-4", idempotencyKey: "race-key" }),
    ]);
    assert.equal(keyed.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(keyed.filter((item) => item.status === "rejected" && item.reason?.code === 11000).length, 1);
    assert.equal(await TestModel.countDocuments({ idempotencyKey: { $type: "null" } }), 0);
  } finally {
    await TestModel.collection.drop();
    mongoose.deleteModel(modelName);
    if (!wasConnected) await mongoose.disconnect();
  }
});

test("repair artifact kinds stay owner-bound with bytes outside Mongo metadata", async () => {
  const repository = memoryArtifactRepository();
  const stored = [];
  const service = createConversionArtifactService({
    repository,
    storageAdapter: {
      async putArtifact(input) {
        stored.push(input);
        return {
          objectId: `gridfs-${stored.length}`,
          sha256: require("node:crypto").createHash("sha256").update(input.bytes).digest("hex"),
          sizeBytes: input.bytes.length,
        };
      },
      async deleteArtifact() {
        return { deleted: true };
      },
    },
  });
  const contentTypes = [
    ["manifest", "application/json"],
    ["import_result", "application/vnd.ms-excel"],
    ["repair_state", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["retry_output", "text/plain"],
  ];

  for (const [kind, contentType] of contentTypes) {
    const revision = stored.length + 1;
    const artifact = await service.putArtifact({
      sessionId: "session-1",
      runId: "run-1",
      ownerScope: "user:user-1",
      userId: "user-1",
      uploadId: "upload-1",
      targetTemplateId: "bsn_sales",
      kind,
      revision,
      content: Buffer.from(`${kind}-${contentType}`),
      contentType,
      expiresAt: FUTURE,
    });
    assert.match(artifact.gridFsObjectId, /^gridfs-/);
    assert.equal(artifact.mime, contentType);
    assert.equal(artifact.ownerScope, "user:user-1");
  }

  assert.equal(repository.documents.some((document) => document.bytes || document.content), false);

  const artifactKinds = ConversionArtifact.schema.path("kind").enumValues;
  for (const kind of ["manifest", "import_result", "repair_state", "retry_output"]) {
    assert.ok(artifactKinds.includes(kind));
  }
});
