const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const test = require("node:test");
const mongoose = require("mongoose");

const AccountingWorkspace = require("../models/AccountingWorkspace");
const MisaImportRepairSession = require("../models/MisaImportRepairSession");
const User = require("../models/User");

const RUN_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f1f77bcf86cd799439012";
const ISSUE_ID = "507f1f77bcf86cd799439013";
const BATCH_ID = "507f1f77bcf86cd799439014";

function validAnalyzePayload(overrides = {}) {
  return {
    adapter: { id: "manual_excel_v1", verified: false },
    status: "needs_schema_mapping",
    artifact_type: "unknown",
    sheet_name: "Sheet1",
    header_row: 1,
    headers: ["Message"],
    sample_rows: [],
    warnings: [],
    candidates: [],
    selection_ambiguous: false,
    ...overrides,
  };
}

function repairManifest() {
  return {
    schema_version: 1,
    conversion_id: RUN_ID,
    export_batch_id: `export-${RUN_ID}`,
    misa_product: "SME",
    target_template_id: "bsn_sales",
    template_hash: "a".repeat(64),
    raw_file_hash: "b".repeat(64),
    mapping_profile_id: "profile-1",
    mapping_profile_version: 1,
    rows: [{
      export_row_id: "row-1",
      output_row_number: 1,
      document_group_id: "group-1",
      raw_row_ids: ["raw-1"],
      locator: { document_number: "BH0001" },
      line_fingerprint: "c".repeat(64),
    }],
    document_groups: [{
      document_group_id: "group-1",
      output_row_numbers: [1],
      raw_row_ids: ["raw-1"],
      line_count: 1,
    }],
  };
}

function fakeCreateDependencies({
  forwardMultipart = async () => ({ status: 200, data: validAnalyzePayload() }),
  runOverrides = {},
  sessionSave,
} = {}) {
  const saved = [];
  const putCalls = [];
  class FakeSession {
    static async findOne(query) {
      if (query.idempotencyKey) {
        return saved.find((item) =>
          item.user === query.user &&
          item.ownerScope === query.ownerScope &&
          item.idempotencyKey === query.idempotencyKey,
        ) || null;
      }
      return null;
    }
    constructor(value) { Object.assign(this, value, { _id: SESSION_ID }); }
    async save() {
      if (sessionSave) return sessionSave.call(this, { saved });
      saved.push(this);
      return this;
    }
  }
  const manifest = repairManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const artifacts = {
    async getArtifact({ kind }) {
      if (kind === "manifest") return {
        metadata: { storageKey: "manifest-key", sha256: require("crypto").createHash("sha256").update(manifestBytes).digest("hex") },
        content: manifestBytes,
      };
      if (kind === "import_result") {
        return { metadata: { storageKey: "import-key", sha256: "e".repeat(64), contentType: "application/vnd.ms-excel" }, content: Buffer.from("secret-workbook") };
      }
      return { metadata: { storageKey: "output-key", sha256: "d".repeat(64) }, content: Buffer.from("output") };
    },
    async putArtifact(input) {
      putCalls.push(input);
      return { storageKey: "import-key", sha256: "e".repeat(64) };
    },
    async deleteArtifact() {},
  };
  return {
    saved,
    putCalls,
    deps: {
      Run: { findOne: async () => ({
        _id: RUN_ID,
        user: "user-1",
        status: "completed",
        exportArtifactKey: "output-key",
        outputSha256: "d".repeat(64),
        manifestSchemaVersion: 1,
        manifestArtifactKey: "manifest-key",
        manifestSha256: artifacts.getArtifact ? require("crypto").createHash("sha256").update(manifestBytes).digest("hex") : "",
        operationSessionId: "operation-1",
        converterUploadId: "upload-1",
        targetTemplateId: "bsn_sales",
        conversionContextId: "context-1",
        ...runOverrides,
      }) },
      Workspace: { findOne: async () => null },
      RepairSession: FakeSession,
      Issue: {},
      artifacts,
      forwardMultipart,
      createToken: () => "signed-context",
    },
  };
}

