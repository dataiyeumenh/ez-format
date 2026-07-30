const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const RUN_ID = "507f1f77bcf86cd799439011";
const REPAIR_ID = "507f1f77bcf86cd799439012";
const ISSUE_ID = "507f1f77bcf86cd799439013";
const BATCH_ID = "507f1f77bcf86cd799439014";

function manifest() {
  return {
    schema_version: 1,
    conversion_id: RUN_ID,
    export_batch_id: `export-${RUN_ID}`,
    misa_product: "SME",
    misa_version: null,
    target_template_id: "bsn_sales",
    template_hash: "a".repeat(64),
    raw_file_hash: "b".repeat(64),
    mapping_profile_id: "profile-1",
    mapping_profile_version: 1,
    mapping_profile_state_hash: "c".repeat(64),
    validation_ruleset_version: "misa-readiness-v1",
    rows: [
      {
        export_row_id: "row-1",
        output_row_number: 1,
        document_group_id: "group-1",
        raw_row_ids: ["raw-1"],
        locator: { document_number: "BH0001", item_code: "HH01" },
        line_fingerprint: "d".repeat(64),
      },
      {
        export_row_id: "row-2",
        output_row_number: 2,
        document_group_id: "group-1",
        raw_row_ids: ["raw-2"],
        locator: { document_number: "BH0001", item_code: "HH02" },
        line_fingerprint: "e".repeat(64),
      },
    ],
    document_groups: [
      {
        document_group_id: "group-1",
        output_row_numbers: [1, 2],
        raw_row_ids: ["raw-1", "raw-2"],
        line_count: 2,
        amount_total: null,
        group_integrity: "deterministic",
      },
    ],
  };
}

