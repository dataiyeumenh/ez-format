const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  cleanReconstructionRunPayload,
  nextRunStatus,
  serializeReconstructionRun,
} = require("../services/reconstructionRunService");
const {
  createReconstructionContextToken,
  verifyReconstructionContextToken,
} = require("../services/conversionContextService");
const { hasConversionCredit } = require("../services/conversionCreditService");

test("reconstruction run payload keeps safe metadata only", () => {
  assert.deepEqual(
    cleanReconstructionRunPayload({
      fileName: " ../MUA_VAO.xlsx ",
      fileSizeBytes: "1200",
      workspaceId: "workspace-id",
      mode: "purchase",
      targetTemplateId: "purchase_goods",
      rawRows: [{ secret: true }],
    }),
    {
      fileName: "..MUA_VAO.xlsx",
      fileSizeBytes: 1200,
      workspaceId: "workspace-id",
      mode: "purchase",
      targetTemplateId: "purchase_goods",
    },
  );
});

test("reconstruction lifecycle rejects invalid backwards transitions", () => {
  assert.equal(nextRunStatus("created", "analyzing"), "analyzing");
  assert.equal(nextRunStatus("analyzing", "review_required"), "review_required");
  assert.equal(nextRunStatus("review_required", "approved"), "approved");
  assert.equal(nextRunStatus("approved", "exported"), "exported");
  assert.throws(() => nextRunStatus("exported", "analyzing"), /không hợp lệ/i);
});

test("reconstruction context carries run scope and workspace revision", () => {
  process.env.CONVERSION_CONTEXT_SECRET = "test-reconstruction-secret";
  const token = createReconstructionContextToken({
    userId: "user-1",
    runId: "run-1",
    workspaceId: "workspace-1",
    snapshotSetHash: "snapshot-hash",
    snapshotIds: ["snapshot-1"],
    masterDataRevision: 4,
  });

  const claims = verifyReconstructionContextToken(token);
  assert.equal(claims.purpose, "misa_reconstruction");
  assert.equal(claims.run_id, "run-1");
  assert.equal(claims.workspace_id, "workspace-1");
  assert.equal(claims.master_data_revision, 4);
  assert.deepEqual(claims.scopes, ["analyze", "review", "approve", "export"]);
});

test("reconstruction serializer exposes accounting summary without raw rows", () => {
  const run = {
    _id: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    workspace: new mongoose.Types.ObjectId(),
    conversionRun: new mongoose.Types.ObjectId(),
    fileName: "MUA_VAO.xlsx",
    fileSizeBytes: 2048,
    mode: "auto",
    status: "review_required",
    draftCount: 5,
    readyCount: 3,
    reviewCount: 2,
    blockedCount: 0,
    classificationSummary: { purchase_goods: 3, purchase_services: 2 },
    reconciliationSummary: { input_rows: 10, assigned_rows: 10 },
    creditChargedAt: new Date("2026-07-14T00:05:00Z"),
    createdAt: new Date("2026-07-14T00:00:00Z"),
  };

  const payload = serializeReconstructionRun(run);
  assert.equal(payload.id, String(run._id));
  assert.equal(payload.summary.draftCount, 5);
  assert.equal(payload.summary.review, 2);
  assert.equal(payload.creditChargedAt, run.creditChargedAt);
  assert.equal(payload.rawRows, undefined);
});

test("reconstruction quota accepts subscriptions and rejects depleted free users", () => {
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(
    hasConversionCredit({
      plan: { code: "free" },
      dailyFileCredit: 0,
      dailyFileCreditDate: today,
      fileCredits: 0,
    }),
    false,
  );
  assert.equal(
    hasConversionCredit({
      plan: { code: "perfile" },
      dailyFileCredit: 0,
      dailyFileCreditDate: today,
      fileCredits: 2,
    }),
    true,
  );
  assert.equal(
    hasConversionCredit({
      plan: { code: "monthly" },
      planExpiresAt: new Date(Date.now() + 86400000),
      dailyFileCredit: 0,
      dailyFileCreditDate: today,
      fileCredits: 0,
    }),
    true,
  );
});
