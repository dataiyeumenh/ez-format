const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PassThrough, Readable } = require("node:stream");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  createMisaImportRepairService,
  createMisaImportRepairMetrics,
  emitMisaImportRepairAuditEvent,
  emitMisaImportRepairMetric,
  getMisaImportRepairMetricSnapshot,
  renderMisaImportRepairPrometheusMetrics,
  setMisaImportRepairMetrics,
} = require("../services/misaImportRepairService");
const {
  startMisaImportRepairSweeper,
  sweepExpiredMisaImportRepairRecords,
} = require("../services/misaImportRepairSweeper");

function memoryExpiredModel(name, documents, operations, readyState = 1, failDelete = false) {
  return {
    db: { readyState },
    find(filter) {
      assert.deepEqual(filter, { expiresAt: { $lte: new Date("2026-07-29T12:00:00.000Z") } });
      let limit = Infinity;
      const query = {
        sort(value) {
          assert.deepEqual(value, { expiresAt: 1, _id: 1 });
          return query;
        },
        limit(value) {
          limit = value;
          return query;
        },
        select(value) {
          assert.deepEqual(value, { _id: 1 });
          return query;
        },
        lean: async () => documents.slice(0, limit).map((document) => ({ _id: document._id })),
      };
      return query;
    },
    async deleteMany(filter) {
      operations.push(name);
      if (failDelete) {
        failDelete = false;
        throw new Error(`${name} cleanup unavailable`);
      }
      const selected = new Set(filter._id.$in.map(String));
      const before = documents.length;
      for (let index = documents.length - 1; index >= 0; index -= 1) {
        if (selected.has(String(documents[index]._id))) documents.splice(index, 1);
      }
      return { deletedCount: before - documents.length };
    },
  };
}

function emptyModel(operations, name) {
  return memoryExpiredModel(name, [], operations);
}

test("repair retention removes expired children before sessions in bounded batches", async () => {
  const operations = [];
  const confirmationDocuments = [{ _id: "confirmation-1" }];
  const retryDocuments = [{ _id: "retry-1" }];
  const issueDocuments = [{ _id: "issue-1" }, { _id: "issue-2" }, { _id: "issue-3" }];
  const sessionDocuments = [{ _id: "session-1" }, { _id: "session-2" }, { _id: "session-3" }];
  const models = {
    Confirmation: memoryExpiredModel("confirmation", confirmationDocuments, operations),
    RetryBatch: memoryExpiredModel("retry", retryDocuments, operations),
    Issue: memoryExpiredModel("issue", issueDocuments, operations),
    RepairSession: memoryExpiredModel("session", sessionDocuments, operations),
  };

  const result = await sweepExpiredMisaImportRepairRecords({
    models,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
    limit: 2,
  });

  assert.deepEqual(result.deleted, {
    confirmations: 1,
    retryBatches: 1,
    issues: 2,
    repairSessions: 2,
  });
  assert.deepEqual(operations, ["confirmation", "retry", "issue", "session"]);
  assert.deepEqual(confirmationDocuments, []);
  assert.deepEqual(retryDocuments, []);
  assert.deepEqual(issueDocuments.map((item) => item._id), ["issue-3"]);
  assert.deepEqual(sessionDocuments.map((item) => item._id), ["session-3"]);
});