function repair(overrides = {}) {
  return {
    _id: REPAIR_ID,
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
    documentGroupStatuses: [
      {
        documentGroupId: "group-1",
        status: "failed",
        userConfirmed: true,
        confirmedBy: "user-1",
        confirmedAt: new Date(),
      },
    ],
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function resolvedIssue(overrides = {}) {
  return {
    _id: ISSUE_ID,
    repairSession: REPAIR_ID,
    ownerScope: "user:user-1",
    workspace: null,
    schemaGenerationId: "generation-1",
    matchStatus: "confirmed",
    userConfirmedMatch: true,
    confirmedDocumentGroupId: "group-1",
    normalizedLocator: { lineFingerprint: "d".repeat(64) },
    candidates: [
      {
        documentGroupId: "group-1",
        evidence: JSON.stringify({ output_row_number: 1 }),
      },
    ],
    resolution: {
      status: "resolved",
      scope: "once",
      patch: { field: "Mã hàng (*)", value: "HH01", transform: "set_value" },
    },
    ...overrides,
  };
}

function run() {
  return {
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
  };
}

function fakeDependencies({
  readiness,
  issues,
  batch,
  artifactPutError = null,
  artifactDeleteError = null,
  batchSaveError = null,
  finalSessionUpdateError = null,
  finalSessionUpdateBarrier = null,
} = {}) {
  const storedManifest = Buffer.from(JSON.stringify(manifest()));
  const batches = batch ? [batch] : [];
  const putCalls = [];
  const jsonCalls = [];
  const binaryCalls = [];
  const deleteCalls = [];
  const confirmations = [];
  const batchSaveOptions = [];
  const sessionUpdateOptions = [];
  let chargeCalls = 0;

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
    constructor(value) { Object.assign(this, value, { _id: BATCH_ID }); }
    async save(options = {}) {
      batchSaveOptions.push(options);
      if (batchSaveError) throw batchSaveError;
      if (!batches.includes(this)) batches.push(this);
      return this;
    }
    static async deleteOne(query) {
      const index = batches.findIndex((item) =>
        (!query._id || String(item._id) === String(query._id)) &&
        (!query.idempotencyKey || item.idempotencyKey === query.idempotencyKey),
      );
      if (index >= 0) batches.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    }
    static async findOneAndUpdate(query, update) {
      const item = await RetryBatch.findOne(query);
      if (!item) return null;
      Object.assign(item, update.$set || {});
      return item;
    }
  }

  class HumanConfirmation {
    constructor(value) { Object.assign(this, value); }
    async save() {
      confirmations.push(this);
      return this;
    }
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

  const currentRepair = repair();
  const issueRows = issues || [resolvedIssue()];
  const artifacts = {
    async getArtifact(input) {
      if (input.kind === "manifest") {
        return {
          metadata: { storageKey: "manifest-key", sha256: "f".repeat(64) },
          content: storedManifest,
        };
      }
      if (input.kind === "output") {
        return {
          metadata: { storageKey: "output-key", sha256: "9".repeat(64) },
          content: Buffer.from("original-output"),
        };
      }
      if (input.kind === "retry_output") {
        if (batch?.artifactError) throw batch.artifactError;
        return {
          metadata: {
            storageKey: batch?.outputArtifactKey || "retry-key",
            sha256: batch?.outputSha256 || crypto.createHash("sha256").update("retry-workbook").digest("hex"),
            contentType: "application/vnd.ms-excel",
          },
          content: Buffer.from("retry-workbook"),
        };
      }
      throw new Error(`unexpected artifact kind ${input.kind}`);
    },
    async putArtifact(input) {
      putCalls.push(input);
      if (artifactPutError) throw artifactPutError;
      return {
        storageKey: "retry-key",
        sha256: crypto.createHash("sha256").update(input.content).digest("hex"),
      };
    },
    async deleteArtifact(input) {
      deleteCalls.push(input);
      if (artifactDeleteError) throw artifactDeleteError;
    },
  };

  return {
    batches,
    batchSaveOptions,
    binaryCalls,
    confirmations,
    currentRepair,
    get chargeCalls() { return chargeCalls; },
    jsonCalls,
    putCalls,
    sessionUpdateOptions,
    deleteCalls,
    deps: {
      Run: { findOne: async () => run() },
      Workspace: { findOne: async () => null },
      HumanConfirmation,
      RepairSession: {
        findOne: async () => currentRepair,
        findOneAndUpdate: async (filter, update, options = {}) => {
          sessionUpdateOptions.push(options);
          if (filter.version !== undefined && filter.version !== currentRepair.version) return null;
          if (filter.pendingMutationId === null && currentRepair.pendingMutationId) return null;
          if (
            typeof filter.pendingMutationId === "string" &&
            filter.pendingMutationId !== currentRepair.pendingMutationId
          ) return null;
          if (finalSessionUpdateError && update.$set?.status === "retry_exported") {
            throw finalSessionUpdateError;
          }
          if (finalSessionUpdateBarrier && update.$set?.status === "retry_exported") {
            await finalSessionUpdateBarrier();
          }
          if (update.$set) Object.assign(currentRepair, update.$set);
          if (update.$unset) {
            for (const key of Object.keys(update.$unset)) delete currentRepair[key];
          }
          if (update.$inc?.version) currentRepair.version += update.$inc.version;
          return currentRepair;
        },
      },
      Issue: {
        find: async () => issueRows,
        findOne: async ({ _id }) => issueRows.find((item) => String(item._id) === String(_id)) || null,
        findOneAndUpdate: async ({ _id }, update) => {
          const issue = issueRows.find((item) => String(item._id) === String(_id));
          if (!issue) return null;
          if (update.$set) Object.assign(issue, update.$set);
          if (update.$unset) for (const key of Object.keys(update.$unset)) delete issue[key];
          return issue;
        },
      },
      RetryBatch,
      artifacts,
      createToken: () => "signed-context",
      forwardJson: async (input) => {
        jsonCalls.push(input);
        return {
          status: 200,
          data: readiness || {
            status: "ready",
            summary: { fatal: 0, blocker: 0, warning: 0, info: 0 },
            issues: [],
            examples: [],
            selected_document_group_count: 1,
            selected_row_count: 2,
          },
        };
      },
      forwardBinary: async (input) => {
        binaryCalls.push(input);
        return {
          status: 200,
          headers: { "content-type": "application/vnd.ms-excel" },
          data: Buffer.from("retry-workbook"),
        };
      },
      chargeCompletedConversion: async () => { chargeCalls += 1; },
      simulationSecret: "test-simulation-secret",
      startSession: null,
    },
  };
}

async function issueConfirmation(service, action, body, { issueId, groupId } = {}) {
  if (action === "retry_export" && !body.readiness_hash && !body.readinessHash) {
    const workspace = await service.readWorkspace({
      userId: "user-1",
      repairId: REPAIR_ID,
      limit: 50,
      groupLimit: 100,
      requestId: "confirmation-preflight",
    });
    body.readiness_hash = workspace.readiness.hash;
  }
  const result = await service.issueHumanConfirmation({
    userId: "user-1",
    repairId: REPAIR_ID,
    action,
    body,
    issueId,
    groupId,
  });
  return result.token;
}

test("repair gateway exposes resolve, bulk, retry, and download routes", () => {
  const router = require("../routes/converterGateway").router;
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

  assert.ok(paths.includes("POST /import-repairs/:repairId/issues/:issueId/resolve"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/bulk-actions/simulate"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/bulk-actions/apply"));
  assert.ok(paths.includes("POST /import-repairs/:repairId/retry-batches"));
  assert.ok(paths.includes("GET /import-repairs/:repairId/retry-batches/:batchId/download"));
});

test("retry gate blocks unknown, mixed, ambiguous, unresolved, and unacknowledged warnings", () => {
  const { assertRetryGate } = require("../services/misaImportRepairService");
  const goodGroup = { documentGroupId: "group-1", status: "failed", userConfirmed: true };
  const goodIssue = resolvedIssue();
  const ready = { summary: { fatal: 0, blocker: 0, warning: 0 } };

  for (const status of ["unknown", "imported", "mixed"]) {
    assert.throws(
      () => assertRetryGate({ groups: [{ ...goodGroup, status }], issues: [goodIssue], readiness: ready }),
      (error) => error.statusCode === 409,
    );
  }
  assert.throws(
    () => assertRetryGate({ groups: [goodGroup], issues: [{ ...goodIssue, matchStatus: "ambiguous" }], readiness: ready }),
    (error) => error.statusCode === 409,
  );
  assert.throws(
    () => assertRetryGate({ groups: [goodGroup], issues: [{ ...goodIssue, resolution: { status: "unresolved" } }], readiness: ready }),
    (error) => error.statusCode === 409,
  );
  assert.throws(
    () => assertRetryGate({ groups: [goodGroup], issues: [goodIssue], readiness: { summary: { fatal: 0, blocker: 0, warning: 1 } } }),
    (error) => error.statusCode === 409,
  );
});

test("resolution patch rejects AI, formulas, nested values, and arbitrary transforms", () => {
  const { validateResolutionPatch } = require("../services/misaImportRepairService");
  assert.throws(() => validateResolutionPatch({ actor: "ai", patch: { field: "A", value: "B" } }));
  assert.throws(() => validateResolutionPatch({ patch: { field: "A", value: "=1+1" } }));
  assert.throws(() => validateResolutionPatch({ patch: { field: "A", value: { nested: true } } }));
  assert.throws(() => validateResolutionPatch({ patch: { field: "A", value: "B", transform: "eval" } }));
  assert.deepEqual(
    validateResolutionPatch({ patch: { field: "A", value: "B" } }),
    { field: "A", value: "B", transform: "set_value" },
  );
});

test("bulk simulation is capped, signed, and apply rejects a mismatched simulation hash", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies({ issues: [resolvedIssue({ resolution: { status: "unresolved" } })] });
  const service = createMisaImportRepairService(fake.deps);

  await assert.rejects(
    service.simulateBulk({
      userId: "user-1",
      repairId: REPAIR_ID,
      body: {
        expected_version: 8,
        issue_ids: Array.from({ length: 501 }, (_, index) => String(index)),
        patch: { field: "Mã hàng (*)", value: "HH01" },
      },
      requestId: "request-1",
    }),
    (error) => error.statusCode === 422,
  );

  const simulation = await service.simulateBulk({
    userId: "user-1",
    repairId: REPAIR_ID,
    body: {
      expected_version: 8,
      issue_ids: [ISSUE_ID],
      patch: { field: "Mã hàng (*)", value: "HH01" },
    },
    requestId: "request-1",
  });
  assert.equal(simulation.affectedIssueCount, 1);
  assert.equal(simulation.documentGroupCount, 1);
  assert.match(simulation.simulationHash, /^[a-f0-9]{64}$/);

  await assert.rejects(
    service.applyBulk({
      userId: "user-1",
      repairId: REPAIR_ID,
      body: {
        expected_version: 8,
        issue_ids: [ISSUE_ID],
        patch: { field: "Mã hàng (*)", value: "HH01" },
        simulation_hash: "0".repeat(64),
      },
      requestId: "request-1",
    }),
    (error) => error.statusCode === 409,
  );
});

test("bulk apply revalidates the signed simulation and stores proposal metadata without mutation APIs", async () => {
  const unresolved = resolvedIssue({ resolution: { status: "unresolved" } });
  const fake = fakeDependencies({ issues: [unresolved] });
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const service = createMisaImportRepairService(fake.deps);
  const body = {
    expected_version: 8,
    issue_ids: [ISSUE_ID],
    scope: "master_data_proposal",
    patch: { field: "Mã hàng (*)", value: "HH01" },
  };
  const simulation = await service.simulateBulk({
    userId: "user-1", repairId: REPAIR_ID, body, requestId: "request-1",
  });
  const applyBody = { ...body, simulation_hash: simulation.simulationHash };
  const humanConfirmationToken = await issueConfirmation(service, "bulk_apply", applyBody);

  const result = await service.applyBulk({
    userId: "user-1",
    repairId: REPAIR_ID,
    body: applyBody,
    humanConfirmationToken,
    requestId: "request-2",
  });

  assert.equal(result.affectedIssueCount, 1);
  assert.equal(unresolved.resolution.status, "resolved");
  assert.equal(unresolved.resolution.scope, "master_data_proposal");
  assert.equal(unresolved.resolution.patch.proposal_status, "pending");
  assert.equal(fake.chargeCalls, 0);
});

test("single resolution rejects blockers before consuming its confirmation token", async () => {
  const readiness = {
    status: "blocked",
    summary: { fatal: 0, blocker: 1, warning: 0, info: 0 },
    issues: [{ severity: "blocker", code: "invalid_value", message: "Invalid value" }],
    examples: [],
    selected_document_group_count: 1,
    selected_row_count: 2,
  };
  const unresolved = resolvedIssue({ resolution: { status: "unresolved", scope: "once", patch: null } });
  const fake = fakeDependencies({ issues: [unresolved], readiness });
  fake.currentRepair.summary.unresolvedIssues = 1;
  const service = require("../services/misaImportRepairService").createMisaImportRepairService(fake.deps);
  const body = {
    expected_version: 8,
    scope: "once",
    patch: { field: "Mã hàng (*)", value: "INVALID" },
    acknowledge_warnings: false,
  };
  const token = await issueConfirmation(service, "resolve_issue", body, { issueId: ISSUE_ID });

  await assert.rejects(
    service.resolveIssue({
      userId: "user-1",
      repairId: REPAIR_ID,
      issueId: ISSUE_ID,
      body,
      humanConfirmationToken: token,
      requestId: "resolve-blocker",
    }),
    (error) => error.statusCode === 422 && error.code === "RESOLUTION_READINESS_BLOCKED",
  );
  assert.equal(unresolved.resolution.status, "unresolved");

  readiness.status = "ready";
  readiness.summary.blocker = 0;
  readiness.issues = [];
  const result = await service.resolveIssue({
    userId: "user-1",
    repairId: REPAIR_ID,
    issueId: ISSUE_ID,
    body,
    humanConfirmationToken: token,
    requestId: "resolve-green",
  });
  assert.equal(result.issue.resolution.status, "resolved");
});

test("resolution warnings require an explicit token-bound acknowledgement", async () => {
  const readiness = {
    status: "warning",
    summary: { fatal: 0, blocker: 0, warning: 1, info: 0 },
    issues: [{ severity: "warning", code: "review", message: "Review value" }],
    examples: [],
    selected_document_group_count: 1,
    selected_row_count: 2,
  };
  const unresolved = resolvedIssue({ resolution: { status: "unresolved", scope: "once", patch: null } });
  const fake = fakeDependencies({ issues: [unresolved], readiness });
  fake.currentRepair.summary.unresolvedIssues = 1;
  const service = require("../services/misaImportRepairService").createMisaImportRepairService(fake.deps);
  const baseBody = {
    expected_version: 8,
    scope: "once",
    patch: { field: "Mã hàng (*)", value: "HH02" },
    acknowledge_warnings: false,
  };
  const unacknowledgedToken = await issueConfirmation(service, "resolve_issue", baseBody, { issueId: ISSUE_ID });

  await assert.rejects(
    service.resolveIssue({
      userId: "user-1",
      repairId: REPAIR_ID,
      issueId: ISSUE_ID,
      body: baseBody,
      humanConfirmationToken: unacknowledgedToken,
      requestId: "resolve-warning",
    }),
    (error) => error.statusCode === 409 && error.code === "RESOLUTION_WARNING_ACK_REQUIRED",
  );
  const acknowledgedBody = { ...baseBody, acknowledge_warnings: true };
  const acknowledgedToken = await issueConfirmation(
    service,
    "resolve_issue",
    acknowledgedBody,
    { issueId: ISSUE_ID },
  );
  const result = await service.resolveIssue({
    userId: "user-1",
    repairId: REPAIR_ID,
    issueId: ISSUE_ID,
    body: acknowledgedBody,
    humanConfirmationToken: acknowledgedToken,
    requestId: "resolve-warning-ack",
  });
  assert.equal(result.issue.resolution.patch.value, "HH02");
});

test("resolved issue accepts a fully revalidated replacement resolution", async () => {
  const issue = resolvedIssue();
  const fake = fakeDependencies({ issues: [issue] });
  const service = require("../services/misaImportRepairService").createMisaImportRepairService(fake.deps);
  const body = {
    expected_version: 8,
    scope: "once",
    patch: { field: "Mã hàng (*)", value: "HH99" },
    acknowledge_warnings: false,
  };
  const token = await issueConfirmation(service, "resolve_issue", body, { issueId: ISSUE_ID });

  const result = await service.resolveIssue({
    userId: "user-1",
    repairId: REPAIR_ID,
    issueId: ISSUE_ID,
    body,
    humanConfirmationToken: token,
    requestId: "replace-resolution",
  });

  assert.equal(result.issue.resolution.status, "resolved");
  assert.equal(result.issue.resolution.patch.value, "HH99");
  assert.equal(fake.currentRepair.summary.unresolvedIssues, 0);
});

test("bulk apply rejects deterministic blockers before persisting", async () => {
  const readiness = {
    status: "blocked",
    summary: { fatal: 1, blocker: 0, warning: 0, info: 0 },
    issues: [{ severity: "fatal", code: "unsafe", message: "Unsafe patch" }],
    examples: [],
    selected_document_group_count: 1,
    selected_row_count: 2,
  };
  const unresolved = resolvedIssue({ resolution: { status: "unresolved", scope: "once", patch: null } });
  const fake = fakeDependencies({ issues: [unresolved], readiness });
  fake.currentRepair.summary.unresolvedIssues = 1;
  const service = require("../services/misaImportRepairService").createMisaImportRepairService(fake.deps);
  const body = {
    expected_version: 8,
    issue_ids: [ISSUE_ID],
    scope: "once",
    patch: { field: "Mã hàng (*)", value: "INVALID" },
    acknowledge_warnings: false,
  };
  const simulation = await service.simulateBulk({
    userId: "user-1", repairId: REPAIR_ID, body, requestId: "bulk-blocker-simulate",
  });
  const applyBody = { ...body, simulation_hash: simulation.simulationHash };
  const token = await issueConfirmation(service, "bulk_apply", applyBody);

  await assert.rejects(
    service.applyBulk({
      userId: "user-1",
      repairId: REPAIR_ID,
      body: applyBody,
      humanConfirmationToken: token,
      requestId: "bulk-blocker-apply",
    }),
    (error) => error.statusCode === 422 && error.code === "RESOLUTION_READINESS_BLOCKED",
  );
  assert.equal(unresolved.resolution.status, "unresolved");
});

test("workspace exposes version-bound warning preflight and rejects stale readiness hashes", async () => {
  const readiness = {
    status: "warning",
    summary: { fatal: 0, blocker: 0, warning: 1, info: 0 },
    issues: [{ severity: "warning", code: "review_tax", message: "Rà soát thuế", raw_row: { secret: true } }],
    examples: [],
    selected_document_group_count: 1,
    selected_row_count: 2,
  };
  const issueRows = [resolvedIssue()];
  const fake = fakeDependencies({ issues: issueRows, readiness });
  fake.deps.Issue.find = () => {
    let rows = issueRows;
    return {
      sort() { return this; },
      async limit(value) { return rows.slice(0, value); },
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    };
  };
  const service = require("../services/misaImportRepairService").createMisaImportRepairService(fake.deps);

  const workspace = await service.readWorkspace({
    userId: "user-1", repairId: REPAIR_ID, limit: 50, groupLimit: 100, requestId: "preflight-read",
  });

  assert.equal(workspace.readiness.version, 8);
  assert.equal(workspace.readiness.summary.warning, 1);
  assert.match(workspace.readiness.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(workspace.readiness.issues, [{
    severity: "warning",
    code: "review_tax",
    message: "Rà soát thuế",
    field: "",
    rowNumber: null,
  }]);
  await assert.rejects(
    service.issueHumanConfirmation({
      userId: "user-1",
      repairId: REPAIR_ID,
      action: "retry_export",
      body: {
        expected_version: 8,
        document_group_ids: ["group-1"],
        acknowledge_warnings: true,
        readiness_hash: "0".repeat(64),
      },
    }),
    (error) => error.statusCode === 409 && error.code === "STALE_READINESS_PREFLIGHT",
  );
  const withoutAck = await service.issueHumanConfirmation({
    userId: "user-1",
    repairId: REPAIR_ID,
    action: "retry_export",
    body: {
      expected_version: 8,
      document_group_ids: ["group-1"],
      acknowledge_warnings: false,
      readiness_hash: workspace.readiness.hash,
    },
  });
  const withAck = await service.issueHumanConfirmation({
    userId: "user-1",
    repairId: REPAIR_ID,
    action: "retry_export",
    body: {
      expected_version: 8,
      document_group_ids: ["group-1"],
      acknowledge_warnings: true,
      readiness_hash: workspace.readiness.hash,
    },
  });
  assert.notEqual(withoutAck.payloadHash, withAck.payloadHash);
});

test("retry exports the full document group, stores owned revision, is idempotent, and never charges", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies();
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "retry-1",
    body: {
      expected_version: 8,
      document_group_ids: ["group-1"],
      acknowledge_warnings: false,
    },
    requestId: "request-1",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);

  const first = await service.createRetryBatch({
    ...input,
    body: {
      expectedVersion: 8,
      documentGroupIds: ["group-1"],
      acknowledgeWarnings: false,
      readinessHash: input.body.readiness_hash,
    },
  });
  const second = await service.createRetryBatch(input);

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(fake.binaryCalls.length, 1);
  assert.equal(fake.putCalls.length, 1);
  assert.equal(fake.putCalls[0].kind, "retry_output");
  assert.equal(fake.putCalls[0].revision, 1);
  assert.equal(fake.putCalls[0].ownerScope, "user:user-1");
  assert.equal(fake.jsonCalls[0].body.selected_document_group_ids[0], "group-1");
  assert.equal(fake.jsonCalls[0].body.patches[0].output_row_number, 1);
  assert.equal(fake.jsonCalls[0].data, undefined);
  assert.equal(fake.chargeCalls, 0);

  await assert.rejects(
    service.createRetryBatch({
      ...input,
      body: { ...input.body, acknowledge_warnings: true },
    }),
    (error) => error.statusCode === 409,
  );
});

