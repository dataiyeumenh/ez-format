const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  buildMigrationCandidate,
  ensureMappingProfileV2Indexes,
  migrateMappingProfilesV1ToV2,
  rollbackMappingProfilesV1ToV2,
} = require("../services/mappingProfileV2MigrationService");

const TEST_V2_INDEX_SPEC = Object.freeze({
  name: "ownerScope_1_profileFamilyId_1",
  keys: Object.freeze({ ownerScope: 1, profileFamilyId: 1 }),
  options: Object.freeze({
    name: "ownerScope_1_profileFamilyId_1",
    unique: true,
  }),
});

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

function transactionalDependencies() {
  const sessions = [];
  const audits = [];
  const connection = {
    async transaction(work) {
      const session = { transactionNumber: sessions.length + 1 };
      sessions.push(session);
      return work(session);
    },
  };
  const auditModel = {
    async updateOne(filter, patch, options) {
      assert.ok(options?.session);
      if (!audits.some((item) => item.runId === filter.runId)) {
        audits.push(structuredClone(patch.$setOnInsert));
      }
    },
  };
  return { connection, auditModel, audits, sessions };
}

function setPath(target, path, value) {
  const parts = path.split(".");
  const leaf = parts.pop();
  let cursor = target;
  for (const part of parts) cursor = cursor[part] ||= {};
  cursor[leaf] = value;
}

function unsetPath(target, path) {
  const parts = path.split(".");
  const leaf = parts.pop();
  let cursor = target;
  for (const part of parts) {
    cursor = cursor?.[part];
    if (!cursor) return;
  }
  delete cursor[leaf];
}

function applyPatch(target, patch) {
  for (const [path, value] of Object.entries(patch.$set || {})) setPath(target, path, value);
  for (const path of Object.keys(patch.$unset || {})) unsetPath(target, path);
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
  const tx = transactionalDependencies();
  const sourceModel = {
    find: async () => [risky],
    updateOne: async (filter, patch, options) => {
      assert.ok(options?.session);
      update = { filter, patch };
    },
  };

  const report = await migrateMappingProfilesV1ToV2({
    sourceModel,
    targetModel: {},
    mode: "apply",
    migrationId: "mapping-v1-v2-task-7",
    runId: "apply-quarantine-1",
    connection: tx.connection,
    auditModel: tx.auditModel,
  });

  assert.equal(report.quarantined, 1);
  assert.equal(report.quarantinePersisted, 1);
  assert.equal(String(update.filter._id), String(risky._id));
  assert.equal(update.patch.$set.status, "quarantined");
  assert.match(update.patch.$set.quarantineReason, /high_risk_legacy_profile/);
  assert.equal(update.patch.$set.mappingProfileV2Migration.migrationId, "mapping-v1-v2-task-7");
  assert.equal(update.patch.$set.mappingProfileV2Migration.appliedRunId, "apply-quarantine-1");
  assert.equal(tx.audits[0].operation, "apply");
});

test("apply migration is idempotent by legacy profile id", async () => {
  const document = legacy();
  let existing = false;
  let creates = 0;
  let syncs = 0;
  const tx = transactionalDependencies();
  const sourceModel = { find: async () => [document] };
  const targetModel = {
    exists: async ({ legacyProfileId }) => existing && legacyProfileId === String(document._id),
    async create([candidate], options) {
      assert.ok(options?.session);
      assert.equal(candidate.legacyProfileId, String(document._id));
      assert.equal(candidate.mappingProfileV2Migration.migrationId, "mapping-v1-v2-task-7");
      existing = true;
      creates += 1;
    },
    async syncIndexes() {
      syncs += 1;
    },
  };

  const first = await migrateMappingProfilesV1ToV2({
    sourceModel,
    targetModel,
    mode: "apply",
    migrationId: "mapping-v1-v2-task-7",
    runId: "apply-1",
    connection: tx.connection,
    auditModel: tx.auditModel,
  });
  const second = await migrateMappingProfilesV1ToV2({
    sourceModel,
    targetModel,
    mode: "apply",
    migrationId: "mapping-v1-v2-task-7",
    runId: "apply-2",
    connection: tx.connection,
    auditModel: tx.auditModel,
  });

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.skippedExisting, 1);
  assert.equal(creates, 1);
  assert.equal(syncs, 0);
  assert.equal(tx.sessions.length, 2);
  assert.deepEqual(tx.audits.map((item) => item.runId), ["apply-1", "apply-2"]);
});