test("repair sweeper reports partial cleanup and retries only failed collections", async () => {
  const collectionNames = ["confirmation", "retry", "issue", "session"];
  for (const failingName of collectionNames) {
    const operations = [];
    const documents = {
      Confirmation: emptyModel(operations, "confirmation"),
      RetryBatch: emptyModel(operations, "retry"),
      Issue: emptyModel(operations, "issue"),
      RepairSession: emptyModel(operations, "session"),
    };
    const modelName = {
      confirmation: "Confirmation",
      retry: "RetryBatch",
      issue: "Issue",
      session: "RepairSession",
    }[failingName];
    documents[modelName] = memoryExpiredModel(
      failingName,
      [{ _id: `${failingName}-1` }],
      operations,
      1,
      true,
    );

    const first = await sweepExpiredMisaImportRepairRecords({
      models: documents,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
      limit: 10,
    });
    assert.equal(first.failed, true, failingName);
    assert.deepEqual(first.failedCollections, [modelName], failingName);
    assert.deepEqual(first.deleted, {
      confirmations: 0,
      retryBatches: 0,
      issues: 0,
      repairSessions: 0,
    });

    const retry = await sweepExpiredMisaImportRepairRecords({
      models: documents,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
      limit: 10,
    });
    assert.equal(retry.failed, false, failingName);
    const resultKey = {
      confirmation: "confirmations",
      retry: "retryBatches",
      issue: "issues",
      session: "repairSessions",
    }[failingName];
    assert.equal(retry.deleted[resultKey], 1, failingName);
    const idempotent = await sweepExpiredMisaImportRepairRecords({
      models: documents,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
      limit: 10,
    });
    assert.equal(idempotent.failed, false, failingName);
    assert.deepEqual(idempotent.deleted, {
      confirmations: 0,
      retryBatches: 0,
      issues: 0,
      repairSessions: 0,
    });
  }

  const operations = [];
  const models = {
    Confirmation: emptyModel(operations, "confirmation"),
    RetryBatch: emptyModel(operations, "retry"),
    Issue: memoryExpiredModel("issue", [{ _id: "issue-partial" }], operations),
    RepairSession: memoryExpiredModel(
      "session",
      [{ _id: "session-partial" }],
      operations,
      1,
      true,
    ),
  };
  const partial = await sweepExpiredMisaImportRepairRecords({
    models,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
    limit: 10,
  });
  assert.equal(partial.failed, true);
  assert.deepEqual(partial.failedCollections, ["RepairSession"]);
  assert.deepEqual(partial.deleted, {
    confirmations: 0,
    retryBatches: 0,
    issues: 1,
    repairSessions: 0,
  });
});

test("repair sweeper tolerates unavailable Mongo and owns one non-blocking timer", async () => {
  let scheduled;
  let clearCalls = 0;
  let unrefCalls = 0;
  const handle = { unref() { unrefCalls += 1; } };
  const unavailable = memoryExpiredModel("session", [], [], 0);
  const models = {
    Confirmation: unavailable,
    RetryBatch: unavailable,
    Issue: unavailable,
    RepairSession: unavailable,
  };
  const logs = [];
  const options = {
    models,
    env: {
      MISA_IMPORT_REPAIR_SWEEP_INTERVAL_SECONDS: "60",
      MISA_IMPORT_REPAIR_SWEEP_BATCH_SIZE: "25",
    },
    setIntervalImpl(callback, intervalMs) {
      scheduled = { callback, intervalMs };
      return handle;
    },
    clearIntervalImpl(value) {
      assert.equal(value, handle);
      clearCalls += 1;
    },
    logger: { info(line) { logs.push(JSON.parse(line)); } },
  };

  const first = startMisaImportRepairSweeper(options);
  const duplicate = startMisaImportRepairSweeper(options);
  assert.equal(duplicate, first);
  assert.equal(scheduled.intervalMs, 60_000);
  assert.equal(unrefCalls, 1);
  assert.deepEqual(await first.ready, {
    skipped: true,
    reason: "database_unavailable",
    deleted: { confirmations: 0, retryBatches: 0, issues: 0, repairSessions: 0 },
  });
  assert.equal(logs.at(-1).event, "misa_import_repair.sweep.skipped");

  await scheduled.callback();
  first.stop();
  duplicate.stop();
  assert.equal(clearCalls, 1);
});

test("repair sweeper ownership keeps concurrent server timers independent", async () => {
  const handles = [];
  const models = {
    Confirmation: emptyModel([], "confirmation"),
    RetryBatch: emptyModel([], "retry"),
    Issue: emptyModel([], "issue"),
    RepairSession: emptyModel([], "session"),
  };
  const makeOptions = (owner) => ({
    owner,
    models,
    env: { MISA_IMPORT_REPAIR_SWEEP_INTERVAL_SECONDS: "60" },
    setIntervalImpl(callback) {
      const timer = { callback, cleared: false, unref() {} };
      handles.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) { timer.cleared = true; },
    logger: { info() {} },
  });
  const first = startMisaImportRepairSweeper(makeOptions({ name: "server-a" }));
  const second = startMisaImportRepairSweeper(makeOptions({ name: "server-b" }));
  assert.notEqual(first, second);
  first.stop();
  assert.equal(handles[0].cleared, true);
  assert.equal(handles[1].cleared, false);
  await handles[1].callback();
  second.stop();
});