test("retry mutation rejects omitted or falsified client human metadata", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies();
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-human-gate",
    body: {
      expected_version: 8,
      document_group_ids: ["group-1"],
      acknowledge_warnings: false,
      actor: "human",
      source: "manual",
      ai_generated: false,
    },
    requestId: "request-human-gate",
  };

  await assert.rejects(
    service.createRetryBatch(input),
    (error) => error.code === "HUMAN_CONFIRMATION_REQUIRED",
  );

  const validBody = { ...input.body, actor: undefined, source: undefined, ai_generated: undefined };
  const validToken = await issueConfirmation(service, "retry_export", validBody);
  await service.createRetryBatch({
    ...input,
    idempotencyKey: "review-human-gate-valid",
    body: validBody,
    humanConfirmationToken: validToken,
  });
  fake.currentRepair.version = 8;
  fake.currentRepair.status = "ready_for_repair";
  await assert.rejects(
    service.createRetryBatch({
      ...input,
      idempotencyKey: "review-human-gate-reused",
      body: validBody,
      humanConfirmationToken: validToken,
    }),
    (error) => error.code === "HUMAN_CONFIRMATION_REQUIRED",
  );
});

test("status confirmation and issue resolution consume action-bound server tokens", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const unresolved = resolvedIssue({ resolution: { status: "unresolved" } });
  const fake = fakeDependencies({ issues: [unresolved] });
  const service = createMisaImportRepairService(fake.deps);
  const statusBody = { expected_version: 8, status: "imported" };
  const statusToken = await issueConfirmation(
    service,
    "set_import_status",
    statusBody,
    { groupId: "group-1" },
  );
  await service.setImportStatus({
    userId: "user-1",
    repairId: REPAIR_ID,
    groupId: "group-1",
    body: statusBody,
    humanConfirmationToken: statusToken,
  });

  fake.currentRepair.version = 8;
  const resolveBody = {
    expected_version: 8,
    scope: "once",
    patch: { field: "Mã hàng (*)", value: "HH01", transform: "set_value" },
  };
  const resolveToken = await issueConfirmation(
    service,
    "resolve_issue",
    resolveBody,
    { issueId: ISSUE_ID },
  );
  const result = await service.resolveIssue({
    userId: "user-1",
    repairId: REPAIR_ID,
    issueId: ISSUE_ID,
    body: resolveBody,
    humanConfirmationToken: resolveToken,
    requestId: "request-resolve-token",
  });
  assert.equal(result.issue.resolution.status, "resolved");
});