test("rollback restores legacy quarantine and removes only its apply run", async () => {
  const priorQuarantineDate = new Date("2026-07-01T00:00:00.000Z");
  const migratable = legacy();
  const risky = legacy({
    defaults: { "Thuế suất GTGT": "10%" },
    status: "quarantined",
    quarantinedAt: priorQuarantineDate,
    quarantineReason: "manual-review",
  });
  const sourceDocuments = [migratable, risky];
  const targetDocuments = [
    {
      _id: id(),
      legacyProfileId: id(),
      mappingProfileV2Migration: {
        migrationId: "another-migration",
        appliedRunId: "another-run",
      },
    },
  ];
  const tx = transactionalDependencies();
  const sourceModel = {
    find(filter = {}) {
      const migrationId = filter["mappingProfileV2Migration.migrationId"];
      const appliedRunId = filter["mappingProfileV2Migration.appliedRunId"];
      if (!migrationId) return Promise.resolve(sourceDocuments);
      return Promise.resolve(sourceDocuments.filter((item) => (
        item.mappingProfileV2Migration?.migrationId === migrationId
        && item.mappingProfileV2Migration?.appliedRunId === appliedRunId
        && item.mappingProfileV2Migration?.state === "applied"
      )));
    },
    async updateOne(filter, patch, options) {
      assert.ok(options?.session);
      const document = sourceDocuments.find((item) => String(item._id) === String(filter._id));
      applyPatch(document, patch);
    },
  };
  const targetModel = {
    exists: async ({ legacyProfileId }) => targetDocuments.some(
      (item) => String(item.legacyProfileId) === String(legacyProfileId),
    ),
    async create([document], options) {
      assert.ok(options?.session);
      targetDocuments.push(structuredClone(document));
    },
    async deleteMany(filter, options) {
      assert.ok(options?.session);
      const before = targetDocuments.length;
      for (let index = targetDocuments.length - 1; index >= 0; index -= 1) {
        const marker = targetDocuments[index].mappingProfileV2Migration;
        if (
          marker?.migrationId === filter["mappingProfileV2Migration.migrationId"]
          && marker?.appliedRunId === filter["mappingProfileV2Migration.appliedRunId"]
        ) {
          targetDocuments.splice(index, 1);
        }
      }
      return { deletedCount: before - targetDocuments.length };
    },
  };

  const applied = await migrateMappingProfilesV1ToV2({
    sourceModel,
    targetModel,
    mode: "apply",
    migrationId: "mapping-v1-v2-task-7",
    runId: "apply-lifecycle-1",
    connection: tx.connection,
    auditModel: tx.auditModel,
  });
  const rolledBack = await rollbackMappingProfilesV1ToV2({
    sourceModel,
    targetModel,
    migrationId: "mapping-v1-v2-task-7",
    targetRunId: "apply-lifecycle-1",
    runId: "rollback-lifecycle-1",
    connection: tx.connection,
    auditModel: tx.auditModel,
  });

  assert.equal(applied.created, 1);
  assert.equal(rolledBack.removed, 1);
  assert.equal(rolledBack.quarantineRestored, 1);
  assert.equal(risky.status, "quarantined");
  assert.equal(risky.quarantinedAt.toISOString(), priorQuarantineDate.toISOString());
  assert.equal(risky.quarantineReason, "manual-review");
  assert.equal(risky.mappingProfileV2Migration.state, "rolled_back");
  assert.equal(targetDocuments.length, 1);
  assert.equal(targetDocuments[0].mappingProfileV2Migration.migrationId, "another-migration");
  assert.deepEqual(tx.audits.map((item) => item.operation), ["apply", "rollback"]);

  const reapplied = await migrateMappingProfilesV1ToV2({
    sourceModel,
    targetModel,
    mode: "apply",
    migrationId: "mapping-v1-v2-task-7",
    runId: "apply-lifecycle-2",
    connection: tx.connection,
    auditModel: tx.auditModel,
  });

  assert.equal(reapplied.created, 1);
  assert.equal(reapplied.quarantinePersisted, 1);
  assert.equal(targetDocuments.length, 2);
  assert.equal(
    targetDocuments[1].mappingProfileV2Migration.appliedRunId,
    "apply-lifecycle-2",
  );
  assert.equal(risky.mappingProfileV2Migration.appliedRunId, "apply-lifecycle-2");
});