test("repair audit logger applies a strict field and nested metric allowlist", () => {
  const lines = [];
  const forbiddenValues = [
    "technical-secret",
    "raw-row-secret",
    "Nguyen Van A",
    "0312345678",
    "INV-000042",
    "987654321.00",
    "Bearer token-secret",
    "https://artifact.example/private?token=secret",
  ];
  const event = emitMisaImportRepairAuditEvent({
    requestId: crypto.randomUUID(),
    event: "misa_import_repair.schema.completed",
    repairId: new mongoose.Types.ObjectId().toString(),
    conversionRunId: new mongoose.Types.ObjectId().toString(),
    workspaceId: new mongoose.Types.ObjectId().toString(),
    adapterId: "manual_excel_v1",
    artifactType: "failed_rows",
    issueCount: 3,
    matchStatusCounts: {
      unmatched: 1,
      ambiguous: 1,
      confirmed: 1,
      technicalMessage: forbiddenValues[0],
    },
    retryBatchId: new mongoose.Types.ObjectId().toString(),
    durationMs: 12,
    statusCode: 200,
    technicalMessage: forbiddenValues[0],
    rawRows: [{ value: forbiddenValues[1] }],
    name: forbiddenValues[2],
    taxId: forbiddenValues[3],
    invoiceNumber: forbiddenValues[4],
    amount: forbiddenValues[5],
    authorization: forbiddenValues[6],
    artifactUrl: forbiddenValues[7],
  }, { logger: { info(line) { lines.push(line); } } });

  assert.deepEqual(Object.keys(event), [
    "requestId",
    "event",
    "repairId",
    "conversionRunId",
    "workspaceId",
    "adapterId",
    "artifactType",
    "issueCount",
    "matchStatusCounts",
    "retryBatchId",
    "durationMs",
    "statusCode",
  ]);
  assert.deepEqual(event.matchStatusCounts, { unmatched: 1, ambiguous: 1, confirmed: 1 });
  const serialized = lines.join("\n");
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false, value);
});