test("retry idempotency fingerprints the effective resolution set", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const issue = resolvedIssue();
  const fake = fakeDependencies({ issues: [issue] });
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-effective-payload",
    body: {
      expected_version: 8,
      document_group_ids: ["group-1"],
      acknowledge_warnings: false,
    },
    requestId: "request-effective-payload",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);

  await service.createRetryBatch(input);
  issue.resolution.patch.value = "HH99";
  await assert.rejects(
    service.createRetryBatch(input),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  issue.resolution.patch.value = "HH01";
  fake.currentRepair.activeSchemaGenerationId = "generation-2";
  await assert.rejects(
    service.createRetryBatch(input),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("retry rejects an overlong idempotency key instead of truncating it", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies();
  await assert.rejects(
    createMisaImportRepairService(fake.deps).createRetryBatch({
      userId: "user-1",
      repairId: REPAIR_ID,
      idempotencyKey: "k".repeat(257),
      body: { expected_version: 8, document_group_ids: ["group-1"] },
      requestId: "request-long-key",
    }),
    (error) => error.code === "IDEMPOTENCY_KEY_INVALID",
  );
});

test("retry rejects conflicting snake-case and camel-case aliases", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const service = createMisaImportRepairService(fakeDependencies().deps);
  const cases = [
    {
      document_group_ids: ["group-1"],
      documentGroupIds: ["group-2"],
      expected_version: 8,
    },
    {
      document_group_ids: ["group-1"],
      expected_version: 8,
      acknowledge_warnings: false,
      acknowledgeWarnings: true,
    },
    {
      document_group_ids: ["group-1"],
      expected_version: 8,
      expectedVersion: 9,
    },
  ];

  for (const [index, body] of cases.entries()) {
    await assert.rejects(
      service.createRetryBatch({
        userId: "user-1",
        repairId: REPAIR_ID,
        idempotencyKey: `conflicting-alias-${index}`,
        body,
        requestId: `request-conflicting-alias-${index}`,
      }),
      (error) => error.code === "INVALID_RETRY_PAYLOAD",
    );
  }
});