function fakeSchemaDependencies({
  artifactMetadata = { storageKey: "import-key", sha256: "e".repeat(64), contentType: "application/vnd.ms-excel" },
  casSucceeds = true,
  normalizeData = {
    issues: [{
      issue_key: "issue-1",
      artifact_row_number: 2,
      technical_message: "Rejected",
      locator: { document_number: "BH0001" },
      category: "master_data",
      severity: "warning",
    }],
    requires_user_confirmation: true,
    retry_allowed: false,
  },
  startSession,
} = {}) {
  const create = fakeCreateDependencies();
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    conversionRun: RUN_ID,
    errorArtifactKey: "import-key",
    errorSha256: "e".repeat(64),
    status: "needs_schema_mapping",
    version: 1,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const issueDocuments = [];
  const sessionUpdates = [];
  const issueInsertOptions = [];
  create.deps.RepairSession = {
    findOne: async () => repair,
    findOneAndUpdate: async (query, update, options) => {
      sessionUpdates.push({ query, update, options });
      if (!casSucceeds && update.$set?.pendingMutationId) {
        return { ...repair, ...update.$set };
      }
      if (!casSucceeds && update.$unset?.pendingMutationId && !update.$inc) return repair;
      if (!casSucceeds) return null;
      return {
        ...repair,
        ...(update.$set || {}),
        version: repair.version + Number(update.$inc?.version || 0),
      };
    },
  };
  create.deps.Issue = {
    async insertMany(docs, options) {
      issueInsertOptions.push(options || {});
      issueDocuments.push(...docs.map((doc) => ({ ...doc })));
      return docs;
    },
    async deleteMany(filter) {
      const before = issueDocuments.length;
      for (let index = issueDocuments.length - 1; index >= 0; index -= 1) {
        const doc = issueDocuments[index];
        if (
          String(doc.repairSession) === String(filter.repairSession) &&
          doc.ownerScope === filter.ownerScope &&
          (!filter.mutationId || doc.mutationId === filter.mutationId)
        ) issueDocuments.splice(index, 1);
      }
      return { acknowledged: true, deletedCount: before - issueDocuments.length };
    },
  };
  const originalGetArtifact = create.deps.artifacts.getArtifact;
  create.deps.artifacts.getArtifact = async (input) => {
    if (input.kind === "import_result") {
      return { metadata: artifactMetadata, content: Buffer.from("secret-workbook") };
    }
    return originalGetArtifact(input);
  };
  create.deps.forwardMultipart = async () => ({ status: 200, data: normalizeData });
  if (startSession) create.deps.startSession = startSession;
  return { ...create, repair, issueDocuments, issueInsertOptions, sessionUpdates };
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function fakeRetryHttpDependencies({ finalSessionUpdateError = null } = {}) {
  const manifest = {
    ...repairManifest(),
    mapping_profile_state_hash: "c".repeat(64),
    validation_ruleset_version: "misa-readiness-v1",
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    conversionRun: RUN_ID,
    operationSessionId: "operation-1",
    targetTemplateId: "bsn_sales",
    templateHash: "a".repeat(64),
    rawFileHash: "b".repeat(64),
    manifestArtifactKey: "manifest-key",
    manifestSha256: "f".repeat(64),
    activeSchemaGenerationId: "generation-1",
    status: "ready_for_repair",
    version: 8,
    summary: {
      totalIssues: 1,
      unmatchedIssues: 0,
      ambiguousIssues: 0,
      confirmedIssues: 1,
      unresolvedIssues: 0,
      unknownDocumentGroups: 0,
      failedDocumentGroups: 1,
    },
    documentGroupStatuses: [{
      documentGroupId: "group-1",
      status: "failed",
      userConfirmed: true,
      confirmedBy: "user-1",
      confirmedAt: new Date(),
    }],
    expiresAt: new Date(Date.now() + 60_000),
  };
  const issues = [{
    _id: ISSUE_ID,
    repairSession: SESSION_ID,
    ownerScope: "user:user-1",
    workspace: null,
    schemaGenerationId: "generation-1",
    matchStatus: "confirmed",
    userConfirmedMatch: true,
    confirmedDocumentGroupId: "group-1",
    normalizedLocator: { lineFingerprint: "c".repeat(64) },
    candidates: [{ documentGroupId: "group-1", evidence: JSON.stringify({ output_row_number: 1 }) }],
    resolution: {
      status: "resolved",
      scope: "once",
      patch: { field: "Mã hàng (*)", value: "HH01", transform: "set_value" },
    },
  }];
  const confirmations = [];
  const batches = [];
  const retryArtifacts = new Map();
  const deleteCalls = [];

  class HumanConfirmation {
    constructor(value) { Object.assign(this, value); }
    async save() { confirmations.push(this); return this; }
    static async findOneAndUpdate(query, update) {
      const item = confirmations.find((candidate) =>
        String(candidate.repairSession) === String(query.repairSession) &&
        String(candidate.user) === String(query.user) &&
        String(candidate.workspace || "") === String(query.workspace || "") &&
        candidate.ownerScope === query.ownerScope &&
        candidate.action === query.action &&
        candidate.payloadHash === query.payloadHash &&
        candidate.sessionVersion === query.sessionVersion &&
        candidate.tokenHash === query.tokenHash &&
        (candidate.consumedAt || null) === query.consumedAt &&
        candidate.expiresAt > query.expiresAt.$gt,
      );
      if (!item) return null;
      Object.assign(item, update.$set || {});
      return item;
    }
  }

  class RetryBatch {
    static async findOne(query) {
      return batches.find((item) =>
        (!query._id || String(item._id) === String(query._id)) &&
        (!query.idempotencyKey || item.idempotencyKey === query.idempotencyKey) &&
        (!query.repairSession || String(item.repairSession) === String(query.repairSession)) &&
        (!query.ownerScope || item.ownerScope === query.ownerScope) &&
        (query.workspace === undefined || String(item.workspace || "") === String(query.workspace || "")),
      ) || null;
    }
    static async countDocuments() { return batches.length; }
    static async deleteOne(query) {
      const index = batches.findIndex((item) => String(item._id) === String(query._id));
      if (index >= 0) batches.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    }
    static async findOneAndUpdate(query, update) {
      const batch = await RetryBatch.findOne(query);
      if (!batch) return null;
      Object.assign(batch, update.$set || {});
      return batch;
    }
    constructor(value) { Object.assign(this, value, { _id: BATCH_ID }); }
    async save() {
      if (!batches.includes(this)) batches.push(this);
      return this;
    }
  }

  const artifacts = {
    async getArtifact(input) {
      if (input.kind === "manifest") {
        return { metadata: { storageKey: "manifest-key", sha256: "f".repeat(64) }, content: manifestBytes };
      }
      if (input.kind === "output") {
        return { metadata: { storageKey: "output-key", sha256: "9".repeat(64) }, content: Buffer.from("output") };
      }
      if (input.kind === "retry_output") {
        const stored = retryArtifacts.get(input.revision);
        if (!stored) {
          const error = new Error("missing retry artifact");
          error.statusCode = 404;
          throw error;
        }
        return stored;
      }
      throw new Error(`unexpected artifact kind ${input.kind}`);
    },
    async putArtifact(input) {
      const sha = crypto.createHash("sha256").update(input.content).digest("hex");
      const stored = {
        metadata: { storageKey: `retry-key-${input.revision}`, sha256: sha, contentType: input.contentType },
        content: Buffer.from(input.content),
      };
      retryArtifacts.set(input.revision, stored);
      return stored.metadata;
    },
    async deleteArtifact(input) {
      deleteCalls.push(input);
      retryArtifacts.delete(input.revision);
    },
  };

  return {
    batches,
    deleteCalls,
    repair,
    deps: {
      Run: { findOne: async (query) => String(query.user) === "user-1" ? ({
        _id: RUN_ID,
        user: "user-1",
        workspace: null,
        status: "completed",
        exportArtifactKey: "output-key",
        outputSha256: "9".repeat(64),
        manifestSchemaVersion: 1,
        manifestArtifactKey: "manifest-key",
        manifestSha256: "f".repeat(64),
        manifestRawFileSha256: "b".repeat(64),
        manifestMappingProfileId: "profile-1",
        manifestMappingProfileVersion: 1,
        manifestMappingProfileStateHash: "c".repeat(64),
        operationSessionId: "operation-1",
        converterUploadId: "upload-1",
        targetTemplateId: "bsn_sales",
        conversionContextId: "context-1",
      }) : null },
      Workspace: { findOne: async () => null },
      HumanConfirmation,
      RepairSession: {
        findOne: async (query) => String(query._id) === SESSION_ID && String(query.user) === repair.user ? repair : null,
        findOneAndUpdate: async (filter, update) => {
          if (filter.version !== undefined && filter.version !== repair.version) return null;
          if (filter.pendingMutationId === null && repair.pendingMutationId) return null;
          if (typeof filter.pendingMutationId === "string" && filter.pendingMutationId !== repair.pendingMutationId) return null;
          if (finalSessionUpdateError && update.$set?.status === "retry_exported") throw finalSessionUpdateError;
          Object.assign(repair, update.$set || {});
          for (const key of Object.keys(update.$unset || {})) delete repair[key];
          repair.version += Number(update.$inc?.version || 0);
          return repair;
        },
      },
      Issue: { find: async () => issues },
      RetryBatch,
      artifacts,
      createToken: () => "signed-context",
      forwardJson: async () => ({
        status: 200,
        data: {
          status: "ready",
          summary: { fatal: 0, blocker: 0, warning: 0, info: 0 },
          issues: [],
          examples: [],
          selected_document_group_count: 1,
          selected_row_count: 1,
        },
      }),
      forwardBinary: async () => ({ status: 200, data: Buffer.from("verified-retry-bytes") }),
      startSession: null,
    },
  };
}

test("repair gateway exports authenticated repair routes", () => {
  const router = require("../routes/converterGateway").router;
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

  assert.ok(paths.includes("POST /import-repairs"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/schema"));
  assert.ok(paths.includes("GET /import-repairs/:repairId"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/issues/:issueId/confirm-match"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/document-groups/:groupId/import-status"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/human-confirmations"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/retry-batches"));
  assert.ok(paths.includes("GET /import-repairs/:repairId/retry-batches/:batchId/download"));

  const uploadRoute = router.stack.find((layer) => layer.route?.path === "/import-repairs").route;
  assert.deepEqual(uploadRoute.stack.slice(0, 2).map((item) => item.handle.name), ["requireDb", "protect"]);
  assert.ok(uploadRoute.stack.some((item) => item.handle.name === "boundedExcelUpload"));
});

test("every repair HTTP route rejects anonymous requests before upload or controller work", async () => {
  const express = require("express");
  const { router } = require("../routes/converterGateway");
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  const app = express();
  app.use(express.json());
  app.use("/api/converter", router);
  const runtime = await listen(app);
  const requests = [
    ["POST", "/api/converter/import-repairs"],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/schema`],
    ["GET", `/api/converter/import-repairs/${SESSION_ID}`],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/issues/${ISSUE_ID}/confirm-match`],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/document-groups/group-1/import-status`],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/human-confirmations`],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/issues/${ISSUE_ID}/resolve`],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/bulk-actions/simulate`],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/bulk-actions/apply`],
    ["POST", `/api/converter/import-repairs/${SESSION_ID}/retry-batches`],
    ["GET", `/api/converter/import-repairs/${SESSION_ID}/retry-batches/${ISSUE_ID}/download`],
  ];

  try {
    for (const [method, path] of requests) {
      const response = await fetch(`${runtime.url}${path}`, {
        method,
        headers: method === "GET" ? undefined : { "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  } finally {
    runtime.server.close();
    mongoose.connection.readyState = previousReadyState;
  }
});

test("retry HTTP boundary enforces ownership, versions, idempotency, atomicity, bytes, and endpoint isolation", async () => {
  const express = require("express");
  const repairService = require("../services/misaImportRepairService");
  const { router } = require("../routes/converterGateway");
  const previous = {
    jwtSecret: process.env.JWT_SECRET,
    repairEnabled: process.env.MISA_IMPORT_REPAIR_ENABLED,
    readyState: mongoose.connection.readyState,
    userFindById: User.findById,
    createRetryBatch: repairService.createRetryBatch,
    downloadRetryBatch: repairService.downloadRetryBatch,
    issueHumanConfirmation: repairService.issueHumanConfirmation,
  };
  const good = fakeRetryHttpDependencies();
  const service = repairService.createMisaImportRepairService(good.deps);
  process.env.JWT_SECRET = "repair-retry-http-secret";
  process.env.MISA_IMPORT_REPAIR_ENABLED = "true";
  mongoose.connection.readyState = 1;
  User.findById = (id) => ({ populate: async () => ({
    _id: String(id),
    isActive: true,
    plan: { code: "monthly" },
    dailyFileCreditDate: new Date().toISOString().slice(0, 10),
    isModified: () => false,
  }) });
  repairService.issueHumanConfirmation = service.issueHumanConfirmation;
  repairService.createRetryBatch = service.createRetryBatch;
  repairService.downloadRetryBatch = service.downloadRetryBatch;
  const app = express();
  app.use(express.json());
  app.use("/api/converter", router);
  const runtime = await listen(app);

  try {
    const authorization = `Bearer ${jwt.sign({ id: "user-1" }, process.env.JWT_SECRET)}`;
    const foreignAuthorization = `Bearer ${jwt.sign({ id: "user-2" }, process.env.JWT_SECRET)}`;
    const preflight = await service.readWorkspace({
      userId: "user-1",
      repairId: SESSION_ID,
      limit: 50,
      groupLimit: 100,
      requestId: "retry-http-preflight",
    });
    const retryBody = {
      expected_version: 8,
      document_group_ids: ["group-1"],
      acknowledge_warnings: false,
      readiness_hash: preflight.readiness.hash,
    };
    const confirmationUrl = `${runtime.url}/api/converter/import-repairs/${SESSION_ID}/human-confirmations`;
    const foreign = await fetch(confirmationUrl, {
      method: "POST",
      headers: { authorization: foreignAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry_export", payload: retryBody }),
    });
    assert.equal(foreign.status, 404);

    const staleConfirmation = await fetch(confirmationUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry_export", payload: { ...retryBody, expected_version: 7 } }),
    });
    assert.equal(staleConfirmation.status, 409);

    const confirmation = await fetch(confirmationUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry_export", payload: retryBody }),
    });
    assert.equal(confirmation.status, 201);
    const confirmationToken = (await confirmation.json()).confirmationToken;

    const retryUrl = `${runtime.url}/api/converter/import-repairs/${SESSION_ID}/retry-batches`;
    const stale = await fetch(retryUrl, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "retry-http",
        "x-human-confirmation-token": confirmationToken,
      },
      body: JSON.stringify({ ...retryBody, expected_version: 7 }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).message, "Repair session đã được cập nhật ở tab khác");

    const create = await fetch(retryUrl, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "retry-http",
        "x-human-confirmation-token": confirmationToken,
      },
      body: JSON.stringify(retryBody),
    });
    assert.equal(create.status, 201);
    const createdBatch = await create.json();

    const replay = await fetch(retryUrl, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "retry-http",
        "x-human-confirmation-token": confirmationToken,
      },
      body: JSON.stringify({
        expectedVersion: 8,
        documentGroupIds: ["group-1"],
        acknowledgeWarnings: false,
        readinessHash: retryBody.readiness_hash,
      }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).batchId, createdBatch.batchId);

    const mismatch = await fetch(retryUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", "idempotency-key": "retry-http" },
      body: JSON.stringify({ ...retryBody, acknowledge_warnings: true }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).message, "Idempotency key đã được dùng cho payload khác");

    const download = await fetch(`${retryUrl}/${createdBatch.batchId}/download`, {
      headers: { authorization },
    });
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).toString(), "verified-retry-bytes");
    assert.equal(download.headers.get("content-type"), "application/vnd.ms-excel");

    const internal = await fetch(`${runtime.url}/api/converter/api/v1/import-repairs/export`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(internal.status, 404);

    const failing = fakeRetryHttpDependencies({ finalSessionUpdateError: new Error("injected session CAS failure") });
    const failingService = repairService.createMisaImportRepairService(failing.deps);
    repairService.issueHumanConfirmation = failingService.issueHumanConfirmation;
    repairService.createRetryBatch = failingService.createRetryBatch;
    const failureConfirmation = await fetch(confirmationUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry_export", payload: retryBody }),
    });
    const failureToken = (await failureConfirmation.json()).confirmationToken;
    const failed = await fetch(retryUrl, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "retry-http-failure",
        "x-human-confirmation-token": failureToken,
      },
      body: JSON.stringify(retryBody),
    });
    assert.equal(failed.status, 500);
    assert.equal(failing.batches.length, 0);
    assert.equal(failing.deleteCalls.length, 1);
    assert.equal(failing.repair.pendingMutationId, undefined);
  } finally {
    runtime.server.close();
    if (previous.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous.jwtSecret;
    if (previous.repairEnabled === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous.repairEnabled;
    mongoose.connection.readyState = previous.readyState;
    User.findById = previous.userFindById;
    repairService.createRetryBatch = previous.createRetryBatch;
    repairService.downloadRetryBatch = previous.downloadRetryBatch;
    repairService.issueHumanConfirmation = previous.issueHumanConfirmation;
  }
});

test("repair service rejects another tenant and expired sessions", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const notFound = createMisaImportRepairService({
    RepairSession: { findOne: async () => null },
  });
  await assert.rejects(
    notFound.loadRepair("507f1f77bcf86cd799439013", "other-user"),
    (error) => error.statusCode === 404,
  );
  const expired = createMisaImportRepairService({
    RepairSession: {
      findOne: async () => ({ expiresAt: new Date(Date.now() - 1000) }),
    },
  });
  await assert.rejects(
    expired.loadRepair("507f1f77bcf86cd799439013", "other-user"),
    (error) => error.statusCode === 410,
  );
});

test("repair service rechecks active workspace membership before every read", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const workspaceId = "507f1f77bcf86cd799439014";
  const workspaceQueries = [];
  const service = createMisaImportRepairService({
    RepairSession: { findOne: async () => ({
      _id: SESSION_ID,
      user: "user-1",
      workspace: workspaceId,
      ownerScope: `workspace:${workspaceId}`,
      expiresAt: new Date(Date.now() + 60_000),
    }) },
    Workspace: {
      findOne: async (query) => {
        workspaceQueries.push(query);
        return null;
      },
    },
  });

  await assert.rejects(
    service.loadRepair(SESSION_ID, "user-1"),
    (error) => error.statusCode === 404,
  );
  assert.deepEqual(workspaceQueries, [{ _id: workspaceId, isActive: true }]);
});

test("revoked workspace membership returns opaque 404 over authenticated HTTP", async () => {
  const express = require("express");
  const { router } = require("../routes/converterGateway");
  const previous = {
    jwtSecret: process.env.JWT_SECRET,
    repairEnabled: process.env.MISA_IMPORT_REPAIR_ENABLED,
    readyState: mongoose.connection.readyState,
    userFindById: User.findById,
    repairFindOne: MisaImportRepairSession.findOne,
    workspaceFindOne: AccountingWorkspace.findOne,
  };
  process.env.JWT_SECRET = "repair-http-auth-secret";
  process.env.MISA_IMPORT_REPAIR_ENABLED = "true";
  mongoose.connection.readyState = 1;
  User.findById = () => ({ populate: async () => ({
    _id: "user-1",
    isActive: true,
    plan: { code: "monthly" },
    dailyFileCreditDate: new Date().toISOString().slice(0, 10),
    isModified: () => false,
  }) });
  MisaImportRepairSession.findOne = async () => ({
    _id: SESSION_ID,
    user: "user-1",
    workspace: "507f1f77bcf86cd799439014",
    ownerScope: "workspace:507f1f77bcf86cd799439014",
    expiresAt: new Date(Date.now() + 60_000),
  });
  AccountingWorkspace.findOne = async () => null;
  const app = express();
  app.use(express.json());
  app.use("/api/converter", router);
  const runtime = await listen(app);

  try {
    const token = jwt.sign({ id: "user-1" }, process.env.JWT_SECRET);
    const response = await fetch(`${runtime.url}/api/converter/import-repairs/${SESSION_ID}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).message, "Repair session không tồn tại");
  } finally {
    runtime.server.close();
    if (previous.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous.jwtSecret;
    if (previous.repairEnabled === undefined) delete process.env.MISA_IMPORT_REPAIR_ENABLED;
    else process.env.MISA_IMPORT_REPAIR_ENABLED = previous.repairEnabled;
    mongoose.connection.readyState = previous.readyState;
    User.findById = previous.userFindById;
    MisaImportRepairSession.findOne = previous.repairFindOne;
    AccountingWorkspace.findOne = previous.workspaceFindOne;
  }
});

