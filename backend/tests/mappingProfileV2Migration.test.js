const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  buildMigrationCandidate,
  ensureMappingProfileV2Indexes,
  migrateMappingProfilesV1ToV2,
} = require("../services/mappingProfileV2MigrationService");

function id() {
  return new mongoose.Types.ObjectId().toString();
}

function legacy(overrides = {}) {
  const workspace = id();
  return {
    _id: id(),
    ownerScope: `workspace:${workspace}`,
    workspace,
    user: id(),
    updatedBy: id(),
    name: "Legacy purchase",
    targetTemplateId: "misa_purchase_domestic",
    sourceSignatureHash: "legacy-signature",
    sourceHeaders: ["Số hóa đơn", "Ngày hóa đơn"],
    mapping: { "Số hóa đơn": "Số chứng từ (*)" },
    defaults: {},
    formulas: {},
    ...overrides,
  };
}

test("migration candidate is a review-only V2 draft without mutating V1", () => {
  const source = legacy();
  const snapshot = structuredClone(source);
  const result = buildMigrationCandidate(source);

  assert.equal(result.action, "migrate");
  assert.equal(result.document.status, "draft");
  assert.equal(result.document.legacyProfileId, String(source._id));
  assert.equal(result.document.dataShapeFingerprint, "legacy:missing");
  assert.equal(result.document.targetTemplateVersion, "legacy:unknown");
  assert.deepEqual(source, snapshot);
});

test("migration quarantines invalid and high-risk legacy profiles", () => {
  const invalid = buildMigrationCandidate(legacy({ ownerScope: "workspace:bad" }));
  const risky = buildMigrationCandidate(
    legacy({ defaults: { "Thuế suất GTGT": "10%" } }),
  );

  assert.equal(invalid.action, "quarantine");
  assert.ok(invalid.reasons.includes("invalid_owner_scope"));
  assert.equal(risky.action, "quarantine");
  assert.ok(risky.reasons.includes("high_risk_legacy_profile"));
});

test("dry-run reports work but writes nothing", async () => {
  const documents = [legacy(), legacy({ ownerScope: "workspace:bad" })];
  let creates = 0;
  const sourceModel = { find: async () => documents };
  const targetModel = {
    exists: async () => false,
    create: async () => { creates += 1; },
  };

  const report = await migrateMappingProfilesV1ToV2({
    sourceModel,
    targetModel,
    mode: "dry-run",
  });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.planned, 1);
  assert.equal(report.quarantined, 1);
  assert.equal(report.created, 0);
  assert.equal(creates, 0);
});

test("apply persists quarantine on the legacy profile", async () => {
  const risky = legacy({ defaults: { "Thuế suất GTGT": "10%" } });
  let update;
  const sourceModel = {
    find: async () => [risky],
    updateOne: async (filter, patch) => { update = { filter, patch }; },
  };

  const report = await migrateMappingProfilesV1ToV2({
    sourceModel,
    targetModel: {},
    mode: "apply",
  });

  assert.equal(report.quarantined, 1);
  assert.equal(report.quarantinePersisted, 1);
  assert.equal(String(update.filter._id), String(risky._id));
  assert.equal(update.patch.$set.status, "quarantined");
  assert.match(update.patch.$set.quarantineReason, /high_risk_legacy_profile/);
});

test("apply migration is idempotent by legacy profile id", async () => {
  const document = legacy();
  let existing = false;
  let creates = 0;
  let syncs = 0;
  const sourceModel = { find: async () => [document] };
  const targetModel = {
    exists: async ({ legacyProfileId }) => existing && legacyProfileId === String(document._id),
    async create(candidate) {
      assert.equal(candidate.legacyProfileId, String(document._id));
      existing = true;
      creates += 1;
    },
    async syncIndexes() {
      syncs += 1;
    },
  };

  const first = await migrateMappingProfilesV1ToV2({ sourceModel, targetModel, mode: "apply" });
  const second = await migrateMappingProfilesV1ToV2({ sourceModel, targetModel, mode: "apply" });

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.skippedExisting, 1);
  assert.equal(creates, 1);
  assert.equal(syncs, 0);
});

test("migration stays disabled unless explicitly selected", async () => {
  let queried = false;
  const report = await migrateMappingProfilesV1ToV2({
    sourceModel: { find: async () => { queried = true; return []; } },
    targetModel: {},
    mode: "off",
  });
  assert.equal(report.skipped, true);
  assert.equal(queried, false);
});

test("V2 indexes are created independently from the data migration mode", async () => {
  let createIndexesCalls = 0;
  const model = {
    async createIndexes() {
      createIndexesCalls += 1;
      return ["ownerScope_1_profileFamilyId_1"];
    },
  };

  const result = await ensureMappingProfileV2Indexes({ model });
  const migration = await migrateMappingProfilesV1ToV2({
    sourceModel: { find: async () => { throw new Error("must not read V1"); } },
    targetModel: model,
    mode: "off",
  });

  assert.equal(createIndexesCalls, 1);
  assert.deepEqual(result.indexes, ["ownerScope_1_profileFamilyId_1"]);
  assert.equal(migration.skipped, true);
});