test("retry persistence creates no artifact when recovery batch save fails", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies({ batchSaveError: new Error("batch write failed") });
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-batch-failure",
    body: { expected_version: 8, document_group_ids: ["group-1"] },
    requestId: "request-batch-failure",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);
  await assert.rejects(
    service.createRetryBatch(input),
    /batch write failed/,
  );
  assert.equal(fake.putCalls.length, 0);
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(fake.batches.length, 0);
});

test("retry persistence creates no batch when artifact storage fails", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies({ artifactPutError: new Error("artifact write failed") });
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-artifact-failure",
    body: { expected_version: 8, document_group_ids: ["group-1"] },
    requestId: "request-artifact-failure",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);
  await assert.rejects(service.createRetryBatch(input), /artifact write failed/);
  assert.equal(fake.batches.length, 0);
  assert.equal(fake.deleteCalls.length, 0);
});

test("retry persistence deletes the batch and artifact when session CAS fails", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies({ finalSessionUpdateError: new Error("session CAS failed") });
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-session-failure",
    body: { expected_version: 8, document_group_ids: ["group-1"] },
    requestId: "request-session-failure",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);
  await assert.rejects(
    service.createRetryBatch(input),
    /session CAS failed/,
  );
  assert.equal(fake.deleteCalls.length, 1);
  assert.equal(fake.batches.length, 0);
});