test("authenticated repair upload rejects malformed and oversized workbooks at HTTP boundary", async () => {
  const express = require("express");
  const { router } = require("../routes/converterGateway");
  const previous = {
    jwtSecret: process.env.JWT_SECRET,
    maxBytes: process.env.CONVERTER_MAX_FILE_BYTES,
    readyState: mongoose.connection.readyState,
    userFindById: User.findById,
  };
  process.env.JWT_SECRET = "repair-upload-auth-secret";
  process.env.CONVERTER_MAX_FILE_BYTES = "4";
  mongoose.connection.readyState = 1;
  User.findById = () => ({ populate: async () => ({
    _id: "user-1",
    isActive: true,
    plan: { code: "monthly" },
    dailyFileCreditDate: new Date().toISOString().slice(0, 10),
    isModified: () => false,
  }) });
  const app = express();
  app.use("/api/converter", router);
  const runtime = await listen(app);

  try {
    const authorization = `Bearer ${jwt.sign({ id: "user-1" }, process.env.JWT_SECRET)}`;
    const malformed = new FormData();
    malformed.append("file", new Blob([Buffer.from("bad")]), "errors.txt");
    const malformedResponse = await fetch(`${runtime.url}/api/converter/import-repairs`, {
      method: "POST",
      headers: { authorization },
      body: malformed,
    });
    assert.equal(malformedResponse.status, 400);

    const oversized = new FormData();
    oversized.append("file", new Blob([Buffer.from("12345")]), "errors.xlsx");
    const oversizedResponse = await fetch(`${runtime.url}/api/converter/import-repairs`, {
      method: "POST",
      headers: { authorization },
      body: oversized,
    });
    assert.equal(oversizedResponse.status, 413);
  } finally {
    runtime.server.close();
    if (previous.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous.jwtSecret;
    if (previous.maxBytes === undefined) delete process.env.CONVERTER_MAX_FILE_BYTES;
    else process.env.CONVERTER_MAX_FILE_BYTES = previous.maxBytes;
    mongoose.connection.readyState = previous.readyState;
    User.findById = previous.userFindById;
  }
});

test("repair create is idempotent and never persists workbook bytes in Mongo", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeCreateDependencies();
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    runId: RUN_ID,
    file: { originalname: "errors.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("secret-workbook") },
    artifactType: "unrecognized",
    idempotencyKey: "create-1",
    requestId: "request-1",
  };
  const first = await service.createSession(input);
  const second = await service.createSession(input);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(fake.putCalls.length, 1);
  assert.equal(fake.saved[0].errorArtifactKey, "import-key");
  assert.equal(
    fake.saved[0].uploadSha256,
    crypto.createHash("sha256").update(input.file.buffer).digest("hex"),
  );
  assert.match(fake.saved[0].requestFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(fake.saved[0], "buffer"), false);
});