test("rollback refuses to guess the apply run identity", async () => {
  let deleted = false;
  await assert.rejects(
    rollbackMappingProfilesV1ToV2({
      sourceModel: {},
      targetModel: { deleteMany: async () => { deleted = true; } },
      migrationId: "mapping-v1-v2-task-7",
      runId: "rollback-without-target",
      connection: transactionalDependencies().connection,
      auditModel: transactionalDependencies().auditModel,
    }),
    /targetRunId/,
  );
  assert.equal(deleted, false);
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

test("V2 index migration defaults to off and reports the pending index plan", async () => {
  let createIndexesCalls = 0;
  const model = {
    collection: {
      async indexes() {
        return [{ name: "_id_", key: { _id: 1 } }];
      },
    },
  };

  const result = await ensureMappingProfileV2Indexes({
    model,
    modelIndexSpecs: [TEST_V2_INDEX_SPEC],
    auditIndexSpecs: [],
  });

  assert.equal(result.mode, "off");
  assert.equal(result.skipped, true);
  assert.equal(createIndexesCalls, 0);
  assert.deepEqual(result.indexPlan.model.createIndexNames, [
    "ownerScope_1_profileFamilyId_1",
  ]);
});

test("V2 index dry-run performs zero index writes", async () => {
  let createIndexesCalls = 0;
  const model = {
    collection: {
      indexes: async () => [],
      async createIndex() {
        createIndexesCalls += 1;
      },
    },
  };

  const result = await ensureMappingProfileV2Indexes({
    model,
    mode: "dry-run",
    modelIndexSpecs: [TEST_V2_INDEX_SPEC],
    auditIndexSpecs: [],
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.skipped, false);
  assert.equal(createIndexesCalls, 0);
});

test("V2 indexes mutate only in exact apply mode and remain idempotent", async () => {
  let createIndexesCalls = 0;
  const existingIndexes = [];
  const model = {
    collection: {
      indexes: async () => existingIndexes,
      async createIndex(keys, options) {
        createIndexesCalls += 1;
        assert.deepEqual(keys, TEST_V2_INDEX_SPEC.keys);
        assert.deepEqual(options, TEST_V2_INDEX_SPEC.options);
        existingIndexes.push({
          name: options.name,
          key: keys,
          unique: options.unique,
        });
        return options.name;
      },
    },
  };

  const first = await ensureMappingProfileV2Indexes({
    model,
    mode: "apply",
    modelIndexSpecs: [TEST_V2_INDEX_SPEC],
    auditIndexSpecs: [],
  });
  const second = await ensureMappingProfileV2Indexes({
    model,
    mode: "apply",
    modelIndexSpecs: [TEST_V2_INDEX_SPEC],
    auditIndexSpecs: [],
  });

  assert.equal(createIndexesCalls, 1);
  assert.deepEqual(first.indexes, ["ownerScope_1_profileFamilyId_1"]);
  assert.deepEqual(second.indexes, []);
});

test("V2 index apply fails closed on non-IndexNotFound errors", async () => {
  const model = {
    collection: {
      indexes: async () => [],
      async createIndex() {
        const error = new Error("index create denied");
        error.code = 13;
        throw error;
      },
    },
  };

  await assert.rejects(
    ensureMappingProfileV2Indexes({
      model,
      mode: "apply",
      modelIndexSpecs: [TEST_V2_INDEX_SPEC],
      auditIndexSpecs: [],
    }),
    /index create denied/,
  );
});

test("V2 index preflight reports conflicting key specs without scheduling a create", async () => {
  const model = {
    collection: {
      async indexes() {
        return [{
          name: "legacy_owner_family_lookup",
          key: TEST_V2_INDEX_SPEC.keys,
          unique: false,
        }];
      },
    },
  };

  const report = await ensureMappingProfileV2Indexes({
    model,
    mode: "dry-run",
    modelIndexSpecs: [TEST_V2_INDEX_SPEC],
    auditIndexSpecs: [],
  });

  assert.deepEqual(
    report.indexPlan.model.incompatibleIndexNames,
    ["legacy_owner_family_lookup"],
  );
  assert.deepEqual(report.indexPlan.model.createIndexes, []);
});

test("V2 index apply leaves unmanaged and unrelated schema indexes untouched", async () => {
  const writes = [];
  const model = {
    schema: {
      indexes() {
        return [
          [TEST_V2_INDEX_SPEC.keys, TEST_V2_INDEX_SPEC.options],
          [{ experimentalLookup: 1 }, {}],
        ];
      },
    },
    collection: {
      async indexes() {
        return [
          { name: "_id_", key: { _id: 1 } },
          { name: "ops_manual_lookup", key: { updatedAt: -1 } },
        ];
      },
      async createIndex(keys, options) {
        writes.push(["createIndex", keys, options]);
        return options.name;
      },
      async dropIndex(name) {
        writes.push(["dropIndex", name]);
      },
    },
    async createIndexes() {
      writes.push(["createIndexes"]);
    },
    async syncIndexes() {
      writes.push(["syncIndexes"]);
    },
  };

  const report = await ensureMappingProfileV2Indexes({
    model,
    mode: "apply",
    modelIndexSpecs: [TEST_V2_INDEX_SPEC],
    auditIndexSpecs: [],
  });

  assert.deepEqual(report.indexPlan.model.createIndexes, [TEST_V2_INDEX_SPEC]);
  assert.deepEqual(writes, [[
    "createIndex",
    TEST_V2_INDEX_SPEC.keys,
    TEST_V2_INDEX_SPEC.options,
  ]]);
});