test("retry persistence records cleanup-required state when artifact compensation fails", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies({
    finalSessionUpdateError: new Error("session CAS failed"),
    artifactDeleteError: new Error("artifact cleanup failed"),
  });
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-cleanup-failure",
    body: { expected_version: 8, document_group_ids: ["group-1"] },
    requestId: "request-cleanup-failure",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);

  await assert.rejects(
    service.createRetryBatch(input),
    (error) => error.code === "REPAIR_ROLLBACK_FAILED",
  );
  assert.equal(fake.batches.length, 1);
  assert.equal(fake.batches[0].status, "failed");
  assert.equal(fake.batches[0].recoveryState, "cleanup_required");
  assert.match(fake.batches[0].recoveryError, /artifact cleanup failed/);
  assert.match(fake.currentRepair.pendingMutationId, /^retry:/);
});

test("retry batch and session CAS share one Mongo transaction when supported", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const mongoSession = {
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  };
  const fake = fakeDependencies();
  fake.deps.startSession = async () => mongoSession;
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-transaction",
    body: { expected_version: 8, document_group_ids: ["group-1"] },
    requestId: "request-transaction",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);
  await service.createRetryBatch(input);
  assert.equal(fake.batchSaveOptions.at(-1).session, mongoSession);
  assert.equal(fake.sessionUpdateOptions.at(-2).session, undefined);
  assert.equal(fake.sessionUpdateOptions.at(-1).session, mongoSession);
});