test("repair create allows two no-key sessions without persisting a null idempotency key", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeCreateDependencies();
  const service = createMisaImportRepairService(fake.deps);

  for (const workbook of ["workbook-one", "workbook-two"]) {
    await service.createSession({
      userId: "user-1",
      runId: RUN_ID,
      file: { originalname: "errors.xlsx", buffer: Buffer.from(workbook) },
      artifactType: "unrecognized",
      requestId: `request-${workbook}`,
    });
  }

  assert.equal(fake.saved.length, 2);
  assert.equal(fake.saved.every((session) => !Object.hasOwn(session, "idempotencyKey")), true);
});

test("repair create rejects idempotency key reuse with a different request fingerprint", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeCreateDependencies();
  const service = createMisaImportRepairService(fake.deps);
  const base = {
    userId: "user-1",
    runId: RUN_ID,
    file: { originalname: "errors.xlsx", buffer: Buffer.from("workbook-one") },
    artifactType: "unrecognized",
    idempotencyKey: "same-key",
    requestId: "request-1",
  };
  await service.createSession(base);

  await assert.rejects(
    service.createSession({ ...base, file: { ...base.file, buffer: Buffer.from("workbook-two") } }),
    (error) => error.statusCode === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  assert.equal(fake.putCalls.length, 1);
});