test("audit schema drops hostile identifier-shaped accounting content", () => {
  const lines = [];
  const hostile = "INV-000042";
  const event = emitMisaImportRepairAuditEvent({
    requestId: hostile,
    event: hostile,
    repairId: hostile,
    conversionRunId: hostile,
    workspaceId: hostile,
    adapterId: hostile,
    artifactType: hostile,
    retryBatchId: hostile,
    technicalMessage: hostile,
  }, { logger: { info(line) { lines.push(line); } } });
  assert.equal(JSON.stringify(event).includes(hostile), false);
  assert.equal(lines.join("\n").includes(hostile), false);

  const safe = emitMisaImportRepairAuditEvent({
    requestId: crypto.randomUUID(),
    event: "misa_import_repair.create.completed",
    repairId: new mongoose.Types.ObjectId().toString(),
    conversionRunId: crypto.randomUUID(),
    retryBatchId: new mongoose.Types.ObjectId().toString(),
    artifactType: "failed_rows",
  });
  assert.match(safe.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(safe.artifactType, "failed_rows");
});

test("retry artifact download rejects metadata from another workspace", async () => {
  const userId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const wrongWorkspaceId = new mongoose.Types.ObjectId();
  const repairId = new mongoose.Types.ObjectId();
  const runId = new mongoose.Types.ObjectId();
  const batchId = new mongoose.Types.ObjectId();
  const repair = {
    _id: repairId,
    user: userId,
    workspace: workspaceId,
    conversionRun: runId,
    ownerScope: `workspace:${workspaceId}`,
    targetTemplateId: "bsn_sales",
    expiresAt: new Date(Date.now() + 60_000),
    version: 1,
  };
  const retryBytes = Buffer.from("private-retry");
  const retrySha256 = crypto.createHash("sha256").update(retryBytes).digest("hex");
  const service = createMisaImportRepairService({
    RepairSession: { findOne: async () => repair },
    Workspace: {
      findOne: async () => ({ _id: workspaceId, owner: userId, members: [], isActive: true }),
    },
    Run: {
      findOne: async () => ({
        _id: runId,
        user: userId,
        workspace: workspaceId,
        status: "completed",
        exportArtifactKey: "output-key",
        outputSha256: "a".repeat(64),
        converterUploadId: "upload-1",
        targetTemplateId: "bsn_sales",
      }),
    },
    RetryBatch: {
      findOne: async () => ({
        _id: batchId,
        repairSession: repairId,
        ownerScope: `workspace:${workspaceId}`,
        workspace: workspaceId,
        status: "completed",
        readinessSummary: { sequence: 1 },
        outputArtifactKey: "retry-key",
        outputSha256: retrySha256,
      }),
    },
    artifacts: {
      getArtifact: async (input) => ({
        metadata: {
          gridFsObjectId: "retry-key",
          sha256: retrySha256,
          sizeBytes: retryBytes.length,
          userId: String(userId),
          workspaceId: String(wrongWorkspaceId),
          ownerScope: `workspace:${workspaceId}`,
          runId: String(runId),
          sessionId: String(repairId),
          uploadId: "upload-1",
          targetTemplateId: "bsn_sales",
          kind: "retry_output",
          revision: input.revision,
          mime: "application/vnd.ms-excel",
          status: "available",
          expiresAt: new Date(Date.now() + 60_000),
        },
        content: Readable.from([retryBytes]),
      }),
    },
    now: () => new Date(),
  });

  await assert.rejects(
    service.downloadRetryBatch({ userId, repairId, batchId }),
    (error) => error.statusCode === 404 && error.code === "RETRY_ARTIFACT_NOT_FOUND",
  );
});

test("retry artifact download rejects an expired batch before retrieving artifact bytes", async () => {
  const userId = new mongoose.Types.ObjectId();
  const repairId = new mongoose.Types.ObjectId();
  const runId = new mongoose.Types.ObjectId();
  const batchId = new mongoose.Types.ObjectId();
  let artifactReads = 0;
  const service = createMisaImportRepairService({
    RepairSession: {
      findOne: async () => ({
        _id: repairId,
        user: userId,
        conversionRun: runId,
        ownerScope: `user:${userId}`,
        targetTemplateId: "bsn_sales",
        expiresAt: new Date(Date.now() + 60_000),
        version: 1,
      }),
    },
    Workspace: { findOne: async () => null },
    Run: {
      findOne: async () => ({
        _id: runId,
        user: userId,
        status: "completed",
        exportArtifactKey: "output-key",
        outputSha256: "a".repeat(64),
        converterUploadId: "upload-1",
        targetTemplateId: "bsn_sales",
      }),
    },
    RetryBatch: {
      findOne: async () => ({
        _id: batchId,
        repairSession: repairId,
        ownerScope: `user:${userId}`,
        workspace: null,
        status: "completed",
        expiresAt: new Date(Date.now() - 1),
        readinessSummary: { sequence: 1 },
        outputArtifactKey: "retry-key",
        outputSha256: "b".repeat(64),
      }),
    },
    artifacts: {
      getArtifact: async () => {
        artifactReads += 1;
        throw new Error("artifact retrieval must not run for expired batch");
      },
    },
    now: () => new Date(),
  });

  await assert.rejects(
    service.downloadRetryBatch({ userId, repairId, batchId }),
    (error) => error.statusCode === 410 && error.code === "RETRY_BATCH_EXPIRED",
  );
  assert.equal(artifactReads, 0);
});

test("retry download reports session, batch, and artifact expiry as 410 independently", async () => {
  const userId = new mongoose.Types.ObjectId();
  const repairId = new mongoose.Types.ObjectId();
  const runId = new mongoose.Types.ObjectId();
  const batchId = new mongoose.Types.ObjectId();
  const baseRepair = {
    _id: repairId,
    user: userId,
    conversionRun: runId,
    ownerScope: `user:${userId}`,
    targetTemplateId: "bsn_sales",
    version: 1,
  };
  const baseRun = {
    _id: runId,
    user: userId,
    status: "completed",
    exportArtifactKey: "output-key",
    outputSha256: "a".repeat(64),
    converterUploadId: "upload-1",
    targetTemplateId: "bsn_sales",
  };
  const baseBatch = {
    _id: batchId,
    repairSession: repairId,
    ownerScope: `user:${userId}`,
    workspace: null,
    status: "completed",
    expiresAt: new Date(Date.now() + 60_000),
    readinessSummary: { sequence: 1 },
    outputArtifactKey: "retry-key",
    outputSha256: "b".repeat(64),
  };
  async function runCase({ repair, batch, artifactError, expectedCode }) {
    let batchReads = 0;
    const service = createMisaImportRepairService({
      RepairSession: { findOne: async () => repair },
      Workspace: { findOne: async () => null },
      Run: { findOne: async () => baseRun },
      RetryBatch: {
        findOne: async () => {
          batchReads += 1;
          return batch;
        },
      },
      artifacts: {
        getArtifact: async () => {
          if (artifactError) throw Object.assign(new Error("expired"), artifactError);
          return {
            metadata: {
              storageKey: "retry-key",
              sha256: "b".repeat(64),
              userId: String(userId),
              ownerScope: `user:${userId}`,
              contentType: "application/vnd.ms-excel",
            },
            content: Buffer.from("private-retry"),
          };
        },
      },
      now: () => new Date(),
    });
    await assert.rejects(
      service.downloadRetryBatch({ userId, repairId, batchId }),
      (error) => error.statusCode === 410 && error.code === expectedCode,
    );
    return batchReads;
  }

  assert.equal(await runCase({
    repair: { ...baseRepair, expiresAt: new Date(Date.now() - 1) },
    batch: baseBatch,
    expectedCode: "REPAIR_EXPIRED",
  }), 0);
  assert.equal(await runCase({
    repair: { ...baseRepair, expiresAt: new Date(Date.now() + 60_000) },
    batch: { ...baseBatch, expiresAt: new Date(Date.now() - 1) },
    expectedCode: "RETRY_BATCH_EXPIRED",
  }), 1);
  assert.equal(await runCase({
    repair: { ...baseRepair, expiresAt: new Date(Date.now() + 60_000) },
    batch: baseBatch,
    artifactError: { statusCode: 410 },
    expectedCode: "RETRY_ARTIFACT_EXPIRED",
  }), 1);
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    type(value) { this.contentType = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  };
}

test("retry download pipelines the verified artifact stream to the response", async () => {
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  process.env.MISA_IMPORT_REPAIR_ENABLED = "true";
  const repairService = require("../services/misaImportRepairService");
  const originalDownload = repairService.downloadRetryBatch;
  repairService.downloadRetryBatch = async () => ({
    content: Readable.from([Buffer.from("retry-"), Buffer.from("workbook")]),
    contentType: "application/vnd.ms-excel",
    filename: "retry.xls",
    batch: { _id: "batch-1" },
  });
  const response = new PassThrough();
  const headers = {};
  response.status = (code) => { response.statusCode = code; return response; };
  response.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
  response.json = (body) => { response.errorBody = body; return response; };
  const chunks = [];
  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  try {
    const controller = require("../controllers/misaImportRepairController");
    await controller.downloadMisaImportRetryBatch({
      user: { _id: "user-1" },
      params: { repairId: "repair-1", batchId: "batch-1" },
      requestId: "download-stream",
    }, response);
    assert.equal(Buffer.concat(chunks).toString(), "retry-workbook");
    assert.equal(headers["content-type"], "application/vnd.ms-excel");
    assert.equal(response.errorBody, undefined);
  } finally {
    repairService.downloadRetryBatch = originalDownload;
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
});

test("disabled repair capability rejects create and retry consistently", async () => {
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  process.env.MISA_IMPORT_REPAIR_ENABLED = "false";
  const controller = require("../controllers/misaImportRepairController");
  try {
    const createResponse = responseRecorder();
    await controller.createMisaImportRepair(
      { body: {}, params: {}, headers: {}, requestId: "disabled-create" },
      createResponse,
    );
    const retryResponse = responseRecorder();
    await controller.createMisaImportRetryBatch(
      { body: {}, params: { repairId: new mongoose.Types.ObjectId().toString() }, headers: {}, requestId: "disabled-retry" },
      retryResponse,
    );
    assert.equal(createResponse.statusCode, 404);
    assert.equal(retryResponse.statusCode, 404);
  } finally {
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
});

test("repair metrics emit real bounded series for every disabled gateway operation", async () => {
  const calls = { counters: [], histograms: [] };
  const metrics = createMisaImportRepairMetrics({
    sink: {
      counter(name, value, labels) { calls.counters.push({ name, value, labels }); },
      histogram(name, value, labels) { calls.histograms.push({ name, value, labels }); },
    },
  });
  const restoreMetrics = setMisaImportRepairMetrics(metrics);
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  process.env.MISA_IMPORT_REPAIR_ENABLED = "false";
  const controller = require("../controllers/misaImportRepairController");
  const operations = [
    ["bulk_apply", controller.applyMisaImportRepairBulk],
    ["confirm_match", controller.confirmMisaImportRepairMatch],
    ["retry_create", controller.createMisaImportRetryBatch],
    ["create", controller.createMisaImportRepair],
    ["retry_download", controller.downloadMisaImportRetryBatch],
    ["confirmation_issue", controller.issueMisaImportRepairHumanConfirmation],
    ["read", controller.readMisaImportRepair],
    ["issue_resolve", controller.resolveMisaImportRepairIssue],
    ["import_status", controller.setMisaImportRepairImportStatus],
    ["bulk_simulate", controller.simulateMisaImportRepairBulk],
    ["schema", controller.submitMisaImportRepairSchema],
  ];
  try {
    for (const [, handler] of operations) {
      const response = responseRecorder();
      await handler({
        requestId: crypto.randomUUID(),
        user: null,
        params: {},
        query: {},
        headers: {},
        body: {},
      }, response);
      assert.equal(response.statusCode, 404);
    }
  } finally {
    restoreMetrics();
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
  assert.deepEqual(
    [...new Set(calls.counters.map((call) => call.labels.operation))].sort(),
    operations.map(([operation]) => operation).sort(),
  );
  assert.equal(calls.counters.length, operations.length);
  assert.equal(calls.histograms.length, operations.length);
  assert.equal(calls.counters.every((call) => call.name === "misa_import_repair_requests_total"), true);
  assert.equal(calls.histograms.every((call) => call.name === "misa_import_repair_duration_ms"), true);
  for (const call of [...calls.counters, ...calls.histograms]) {
    assert.deepEqual(Object.keys(call.labels).sort(), ["operation", "outcome", "reason", "status"]);
    assert.equal(call.labels.outcome, "rejected");
    assert.equal(call.labels.status, "client_error");
    assert.equal(call.labels.reason, "disabled");
    assert.equal(Object.values(call.labels).some((value) => value === "INV-000042"), false);
  }
});

test("default repair metric registry records counter and histogram series", () => {
  const counterKey = "misa_import_repair_requests_total|schema|completed|none|success";
  const histogramKey = "misa_import_repair_duration_ms|schema|completed|none|success";
  const before = getMisaImportRepairMetricSnapshot();
  emitMisaImportRepairMetric({
    operation: "schema",
    outcome: "completed",
    reason: "none",
    status: "success",
    durationMs: 17,
  });
  const after = getMisaImportRepairMetricSnapshot();
  assert.equal(after.counters[counterKey], Number(before.counters[counterKey] || 0) + 1);
  assert.equal(
    after.histograms[histogramKey].count,
    Number(before.histograms[histogramKey]?.count || 0) + 1,
  );
  assert.equal(
    after.histograms[histogramKey].sum,
    Number(before.histograms[histogramKey]?.sum || 0) + 17,
  );
  const exported = renderMisaImportRepairPrometheusMetrics();
  assert.match(exported, /# TYPE misa_import_repair_requests_total counter/);
  assert.match(exported, /# TYPE misa_import_repair_duration_ms histogram/);
  assert.match(exported, /misa_import_repair_duration_ms_count\{[^}]*operation="schema"/);
  assert.equal(exported.includes("INV-000042"), false);
});

test("admin metrics route exports the production scrape series", async () => {
  const router = require("../routes/admin");
  const layer = router.stack.find((item) => item.route?.path === "/metrics");
  assert.ok(layer, "admin metrics route missing");
  const response = responseRecorder();
  await layer.route.stack.at(-1).handle({}, response);
  assert.match(response.contentType, /text\/plain/);
  assert.match(response.body, /misa_import_repair_requests_total/);
});

test("repair audit wrapper owns a separate UUID while conversion keeps opaque request IDs", async () => {
  const repairService = require("../services/misaImportRepairService");
  const originalCreate = repairService.createSession;
  const originalInfo = console.info;
  const lines = [];
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  process.env.MISA_IMPORT_REPAIR_ENABLED = "true";
  console.info = (line) => lines.push(String(line));
  repairService.createSession = async () => ({
    idempotent: false,
    inspection: null,
    session: {
      _id: new mongoose.Types.ObjectId(),
      status: "needs_schema_mapping",
      version: 1,
      artifactType: "failed_rows",
    },
  });
  try {
    const controller = require("../controllers/misaImportRepairController");
    const response = responseRecorder();
    await controller.createMisaImportRepair({
      requestId: "req-123",
      file: { buffer: Buffer.from("synthetic") },
      params: {},
      headers: {},
      body: { conversionRunId: "INV-000042", artifactType: "failed_rows" },
    }, response);
    const event = JSON.parse(lines.at(-1));
    assert.match(event.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(JSON.stringify(event).includes("req-123"), false);
  } finally {
    repairService.createSession = originalCreate;
    console.info = originalInfo;
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
});

test("upstream repair failure emits failed metric without request payload labels", async () => {
  const calls = [];
  const logLines = [];
  const restoreMetrics = setMisaImportRepairMetrics(createMisaImportRepairMetrics({
    sink: {
      counter(name, value, labels) { calls.push({ name, value, labels }); },
      histogram() {},
    },
  }));
  const repairService = require("../services/misaImportRepairService");
  const originalCreate = repairService.createSession;
  const originalInfo = console.info;
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  process.env.MISA_IMPORT_REPAIR_ENABLED = "true";
  repairService.createSession = async () => {
    throw Object.assign(new Error("technical upstream detail"), { statusCode: 502 });
  };
  console.info = (line) => logLines.push(String(line));
  try {
    const controller = require("../controllers/misaImportRepairController");
    const response = responseRecorder();
    await controller.createMisaImportRepair({
      requestId: crypto.randomUUID(),
      params: {},
      headers: {},
      body: { conversionRunId: "INV-000042", artifactType: "failed_rows" },
    }, response);
    assert.equal(response.statusCode, 502);
  } finally {
    repairService.createSession = originalCreate;
    console.info = originalInfo;
    restoreMetrics();
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].labels, {
    operation: "create",
    outcome: "failed",
    reason: "upstream",
    status: "server_error",
  });
  assert.equal(logLines.join("\n").includes("INV-000042"), false);
  assert.equal(logLines.join("\n").includes("technical upstream detail"), false);
});

test("disabled repair audit never logs hostile allowlisted values or request payloads", async () => {
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  const originalInfo = console.info;
  const lines = [];
  process.env.MISA_IMPORT_REPAIR_ENABLED = "false";
  console.info = (line) => lines.push(String(line));
  try {
    const controller = require("../controllers/misaImportRepairController");
    const response = responseRecorder();
    await controller.createMisaImportRepair({
      requestId: "INV-000042",
      params: {},
      headers: { authorization: "Bearer do-not-log-token" },
      body: {
        conversionRunId: "INV-000042",
        artifactType: "failed_rows",
        technicalMessage: "technical-do-not-log",
        rawRows: [{ taxId: "0312345678", invoiceNumber: "INV-42", amount: "999.99" }],
      },
    }, response);

    assert.equal(response.statusCode, 404);
    assert.equal(lines.length, 1);
    const serialized = lines.join("\n");
    for (const value of ["INV-000042", "do-not-log-token", "technical-do-not-log", "0312345678", "INV-42", "999.99"]) {
      assert.equal(serialized.includes(value), false, value);
    }
  } finally {
    console.info = originalInfo;
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
});

test("successful repair audit drops hostile correlation and conversion identifiers", async () => {
  const repairService = require("../services/misaImportRepairService");
  const originalCreate = repairService.createSession;
  const originalInfo = console.info;
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  const lines = [];
  process.env.MISA_IMPORT_REPAIR_ENABLED = "true";
  console.info = (line) => lines.push(String(line));
  repairService.createSession = async () => ({
    idempotent: false,
    inspection: null,
    session: {
      _id: new mongoose.Types.ObjectId(),
      status: "needs_schema_mapping",
      version: 1,
      artifactType: "failed_rows",
    },
  });
  try {
    const controller = require("../controllers/misaImportRepairController");
    const response = responseRecorder();
    await controller.createMisaImportRepair({
      requestId: "INV-000042",
      file: { buffer: Buffer.from("synthetic") },
      params: {},
      headers: {},
      body: { conversionRunId: "INV-000042", artifactType: "failed_rows" },
    }, response);
    assert.equal(response.statusCode, 201);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("INV-000042"), false);
    assert.equal(JSON.parse(lines[0]).event, "misa_import_repair.create.completed");
  } finally {
    repairService.createSession = originalCreate;
    console.info = originalInfo;
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
});

test("schema and read responses emit bounded summary fields for ambiguous-rate monitoring", () => {
  const { extractMisaImportRepairAuditMetrics } = require("../controllers/misaImportRepairController");
  assert.deepEqual(extractMisaImportRepairAuditMetrics({
    summary: {
      totalIssues: 7,
      unmatchedIssues: 2,
      ambiguousIssues: 3,
      confirmedIssues: 2,
      technicalMessage: "must not pass through",
    },
  }), {
    issueCount: 7,
    matchStatusCounts: { unmatched: 2, ambiguous: 3, confirmed: 2 },
  });
  assert.deepEqual(extractMisaImportRepairAuditMetrics({
    session: { summary: { totalIssues: 4, ambiguousIssues: 1 } },
  }), {
    issueCount: 4,
    matchStatusCounts: { unmatched: 0, ambiguous: 1, confirmed: 0 },
  });
});

test("wrapped schema and read gateway responses log their summaries", async () => {
  const repairService = require("../services/misaImportRepairService");
  const controller = require("../controllers/misaImportRepairController");
  const originalRead = repairService.readWorkspace;
  const originalSchema = repairService.submitSchema;
  const originalInfo = console.info;
  const previous = process.env.MISA_IMPORT_REPAIR_ENABLED;
  const lines = [];
  process.env.MISA_IMPORT_REPAIR_ENABLED = "true";
  console.info = (line) => lines.push(JSON.parse(String(line)));
  const session = {
    _id: new mongoose.Types.ObjectId(),
    conversionRun: new mongoose.Types.ObjectId(),
    status: "needs_schema_mapping",
    version: 2,
    summary: { totalIssues: 5, unmatchedIssues: 1, ambiguousIssues: 2, confirmedIssues: 2 },
  };
  repairService.readWorkspace = async () => ({ session, issues: [], nextCursor: null, retryGate: {} });
  repairService.submitSchema = async () => ({ session, issues: [] });
  try {
    await controller.readMisaImportRepair({
      requestId: "req-123",
      user: { _id: new mongoose.Types.ObjectId() },
      params: { repairId: session._id.toString() },
      query: {},
      body: {},
      headers: {},
    }, responseRecorder());
    await controller.submitMisaImportRepairSchema({
      requestId: "req-123",
      user: { _id: new mongoose.Types.ObjectId() },
      params: { repairId: session._id.toString() },
      query: {},
      body: {},
      headers: {},
    }, responseRecorder());
  } finally {
    repairService.readWorkspace = originalRead;
    repairService.submitSchema = originalSchema;
    console.info = originalInfo;
    if (previous === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous;
  }
  assert.equal(lines.length, 2);
  for (const event of lines) {
    assert.deepEqual(event.matchStatusCounts, { unmatched: 1, ambiguous: 2, confirmed: 2 });
    assert.equal(event.issueCount, 5);
  }
});

function mockModule(modulePath, exports) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  };
}

test("server preserves opaque request IDs for existing conversion correlation", async () => {
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
      headers: { "x-request-id": "req-123" },
    });
    const requestId = response.headers.get("x-request-id");
    assert.equal(requestId, "req-123");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("concurrent server lifecycles own independent repair sweepers", async () => {
  const serverPath = require.resolve("../server");
  const restorers = [];
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    CONVERSION_CONTEXT_SECRET: process.env.CONVERSION_CONTEXT_SECRET,
    CONVERTER_GATEWAY_USAGE_READY: process.env.CONVERTER_GATEWAY_USAGE_READY,
    CONVERTER_PUBLIC_PROXY_ENABLED: process.env.CONVERTER_PUBLIC_PROXY_ENABLED,
  };
  let startCalls = 0;
  let stopCalls = 0;
  const sweepers = new Map();

  try {
    process.env.NODE_ENV = "test";
    process.env.CONVERSION_CONTEXT_SECRET = "x".repeat(32);
    process.env.CONVERTER_GATEWAY_USAGE_READY = "false";
    process.env.CONVERTER_PUBLIC_PROXY_ENABLED = "false";
    restorers.push(
      mockModule(require.resolve("../config/db"), async () => undefined),
      mockModule(require.resolve("../services/conversionArtifactService"), {
        assertArtifactStorageConfigured() {},
        ensureConversionArtifactIndexes: async () => ({ droppedIndexes: [] }),
        startConversionArtifactSweeper: () => ({ stop() {} }),
      }),
      mockModule(require.resolve("../services/misaImportRepairMigrationService"), {
        ensureMisaImportRepairIndexes: async () => ({ droppedIndexes: [], unsetNullKeys: 0 }),
      }),
      mockModule(require.resolve("../services/misaImportRepairSweeper"), {
        startMisaImportRepairSweeper({ owner } = {}) {
          if (sweepers.has(owner)) return sweepers.get(owner);
          startCalls += 1;
          const sweeper = {
            stopped: false,
            stop() {
              if (this.stopped) return;
              this.stopped = true;
              stopCalls += 1;
            },
          };
          sweepers.set(owner, sweeper);
          return sweeper;
        },
      }),
      mockModule(require.resolve("../services/mappingProfileMigrationService"), {
        migrateMappingProfileOwnerScope: async () => ({ skipped: true }),
      }),
      mockModule(require.resolve("../services/mappingProfileV2MigrationService"), {
        ensureMappingProfileV2Indexes: async () => undefined,
        migrateMappingProfilesV1ToV2: async () => ({ skipped: true }),
      }),
    );

    delete require.cache[serverPath];
    const { createStartServer } = require("../server");
    const startServer = createStartServer({
      migrateQuestionEvents: async () => ({ purged: 0 }),
      listen: () => {
      const server = {
        closeHandler: null,
        once(event, callback) {
          if (event === "close") this.closeHandler = callback;
        },
      };
      return server;
      },
    });
    const firstServer = await startServer();
    const secondServer = await startServer();
    assert.equal(startCalls, 2);
    assert.equal(stopCalls, 0);
    firstServer.closeHandler();
    assert.equal(stopCalls, 1);
    assert.equal(sweepers.get(secondServer).stopped, false);
    secondServer.closeHandler();
    assert.equal(stopCalls, 2);
  } finally {
    delete require.cache[serverPath];
    for (const restore of restorers.reverse()) restore();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