test("retry transaction failure removes the pending batch and external artifact", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const mongoSession = {
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  };
  const fake = fakeDependencies({ finalSessionUpdateError: new Error("transaction CAS failed") });
  fake.deps.startSession = async () => mongoSession;
  const service = createMisaImportRepairService(fake.deps);
  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "review-transaction-failure",
    body: { expected_version: 8, document_group_ids: ["group-1"] },
    requestId: "request-transaction-failure",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);

  await assert.rejects(service.createRetryBatch(input), /transaction CAS failed/);
  assert.equal(fake.batches.length, 0);
  assert.equal(fake.deleteCalls.length, 1);
  assert.equal(fake.currentRepair.pendingMutationId, undefined);
});

test("concurrent retry requests reserve the session before writing one artifact revision", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies();
  const service = createMisaImportRepairService(fake.deps);
  const body = { expected_version: 8, document_group_ids: ["group-1"] };
  const [tokenOne, tokenTwo] = await Promise.all([
    issueConfirmation(service, "retry_export", body),
    issueConfirmation(service, "retry_export", body),
  ]);
  const results = await Promise.allSettled([
    service.createRetryBatch({
      userId: "user-1",
      repairId: REPAIR_ID,
      idempotencyKey: "concurrent-one",
      body,
      humanConfirmationToken: tokenOne,
      requestId: "request-concurrent-one",
    }),
    service.createRetryBatch({
      userId: "user-1",
      repairId: REPAIR_ID,
      idempotencyKey: "concurrent-two",
      body,
      humanConfirmationToken: tokenTwo,
      requestId: "request-concurrent-two",
    }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(fake.putCalls.length, 1);
  assert.equal(fake.batches.length, 1);
});

test("same-key replay cannot publish a batch before the repair session commits", async () => {
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  let releaseSessionUpdate;
  let sessionUpdateStarted;
  const sessionUpdateEntered = new Promise((resolve) => { sessionUpdateStarted = resolve; });
  const sessionUpdateBlocked = new Promise((resolve) => { releaseSessionUpdate = resolve; });
  const fake = fakeDependencies({
    finalSessionUpdateBarrier: async () => {
      sessionUpdateStarted();
      await sessionUpdateBlocked;
    },
  });
  const service = createMisaImportRepairService(fake.deps);
  const body = { expected_version: 8, document_group_ids: ["group-1"] };
  const token = await issueConfirmation(service, "retry_export", body);
  const first = service.createRetryBatch({
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "same-key-in-flight",
    body,
    humanConfirmationToken: token,
    requestId: "request-in-flight-first",
  });
  await sessionUpdateEntered;

  await assert.rejects(
    service.createRetryBatch({
      userId: "user-1",
      repairId: REPAIR_ID,
      idempotencyKey: "same-key-in-flight",
      body,
      requestId: "request-in-flight-replay",
    }),
    (error) => error.statusCode === 409 && [
      "REPAIR_MUTATION_IN_PROGRESS",
      "RETRY_BATCH_NOT_COMPLETE",
    ].includes(error.code),
  );
  releaseSessionUpdate();
  await first;
});

test("same-key replay rejects an incomplete retry batch", async () => {
  const key = "review-incomplete";
  const storedKey = crypto.createHash("sha256").update(`${REPAIR_ID}:${key}`).digest("hex");
  const incomplete = {
    _id: BATCH_ID,
    repairSession: REPAIR_ID,
    ownerScope: "user:user-1",
    workspace: null,
    idempotencyKey: storedKey,
    status: "exporting",
    readinessSummary: {},
  };
  const fake = fakeDependencies({ batch: incomplete });
  const service = require("../services/misaImportRepairService").createMisaImportRepairService(fake.deps);
  const body = { expected_version: 8, document_group_ids: ["group-1"] };
  const token = await issueConfirmation(service, "retry_export", body);
  const issued = fake.confirmations.at(-1);
  incomplete.readinessSummary.requestFingerprint = issued.payloadHash;
  await assert.rejects(
    service.createRetryBatch({
      userId: "user-1",
      repairId: REPAIR_ID,
      idempotencyKey: key,
      body,
      humanConfirmationToken: token,
      requestId: "request-incomplete",
    }),
    (error) => error.code === "RETRY_BATCH_NOT_COMPLETE",
  );
});

test("stale retry reconciliation removes the pending batch and artifact before releasing the session", async () => {
  const mutationId = "retry:stale-mutation";
  const pending = {
    _id: BATCH_ID,
    repairSession: REPAIR_ID,
    ownerScope: "user:user-1",
    workspace: null,
    idempotencyKey: "stale-key",
    mutationId,
    status: "exporting",
    readinessSummary: { sequence: 1, requestFingerprint: "f".repeat(64) },
  };
  const missingArtifact = new Error("artifact was never published");
  missingArtifact.statusCode = 404;
  const fake = fakeDependencies({ batch: pending, artifactDeleteError: missingArtifact });
  fake.currentRepair.pendingMutationId = mutationId;
  fake.currentRepair.pendingMutationType = "confirm";
  fake.currentRepair.pendingMutationStartedAt = new Date(Date.now() - 5 * 60 * 1000);
  fake.currentRepair.pendingRecoveryId = null;
  const service = require("../services/misaImportRepairService").createMisaImportRepairService(fake.deps);

  const loaded = await service.loadRepair(REPAIR_ID, "user-1");

  assert.equal(fake.deleteCalls.length, 1);
  assert.equal(fake.deleteCalls[0].revision, 1);
  assert.equal(fake.batches.length, 0);
  assert.equal(loaded.pendingMutationId, undefined);
  assert.equal(loaded.pendingRecoveryId, undefined);
});

test("retry applies proposal patches as current-only changes and excludes unselected groups", async () => {
  const proposalIssue = resolvedIssue({
    resolution: {
      status: "resolved",
      scope: "profile_proposal",
      patch: {
        field: "Mã hàng (*)",
        value: "HH01",
        transform: "set_value",
        proposal_type: "profile_proposal",
        proposal_status: "pending",
        proposed_by: "user-1",
        proposed_at: new Date().toISOString(),
      },
    },
  });
  const unselectedIssue = resolvedIssue({
    _id: "507f1f77bcf86cd799439015",
    confirmedDocumentGroupId: "group-2",
    candidates: [{
      documentGroupId: "group-2",
      evidence: JSON.stringify({ output_row_number: 3 }),
    }],
  });
  const fake = fakeDependencies({ issues: [proposalIssue, unselectedIssue] });
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const service = createMisaImportRepairService(fake.deps);

  const input = {
    userId: "user-1",
    repairId: REPAIR_ID,
    idempotencyKey: "retry-proposal",
    body: {
      expected_version: 8,
      document_group_ids: ["group-1"],
      acknowledge_warnings: false,
    },
    requestId: "request-1",
  };
  input.humanConfirmationToken = await issueConfirmation(service, "retry_export", input.body);
  await service.createRetryBatch(input);

  assert.equal(fake.jsonCalls[0].body.patches.length, 1);
  assert.deepEqual(fake.jsonCalls[0].body.patches[0], {
    document_group_id: "group-1",
    output_row_number: 1,
    field: "Mã hàng (*)",
    value: "HH01",
    transform: "set_value",
  });
});

test("bulk simulation fails closed when a multi-line group has no unique output row", async () => {
  const ambiguousTarget = resolvedIssue({
    resolution: { status: "unresolved" },
    candidates: [
      { documentGroupId: "group-1", evidence: JSON.stringify({ output_row_number: 1 }) },
      { documentGroupId: "group-1", evidence: JSON.stringify({ output_row_number: 2 }) },
    ],
  });
  const fake = fakeDependencies({ issues: [ambiguousTarget] });
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");

  await assert.rejects(
    createMisaImportRepairService(fake.deps).simulateBulk({
      userId: "user-1",
      repairId: REPAIR_ID,
      body: {
        expected_version: 8,
        issue_ids: [ISSUE_ID],
        patch: { field: "Mã hàng (*)", value: "HH01" },
      },
      requestId: "request-1",
    }),
    (error) => error.statusCode === 409 && error.code === "PATCH_TARGET_AMBIGUOUS",
  );
});

test("retry download enforces ownership binding, checksum binding, and artifact expiry", async () => {
  const digest = crypto.createHash("sha256").update("retry-workbook").digest("hex");
  const completed = {
    _id: BATCH_ID,
    repairSession: REPAIR_ID,
    ownerScope: "user:user-1",
    workspace: null,
    status: "completed",
    outputArtifactKey: "retry-key",
    outputSha256: digest,
    readinessSummary: { sequence: 1 },
  };
  const { createMisaImportRepairService } = require("../services/misaImportRepairService");
  const fake = fakeDependencies({ batch: completed });
  const service = createMisaImportRepairService(fake.deps);

  const download = await service.downloadRetryBatch({
    userId: "user-1",
    repairId: REPAIR_ID,
    batchId: BATCH_ID,
  });
  assert.equal(download.content.toString(), "retry-workbook");

  const wrongOwner = fakeDependencies({ batch: { ...completed, ownerScope: "user:other" } });
  await assert.rejects(
    createMisaImportRepairService(wrongOwner.deps).downloadRetryBatch({
      userId: "user-1", repairId: REPAIR_ID, batchId: BATCH_ID,
    }),
    (error) => error.statusCode === 404,
  );

  const expired = fakeDependencies({
    batch: { ...completed, artifactError: Object.assign(new Error("expired"), { statusCode: 410 }) },
  });
  await assert.rejects(
    createMisaImportRepairService(expired.deps).downloadRetryBatch({
      userId: "user-1", repairId: REPAIR_ID, batchId: BATCH_ID,
    }),
    (error) => error.statusCode === 410,
  );
});