test("repair create resolves duplicate-key races by rereading and comparing fingerprint", async () => {
  const existing = [];
  const fake = fakeCreateDependencies({
    sessionSave: async function saveWithDuplicateRace() {
      if (!existing.length) {
        existing.push({ ...this });
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      throw new Error("unexpected save");
    },
  });
  fake.deps.RepairSession.findOne = async (query) => {
    if (!query.idempotencyKey) return null;
    return existing.find((item) =>
      item.user === query.user &&
      item.ownerScope === query.ownerScope &&
      item.idempotencyKey === query.idempotencyKey,
    ) || null;
  };
  let deleted = 0;
  fake.deps.artifacts.deleteArtifact = async () => { deleted += 1; };
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const result = await createMisaImportRepairService(fake.deps).createSession({
    userId: "user-1",
    runId: RUN_ID,
    file: { originalname: "errors.xlsx", buffer: Buffer.from("same-workbook") },
    artifactType: "unrecognized",
    idempotencyKey: "race-key",
    requestId: "request-1",
  });

  assert.equal(result.idempotent, true);
  assert.equal(String(result.session._id), SESSION_ID);
  assert.equal(deleted, 1);
});

test("repair create maps converter timeout to 503 and deletes stored artifact", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  let deleted = 0;
  const fake = fakeCreateDependencies({
    forwardMultipart: async () => { throw Object.assign(new Error("timeout"), { statusCode: 504 }); },
  });
  fake.deps.artifacts.deleteArtifact = async () => { deleted += 1; };
  const service = createMisaImportRepairService(fake.deps);
  await assert.rejects(
    service.createSession({
      userId: "user-1", runId: RUN_ID,
      file: { originalname: "errors.xlsx", buffer: Buffer.from("secret") },
      artifactType: "unrecognized", idempotencyKey: "timeout-1", requestId: "request-1",
    }),
    (error) => error.statusCode === 503,
  );
  assert.equal(deleted, 1);
});

test("repair create distinguishes missing and expired bound manifests", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  for (const [artifactStatus, expectedStatus, expectedCode] of [
    [404, 409, "MANIFEST_MISSING"],
    [410, 410, "MANIFEST_EXPIRED"],
  ]) {
    const fake = fakeCreateDependencies();
    fake.deps.artifacts.getArtifact = async ({ kind }) => {
      assert.equal(kind, "manifest");
      throw Object.assign(new Error("artifact unavailable"), { statusCode: artifactStatus });
    };
    await assert.rejects(
      createMisaImportRepairService(fake.deps).createSession({
        userId: "user-1",
        runId: RUN_ID,
        file: { originalname: "errors.xlsx", buffer: Buffer.from("workbook") },
        artifactType: "failed_rows",
        idempotencyKey: `manifest-${artifactStatus}`,
        requestId: "request-1",
      }),
      (error) => error.statusCode === expectedStatus && error.code === expectedCode,
    );
  }
});

test("repair create rejects malformed successful analyze payload and removes artifact", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeCreateDependencies({
    forwardMultipart: async () => ({ status: 200, data: { headers: [] } }),
  });
  let deleted = 0;
  fake.deps.artifacts.deleteArtifact = async () => { deleted += 1; };

  await assert.rejects(
    createMisaImportRepairService(fake.deps).createSession({
      userId: "user-1",
      runId: RUN_ID,
      file: { originalname: "errors.xlsx", buffer: Buffer.from("workbook") },
      artifactType: "failed_rows",
      idempotencyKey: "malformed-analyze",
      requestId: "request-1",
    }),
    (error) => error.statusCode === 502 && error.code === "INVALID_CONVERTER_RESPONSE",
  );
  assert.equal(fake.saved.length, 0);
  assert.equal(deleted, 1);
});

test("schema submit rejects exact import artifact key or checksum mismatch", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  for (const metadata of [
    { storageKey: "other-key", sha256: "e".repeat(64), contentType: "application/vnd.ms-excel" },
    { storageKey: "import-key", sha256: "f".repeat(64), contentType: "application/vnd.ms-excel" },
  ]) {
    const fake = fakeSchemaDependencies({ artifactMetadata: metadata });
    await assert.rejects(
      createMisaImportRepairService(fake.deps).submitSchema({
        userId: "user-1",
        repairId: SESSION_ID,
        body: {
          expected_version: 1,
          sheet_name: "Sheet1",
          header_row: 1,
          columns: { technical_message: "Message" },
        },
        requestId: "request-1",
      }),
      (error) => error.statusCode === 409 && error.code === "IMPORT_ARTIFACT_BINDING_MISMATCH",
    );
    assert.equal(fake.sessionUpdates.length, 0);
    assert.equal(fake.issueDocuments.length, 0);
  }
});

test("schema submit rejects malformed successful normalize payload without persistence", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  for (const normalizeData of [{}, { issues: {} }, { issues: [{ issue_key: "missing-fields" }] }]) {
    const fake = fakeSchemaDependencies({ normalizeData });
    await assert.rejects(
      createMisaImportRepairService(fake.deps).submitSchema({
        userId: "user-1",
        repairId: SESSION_ID,
        body: {
          expected_version: 1,
          sheet_name: "Sheet1",
          header_row: 1,
          columns: { technical_message: "Message" },
        },
        requestId: "request-1",
      }),
      (error) => error.statusCode === 502 && error.code === "INVALID_CONVERTER_RESPONSE",
    );
    assert.equal(fake.sessionUpdates.length, 0);
    assert.equal(fake.issueDocuments.length, 0);
  }
});

test("schema issue writes and session CAS share one Mongo transaction when supported", async () => {
  const mongoSession = {
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  };
  const fake = fakeSchemaDependencies({ startSession: async () => mongoSession });
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  await createMisaImportRepairService(fake.deps).submitSchema({
    userId: "user-1",
    repairId: SESSION_ID,
    body: {
      expected_version: 1,
      sheet_name: "Sheet1",
      header_row: 1,
      columns: { technical_message: "Message" },
    },
    requestId: "request-1",
  });

  assert.ok(fake.issueInsertOptions.every((options) => options.session === mongoSession));
  assert.ok(fake.sessionUpdates.every(({ options }) => options.session === mongoSession));
});

test("standalone schema CAS loss cleans staged issues instead of publishing partial state", async () => {
  const fake = fakeSchemaDependencies({ casSucceeds: false });
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  await assert.rejects(
    createMisaImportRepairService(fake.deps).submitSchema({
      userId: "user-1",
      repairId: SESSION_ID,
      body: {
        expected_version: 1,
        sheet_name: "Sheet1",
        header_row: 1,
        columns: { technical_message: "Message" },
      },
      requestId: "request-1",
    }),
    (error) => error.statusCode === 409 && error.code === "STALE_REPAIR_VERSION",
  );
  assert.equal(fake.issueDocuments.length, 0);
});

test("schema normalization preserves bounded source rows without relabeling business keys", async () => {
  const fake = fakeSchemaDependencies({
    normalizeData: {
      issues: [
        {
          issue_key: "trusted",
          artifact_row_number: 2,
          technical_message: "Rejected",
          locator: { document_number: "BH0001", line_fingerprint: "f".repeat(64), source_row_number: 999 },
          category: "master_data",
          severity: "warning",
        },
        {
          issue_key: "absent",
          artifact_row_number: 3,
          technical_message: "Rejected",
          locator: { document_number: "UNKNOWN", line_fingerprint: "f".repeat(64), source_row_number: 999 },
          category: "master_data",
          severity: "warning",
        },
      ],
      requires_user_confirmation: true,
      retry_allowed: false,
    },
  });
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const result = await createMisaImportRepairService(fake.deps).submitSchema({
    userId: "user-1",
    repairId: SESSION_ID,
    body: {
      expected_version: 1,
      sheet_name: "Sheet1",
      header_row: 1,
      columns: { technical_message: "Message", document_number: "So CT" },
    },
    requestId: "request-1",
  });

  const [trusted, absent] = result.issues;
  assert.equal(trusted.normalizedLocator.lineFingerprint, null);
  assert.equal(trusted.normalizedLocator.sourceRowNumber, 999);
  assert.equal(trusted.candidates[0].method, "exact_business_key");
  assert.equal(absent.normalizedLocator.lineFingerprint, null);
  assert.equal(absent.normalizedLocator.sourceRowNumber, 999);
});

test("repair confirmation rejects stale versions and non-member candidates", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    ownerScope: "user:user-1",
    version: 4,
    expiresAt: new Date(Date.now() + 60_000),
    summary: {},
  };
  const issue = {
    _id: "507f1f77bcf86cd799439013",
    matchStatus: "suggested",
    candidates: [{ documentGroupId: "group-1" }],
  };
  const service = createMisaImportRepairService({
    RepairSession: { findOne: async () => repair },
    Issue: { findOne: async () => issue },
  });
  await assert.rejects(
    service.confirmMatch({ userId: "user-1", repairId: SESSION_ID, issueId: issue._id, body: { expected_version: 3, document_group_id: "group-1" } }),
    (error) => error.statusCode === 409,
  );
  await assert.rejects(
    service.confirmMatch({ userId: "user-1", repairId: SESSION_ID, issueId: issue._id, body: { expected_version: 4, document_group_id: "group-2" } }),
    (error) => error.statusCode === 422,
  );
});

test("repair confirmation rejects malformed issue id before any Mongo query", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  let issueQueries = 0;
  const service = createMisaImportRepairService({
    RepairSession: { findOne: async () => ({
      _id: SESSION_ID,
      user: "user-1",
      ownerScope: "user:user-1",
      workspace: null,
      version: 4,
      expiresAt: new Date(Date.now() + 60_000),
      summary: {},
    }) },
    Issue: { findOne: async () => { issueQueries += 1; throw new Error("CastError"); } },
  });

  await assert.rejects(
    service.confirmMatch({
      userId: "user-1",
      repairId: SESSION_ID,
      issueId: "not-an-object-id",
      body: { expected_version: 4, document_group_id: "group-1" },
    }),
    (error) => error.statusCode === 404 && error.code === "ISSUE_NOT_FOUND",
  );
  assert.equal(issueQueries, 0);
});

test("standalone confirmation rolls issue back when session CAS loses", async () => {
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    version: 4,
    expiresAt: new Date(Date.now() + 60_000),
    summary: { ambiguousIssues: 1, confirmedIssues: 0 },
  };
  const issue = {
    _id: ISSUE_ID,
    matchStatus: "ambiguous",
    candidates: [{ documentGroupId: "group-1" }],
    confirmedDocumentGroupId: "",
    userConfirmedMatch: false,
    confirmedBy: null,
    confirmedAt: null,
  };
  const issueUpdates = [];
  let repairUpdates = 0;
  const service = require("../services/misaImportRepairService").createMisaImportRepairService({
    HumanConfirmation: { findOneAndUpdate: async () => ({ consumedAt: new Date() }) },
    RepairSession: {
      findOne: async () => repair,
      findOneAndUpdate: async (_query, update) => {
        repairUpdates += 1;
        if (repairUpdates === 1) return { ...repair, ...update.$set };
        if (update.$unset?.pendingMutationId && !update.$inc) return repair;
        return null;
      },
    },
    Issue: {
      findOne: async () => issue,
      findOneAndUpdate: async (query, update, options) => {
        issueUpdates.push({ query, update, options });
        if (issueUpdates.length === 1) return { ...issue, ...update.$set };
        return { ...issue, ...update.$set };
      },
    },
  });

  await assert.rejects(
    service.confirmMatch({
      userId: "user-1",
      repairId: SESSION_ID,
      issueId: ISSUE_ID,
      body: { expected_version: 4, document_group_id: "group-1" },
      humanConfirmationToken: "test-confirmation-token",
    }),
    (error) => error.statusCode === 409 && error.code === "STALE_REPAIR_VERSION",
  );
  assert.equal(issueUpdates.length, 2);
  assert.equal(issueUpdates[1].update.$set.matchStatus, "ambiguous");
  assert.equal(issueUpdates[1].update.$set.userConfirmedMatch, false);
});

test("confirmation issue update and session CAS share one Mongo transaction when supported", async () => {
  const mongoSession = {
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  };
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    version: 4,
    expiresAt: new Date(Date.now() + 60_000),
    summary: { confirmedIssues: 0 },
  };
  const issue = {
    _id: ISSUE_ID,
    matchStatus: "suggested",
    candidates: [{ documentGroupId: "group-1" }],
  };
  const calls = [];
  const service = require("../services/misaImportRepairService").createMisaImportRepairService({
    HumanConfirmation: { findOneAndUpdate: async () => ({ consumedAt: new Date() }) },
    startSession: async () => mongoSession,
    RepairSession: {
      findOne: async () => repair,
      findOneAndUpdate: async (_query, _update, options) => {
        calls.push(options);
        return { ...repair, version: 5 };
      },
    },
    Issue: {
      findOne: async () => issue,
      findOneAndUpdate: async (_query, update, options) => {
        calls.push(options);
        return { ...issue, ...update.$set };
      },
    },
  });
  await service.confirmMatch({
    userId: "user-1",
    repairId: SESSION_ID,
    issueId: ISSUE_ID,
    body: { expected_version: 4, document_group_id: "group-1" },
    humanConfirmationToken: "test-confirmation-token",
  });

  assert.ok(calls.every((options) => options.session === mongoSession));
});

test("repair gateway ignores untrusted fingerprints but preserves bounded source row evidence", () => {
  const { buildIssueMatch } = require("../services/misaImportRepairService");
  const result = buildIssueMatch(
    {
      issue_key: "issue-1",
      artifact_row_number: 2,
      technical_message: "Mã đối tượng không tồn tại",
      locator: {
        source_row_number: 9999,
        line_fingerprint: "f".repeat(64),
        document_number: "BH0001",
      },
    },
    {
      rows: [
        {
          export_row_id: "row-1",
          output_row_number: 3,
          document_group_id: "group-1",
          line_fingerprint: "a".repeat(64),
          locator: { document_number: "BH0001" },
        },
      ],
    },
  );

  assert.equal(result.matchStatus, "suggested");
  assert.equal(result.normalizedLocator.sourceRowNumber, 9999);
  assert.equal(result.normalizedLocator.lineFingerprint, null);
  assert.equal(result.candidates[0].method, "exact_business_key");
});

test("unmatched issue accepts a token-bound manual group from the trusted manifest", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const manifest = repairManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
  const confirmations = [];
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    conversionRun: RUN_ID,
    operationSessionId: "operation-1",
    targetTemplateId: "bsn_sales",
    templateHash: "a".repeat(64),
    rawFileHash: "b".repeat(64),
    manifestArtifactKey: "manifest-key",
    manifestSha256,
    activeSchemaGenerationId: "generation-1",
    version: 4,
    summary: { unmatchedIssues: 1, confirmedIssues: 0 },
    documentGroupStatuses: [{ documentGroupId: "group-1", status: "unknown", userConfirmed: false }],
    expiresAt: new Date(Date.now() + 60_000),
  };
  const issue = {
    _id: ISSUE_ID,
    repairSession: SESSION_ID,
    ownerScope: repair.ownerScope,
    workspace: null,
    schemaGenerationId: repair.activeSchemaGenerationId,
    matchStatus: "unmatched",
    candidates: [],
    resolution: { status: "unresolved" },
  };
  class HumanConfirmation {
    constructor(value) { Object.assign(this, value); }
    async save() { confirmations.push(this); return this; }
    static async findOneAndUpdate(query, update) {
      const found = confirmations.find((item) =>
        item.payloadHash === query.payloadHash &&
        item.tokenHash === query.tokenHash &&
        item.sessionVersion === query.sessionVersion &&
        item.consumedAt == null &&
        item.expiresAt > query.expiresAt.$gt);
      if (!found) return null;
      Object.assign(found, update.$set);
      return found;
    }
  }
  const run = {
    _id: RUN_ID,
    user: "user-1",
    workspace: null,
    status: "completed",
    exportArtifactKey: "output-key",
    outputSha256: "d".repeat(64),
    manifestArtifactKey: "manifest-key",
    manifestSha256,
    manifestSchemaVersion: 1,
    manifestRawFileSha256: "b".repeat(64),
    manifestMappingProfileId: "profile-1",
    manifestMappingProfileVersion: 1,
    operationSessionId: "operation-1",
    converterUploadId: "upload-1",
    targetTemplateId: "bsn_sales",
    conversionContextId: "context-1",
  };
  const service = createMisaImportRepairService({
    Run: { findOne: async () => run },
    Workspace: { findOne: async () => null },
    HumanConfirmation,
    RepairSession: {
      findOne: async () => repair,
      findOneAndUpdate: async (_filter, update) => {
        Object.assign(repair, update.$set || {});
        repair.version += Number(update.$inc?.version || 0);
        return repair;
      },
    },
    Issue: {
      findOne: async () => issue,
      findOneAndUpdate: async (filter, update) => {
        if (filter.matchStatus && filter.matchStatus !== issue.matchStatus && !filter.matchStatus.$in?.includes(issue.matchStatus)) return null;
        Object.assign(issue, update.$set || {});
        return issue;
      },
    },
    artifacts: {
      async getArtifact({ kind }) {
        if (kind === "manifest") return { metadata: { storageKey: "manifest-key", sha256: manifestSha256 }, content: manifestBytes };
        return { metadata: { storageKey: "output-key", sha256: "d".repeat(64) }, content: Buffer.from("output") };
      },
    },
    createToken: () => "signed-context",
    startSession: null,
  });
  const body = { expected_version: 4, document_group_id: "group-1" };
  const issued = await service.issueHumanConfirmation({
    userId: "user-1",
    repairId: SESSION_ID,
    action: "confirm_match",
    body,
    issueId: ISSUE_ID,
  });

  const result = await service.confirmMatch({
    userId: "user-1",
    repairId: SESSION_ID,
    issueId: ISSUE_ID,
    body,
    humanConfirmationToken: issued.token,
  });

  assert.equal(result.issue.matchStatus, "confirmed");
  assert.equal(result.issue.confirmedDocumentGroupId, "group-1");
  assert.equal(repair.summary.unmatchedIssues, 0);
});

test("repair expiry is the minimum of configured, manifest, and output expiry", async () => {
  const fixedNow = new Date("2026-07-29T00:00:00.000Z");
  const manifestExpiry = new Date("2026-07-29T00:40:00.000Z");
  const outputExpiry = new Date("2026-07-29T00:20:00.000Z");
  const fake = fakeCreateDependencies();
  const originalGetArtifact = fake.deps.artifacts.getArtifact;
  fake.deps.now = () => fixedNow;
  fake.deps.artifacts.getArtifact = async (input) => {
    const stored = await originalGetArtifact(input);
    stored.metadata.expiresAt = input.kind === "manifest" ? manifestExpiry : outputExpiry;
    return stored;
  };
  const previousTtl = process.env.CONVERTER_ARTIFACT_TTL_SECONDS;
  process.env.CONVERTER_ARTIFACT_TTL_SECONDS = "3600";
  try {
    const result = await require("../services/misaImportRepairService")
      .createMisaImportRepairService(fake.deps)
      .createSession({
        userId: "user-1",
        runId: RUN_ID,
        file: { buffer: Buffer.from("workbook"), originalname: "error.xls", mimetype: "application/vnd.ms-excel" },
        artifactType: "failed_rows",
        idempotencyKey: "expiry-min",
        requestId: "expiry-min",
      });
    assert.equal(result.session.expiresAt.toISOString(), outputExpiry.toISOString());
    assert.equal(fake.putCalls[0].expiresAt.toISOString(), outputExpiry.toISOString());
  } finally {
    if (previousTtl === undefined) delete process.env.CONVERTER_ARTIFACT_TTL_SECONDS;
    else process.env.CONVERTER_ARTIFACT_TTL_SECONDS = previousTtl;
  }
});

test("repair workspace paginates 51 issues and 101 trusted document groups", async () => {
  const issueRows = Array.from({ length: 51 }, (_, index) => ({
    _id: (index + 1).toString(16).padStart(24, "0"),
    issueKey: `issue-${index + 1}`,
    technicalMessage: "Rejected",
    matchStatus: "unmatched",
    resolution: { status: "unresolved" },
  }));
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    version: 2,
    status: "needs_match_review",
    artifactType: "failed_rows",
    expiresAt: new Date(Date.now() + 60_000),
    summary: { totalIssues: 51, unmatchedIssues: 51, unresolvedIssues: 51, unknownDocumentGroups: 101 },
    documentGroupStatuses: Array.from({ length: 101 }, (_, index) => ({
      documentGroupId: `group-${String(index + 1).padStart(3, "0")}`,
      status: "unknown",
      userConfirmed: false,
      evidence: { documentNumber: `BH${String(index + 1).padStart(4, "0")}`, lineCount: 1 },
    })),
  };
  const Issue = {
    find(filter) {
      let rows = issueRows.filter((item) => !filter._id?.$gt || item._id > String(filter._id.$gt));
      return {
        sort() { rows = [...rows].sort((left, right) => left._id.localeCompare(right._id)); return this; },
        async limit(value) { return rows.slice(0, value); },
      };
    },
  };
  const service = require("../services/misaImportRepairService").createMisaImportRepairService({
    RepairSession: { findOne: async () => repair },
    Issue,
  });

  const first = await service.readWorkspace({
    userId: "user-1", repairId: SESSION_ID, limit: 50, groupLimit: 100,
  });
  const second = await service.readWorkspace({
    userId: "user-1",
    repairId: SESSION_ID,
    cursor: first.nextCursor,
    groupCursor: first.nextGroupCursor,
    limit: 50,
    groupLimit: 100,
  });

  assert.equal(first.issues.length, 50);
  assert.equal(second.issues.length, 1);
  assert.equal(first.documentGroups.length, 100);
  assert.equal(second.documentGroups.length, 1);
  assert.equal(first.documentGroups[0].evidence.documentNumber, "BH0001");
  assert.ok(first.nextCursor);
  assert.ok(first.nextGroupCursor);
});

test("repair gateway caps ambiguous candidates and keeps raw bytes out of output", () => {
  const { buildIssueMatch, sanitizeRepairPayload } = require("../services/misaImportRepairService");
  const manifest = {
    rows: Array.from({ length: 7 }, (_, index) => ({
      export_row_id: `row-${index}`,
      output_row_number: index + 1,
      document_group_id: `group-${index}`,
      line_fingerprint: String(index).padStart(64, "a"),
      locator: { document_number: "DUPLICATE" },
    })),
  };
  const result = buildIssueMatch(
    {
      issue_key: "issue-ambiguous",
      artifact_row_number: 2,
      technical_message: "Lỗi",
      locator: { document_number: "DUPLICATE" },
    },
    manifest,
  );

  assert.equal(result.matchStatus, "ambiguous");
  assert.equal(result.candidates.length, 5);
  const sanitized = sanitizeRepairPayload({
    content: Buffer.from("secret"),
    raw_bytes: "secret",
    rawBytes: "secret",
    rows: [{ workbookBytes: "secret", nested: [{ rawWorkbook: "secret", safe: "ok" }] }],
    ok: true,
  });
  assert.equal(sanitized, null);
});

test("repair read response whitelists issue fields and removes nested workbook bytes", async () => {
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    version: 2,
    status: "needs_match_review",
    artifactType: "failed_rows",
    expiresAt: new Date(Date.now() + 60_000),
    summary: {},
  };
  const issues = [{
    _id: ISSUE_ID,
    issueKey: "issue-1",
    technicalMessage: "Rejected",
    matchStatus: "unmatched",
    rawBytes: "secret",
    workbookBytes: "secret",
    resolution: { status: "unresolved", patch: { rawWorkbook: "secret", safe: "ok" } },
    candidates: [{ documentGroupId: "group-1", evidence: "safe", raw_bytes: "secret" }],
  }];
  const service = require("../services/misaImportRepairService").createMisaImportRepairService({
    RepairSession: { findOne: async () => repair },
    Issue: {
      find() {
        return {
          sort() { return this; },
          async limit() { return issues; },
        };
      },
    },
  });

  const result = await service.readWorkspace({ userId: "user-1", repairId: SESSION_ID });
  const json = JSON.stringify(result);
  assert.equal(json.includes("secret"), false);
  assert.equal(json.includes("rawBytes"), false);
  assert.equal(result.issues[0].technicalMessage, "Rejected");
});

test("repair response DTOs drop nested objects and arrays from candidates, resolution, and session paths", async () => {
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    version: 2,
    status: "needs_match_review",
    artifactType: "failed_rows",
    expiresAt: new Date(Date.now() + 60_000),
    summary: { totalIssues: 1, nested: { rawContent: "secret" } },
    documentGroupStatuses: [{
      documentGroupId: "group-1",
      status: "unknown",
      userConfirmed: false,
      metadata: [{ fileBytes: "secret" }],
    }],
  };
  const issues = [{
    _id: ISSUE_ID,
    issueKey: "issue-1",
    technicalMessage: "Rejected",
    normalizedLocator: { documentNumber: "BH0001" },
    matchStatus: "suggested",
    candidates: [{
      documentGroupId: "group-1",
      method: "exact_business_key",
      evidence: { blob: "secret" },
      nested: [{ base64: "secret" }],
    }],
    resolution: {
      status: "unresolved",
      scope: "once",
      patch: {
        field: "Mã nhà cung cấp",
        value: { rawContent: "secret" },
        nested: [{ fileBytes: "secret" }],
      },
    },
  }];
  const service = require("../services/misaImportRepairService").createMisaImportRepairService({
    RepairSession: { findOne: async () => repair },
    Issue: {
      find() {
        return { sort() { return this; }, async limit() { return issues; } };
      },
    },
  });

  const result = await service.readWorkspace({ userId: "user-1", repairId: SESSION_ID });

  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(result.session.summary, { totalIssues: 1 });
  assert.deepEqual(result.session.documentGroupStatuses, [{
    documentGroupId: "group-1",
    status: "unknown",
    userConfirmed: false,
    confirmedBy: null,
    confirmedAt: null,
  }]);
  assert.deepEqual(result.issues[0].candidates, [{
    documentGroupId: "group-1",
    method: "exact_business_key",
    evidence: "",
  }]);
  assert.equal(result.issues[0].resolution.patch, null);
});

test("repair read and mutate queries retain user workspace and owner scope", async () => {
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    version: 2,
    status: "needs_match_review",
    artifactType: "failed_rows",
    expiresAt: new Date(Date.now() + 60_000),
    summary: {},
    documentGroupStatuses: [{ documentGroupId: "group-1", status: "unknown" }],
  };
  let issueFilter;
  let sessionFilter;
  const service = require("../services/misaImportRepairService").createMisaImportRepairService({
    HumanConfirmation: { findOneAndUpdate: async () => ({ consumedAt: new Date() }) },
    RepairSession: {
      findOne: async () => repair,
      findOneAndUpdate: async (filter) => {
        sessionFilter = filter;
        return { ...repair, version: 3 };
      },
    },
    Issue: {
      find(filter) {
        issueFilter = filter;
        return {
          sort() { return this; },
          async limit() { return []; },
        };
      },
    },
  });

  await service.readWorkspace({ userId: "user-1", repairId: SESSION_ID });
  await service.setImportStatus({
    userId: "user-1",
    repairId: SESSION_ID,
    groupId: "group-1",
    body: { expected_version: 2, status: "imported" },
    humanConfirmationToken: "test-confirmation-token",
  });
  assert.deepEqual(issueFilter, {
    repairSession: SESSION_ID,
    ownerScope: "user:user-1",
    workspace: null,
    schemaGenerationId: null,
  });
  assert.equal(sessionFilter.user, "user-1");
  assert.equal(sessionFilter.ownerScope, "user:user-1");
  assert.equal(sessionFilter.workspace, null);
});

test("stale standalone schema mutation is cleaned before repair data becomes readable", async () => {
  const staleMutationId = "stale-schema-mutation";
  const repair = {
    _id: SESSION_ID,
    user: "user-1",
    workspace: null,
    ownerScope: "user:user-1",
    version: 2,
    status: "needs_schema_mapping",
    expiresAt: new Date(Date.now() + 60_000),
    pendingMutationId: staleMutationId,
    pendingMutationType: "schema",
    pendingMutationStartedAt: new Date(Date.now() - 10 * 60_000),
  };
  const deleted = [];
  const service = require("../services/misaImportRepairService").createMisaImportRepairService({
    now: () => new Date(),
    RepairSession: {
      findOne: async () => repair,
      findOneAndUpdate: async (_filter, update) => {
        Object.assign(repair, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) delete repair[key];
        return repair;
      },
    },
    Issue: {
      deleteMany: async (filter) => {
        deleted.push(filter);
        return { acknowledged: true, deletedCount: 1 };
      },
    },
  });

  const loaded = await service.loadRepair(SESSION_ID, "user-1");
  assert.equal(loaded.pendingMutationId, undefined);
  assert.equal(deleted[0].schemaGenerationId, staleMutationId);
});
