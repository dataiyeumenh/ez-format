const crypto = require("crypto");
const mongoose = require("mongoose");
const MappingProfile = require("../models/MappingProfile");
const MappingProfileV2 = require("../models/MappingProfileV2");
const MappingProfileV2MigrationAudit = require("../models/MappingProfileV2MigrationAudit");
const {
  indexMatchesContract,
  sameIndexKeys,
} = require("./mongoIndexContract");
const {
  buildProfileKey,
  buildStateHash,
  detectRiskFlags,
} = require("./mappingProfileV2Service");

const MIGRATION_MODES = new Set(["off", "dry-run", "apply", "rollback"]);
const OWNER_SCOPE_PATTERN = /^(workspace|user):[a-f\d]{24}$/i;
const MIGRATION_KIND = "mapping_profile_v1_to_v2";

function normalizedId(value) {
  if (value == null) return "";
  return String(value?._id || value).trim();
}

function inferLegacyDocumentType(targetTemplateId) {
  const value = String(targetTemplateId || "").toLowerCase();
  const direction = /purchase|mua/.test(value) ? "purchase" : /sales|ban/.test(value) ? "sales" : "unknown";
  const nature = /service|dich/.test(value) ? "services" : /goods|hang|bsn/.test(value) ? "goods" : "unknown";
  return `${direction}_${nature}`;
}

function buildMigrationCandidate(profile = {}) {
  const legacyProfileId = normalizedId(profile._id);
  const ownerScope = String(profile.ownerScope || "").trim();
  const targetTemplateId = String(profile.targetTemplateId || "").trim();
  const sourceSignatureHash = String(profile.sourceSignatureHash || "").trim();
  const userId = normalizedId(profile.user || profile.updatedBy);
  const workspaceId = normalizedId(profile.workspace);
  const reasons = [];

  if (!mongoose.isValidObjectId(legacyProfileId)) reasons.push("invalid_legacy_id");
  if (!OWNER_SCOPE_PATTERN.test(ownerScope)) reasons.push("invalid_owner_scope");
  if (!targetTemplateId) reasons.push("missing_target_template");
  if (!sourceSignatureHash) reasons.push("missing_source_signature");
  if (!mongoose.isValidObjectId(userId)) reasons.push("missing_profile_user");
  if (
    ownerScope.startsWith("workspace:") &&
    (!mongoose.isValidObjectId(workspaceId) || ownerScope !== `workspace:${workspaceId}`)
  ) {
    reasons.push("workspace_owner_mismatch");
  }
  if (ownerScope.startsWith("user:") && ownerScope !== `user:${userId}`) {
    reasons.push("user_owner_mismatch");
  }

  const mapping = profile.mapping && typeof profile.mapping === "object" ? profile.mapping : {};
  const defaults = profile.defaults && typeof profile.defaults === "object" ? profile.defaults : {};
  const formulas = profile.formulas && typeof profile.formulas === "object" ? profile.formulas : {};
  const riskFlags = detectRiskFlags({ mapping, defaults, formulas });
  if (riskFlags.length) reasons.push("high_risk_legacy_profile");

  if (reasons.length) {
    return {
      action: "quarantine",
      legacyProfileId,
      ownerScope,
      reasons: [...new Set(reasons)],
      riskFlags,
    };
  }

  const document = {
    ownerScope,
    workspace: workspaceId || null,
    user: userId,
    profileFamilyId: crypto.randomUUID(),
    version: 1,
    status: "draft",
    name: String(profile.name || "Mapping profile V1 migrated")
      .trim()
      .slice(0, 160),
    sourceFamily: `legacy:${sourceSignatureHash}`.slice(0, 160),
    documentType: inferLegacyDocumentType(targetTemplateId),
    headerFingerprint: sourceSignatureHash.slice(0, 128),
    dataShapeFingerprint: "legacy:missing",
    targetTemplateId: targetTemplateId.slice(0, 120),
    targetTemplateVersion: "legacy:unknown",
    mapping,
    defaults,
    formulas,
    riskFlags: [],
    confirmationCount: 0,
    createdBy: userId,
    legacyProfileId,
  };
  document.profileKey = buildProfileKey(document);
  document.stateHash = buildStateHash(document);
  return { action: "migrate", legacyProfileId, document };
}

async function resolveQuery(query, session = null) {
  let current = query;
  if (session && typeof current?.session === "function") current = current.session(session);
  if (typeof current?.lean === "function") current = current.lean();
  return current;
}

async function readLegacyProfiles(sourceModel, filter = {}, session = null) {
  return resolveQuery(sourceModel.find(filter), session);
}

function migrationIdentity(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} là bắt buộc cho migration write`);
  if (normalized.length > 160) throw new Error(`${field} không được vượt quá 160 ký tự`);
  return normalized;
}

function emptyReport(mode, { migrationId = null, runId = null, targetRunId = null } = {}) {
  return {
    mode,
    migrationId,
    runId,
    targetRunId,
    skipped: mode === "off",
    scanned: 0,
    planned: 0,
    created: 0,
    skippedExisting: 0,
    quarantined: 0,
    quarantinePersisted: 0,
    quarantineRestored: 0,
    removed: 0,
    auditPersisted: false,
    quarantine: [],
  };
}

function snapshotLegacyQuarantine(profile) {
  const snapshot = {};
  for (const field of ["status", "quarantinedAt", "quarantineReason"]) {
    snapshot[field] = {
      present: Object.prototype.hasOwnProperty.call(profile, field),
      value: profile[field] ?? null,
    };
  }
  return snapshot;
}

function rollbackPatch(marker, { runId, rolledBackAt }) {
  const patch = { $set: {}, $unset: {} };
  for (const [field, snapshot] of Object.entries(marker.previousQuarantineState || {})) {
    if (snapshot?.present) patch.$set[field] = snapshot.value;
    else patch.$unset[field] = "";
  }
  patch.$set.mappingProfileV2Migration = {
    ...marker,
    state: "rolled_back",
    rolledBackAt,
    rolledBackByRunId: runId,
  };
  if (!Object.keys(patch.$unset).length) delete patch.$unset;
  return patch;
}

function auditReport(report) {
  const {
    mode,
    migrationId,
    runId,
    targetRunId,
    scanned,
    planned,
    created,
    skippedExisting,
    quarantined,
    quarantinePersisted,
    quarantineRestored,
    removed,
  } = report;
  return {
    mode,
    migrationId,
    runId,
    targetRunId,
    scanned,
    planned,
    created,
    skippedExisting,
    quarantined,
    quarantinePersisted,
    quarantineRestored,
    removed,
  };
}

async function assertAuditIdentity(auditModel, identity, session) {
  if (typeof auditModel.findOne !== "function") return;
  const existing = await resolveQuery(auditModel.findOne({ runId: identity.runId }), session);
  if (
    existing
    && (
      existing.migrationId !== identity.migrationId
      || existing.operation !== identity.operation
      || (existing.targetRunId || null) !== (identity.targetRunId || null)
    )
  ) {
    throw new Error(`runId ${identity.runId} đã thuộc migration operation khác`);
  }
}

async function recordAudit(auditModel, report, operation, session) {
  const identity = {
    migrationId: report.migrationId,
    runId: report.runId,
    operation,
    targetRunId: report.targetRunId,
  };
  await assertAuditIdentity(auditModel, identity, session);
  await auditModel.updateOne(
    { runId: report.runId },
    {
      $setOnInsert: {
        ...identity,
        status: "completed",
        report: auditReport(report),
      },
    },
    { upsert: true, session },
  );
  report.auditPersisted = true;
}

async function runTransaction(connection, work) {
  if (typeof connection?.transaction !== "function") {
    throw new Error("Mongo transaction connection là bắt buộc cho migration write");
  }
  return connection.transaction(work);
}

async function targetExists(targetModel, filter, session) {
  return Boolean(await resolveQuery(targetModel.exists(filter), session));
}

async function applyMappingProfilesV1ToV2({
  sourceModel,
  targetModel,
  auditModel,
  connection,
  migrationId,
  runId,
}) {
  const identity = {
    migrationId: migrationIdentity(migrationId, "migrationId"),
    runId: migrationIdentity(runId, "runId"),
  };
  const report = emptyReport("apply", identity);
  await runTransaction(connection, async (session) => {
    const profiles = await readLegacyProfiles(sourceModel, {}, session);
    report.scanned = profiles.length;
    for (const profile of profiles) {
      const candidate = buildMigrationCandidate(profile);
      if (candidate.action === "quarantine") {
        report.quarantined += 1;
        report.quarantine.push({
          legacyProfileId: candidate.legacyProfileId,
          ownerScope: candidate.ownerScope,
          reasons: candidate.reasons,
          riskFlags: candidate.riskFlags,
        });
        if (!mongoose.isValidObjectId(candidate.legacyProfileId)) continue;
        const existingMarker = profile.mappingProfileV2Migration;
        if (
          existingMarker?.kind === MIGRATION_KIND
          && existingMarker?.migrationId === identity.migrationId
          && existingMarker?.state === "applied"
        ) {
          report.skippedExisting += 1;
          continue;
        }
        if (typeof sourceModel.updateOne !== "function") {
          throw new Error("Legacy mapping profile model không hỗ trợ quarantine persistence");
        }
        const appliedAt = new Date();
        await sourceModel.updateOne(
          { _id: profile._id },
          {
            $set: {
              status: "quarantined",
              quarantinedAt: appliedAt,
              quarantineReason: candidate.reasons.join(","),
              mappingProfileV2Migration: {
                kind: MIGRATION_KIND,
                migrationId: identity.migrationId,
                appliedRunId: identity.runId,
                state: "applied",
                appliedAt,
                previousQuarantineState: snapshotLegacyQuarantine(profile),
              },
            },
          },
          { session },
        );
        report.quarantinePersisted += 1;
        continue;
      }

      if (await targetExists(targetModel, { legacyProfileId: candidate.legacyProfileId }, session)) {
        report.skippedExisting += 1;
        continue;
      }
      report.planned += 1;
      candidate.document.mappingProfileV2Migration = {
        kind: MIGRATION_KIND,
        migrationId: identity.migrationId,
        appliedRunId: identity.runId,
        appliedAt: new Date(),
      };
      await targetModel.create([candidate.document], { session });
      report.created += 1;
    }
    await recordAudit(auditModel, report, "apply", session);
  });
  return report;
}

async function migrateMappingProfilesV1ToV2({
  sourceModel = MappingProfile,
  targetModel = MappingProfileV2,
  auditModel = MappingProfileV2MigrationAudit,
  connection = mongoose.connection,
  mode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
  migrationId = process.env.MAPPING_PROFILE_V2_MIGRATION_ID,
  runId = process.env.MAPPING_PROFILE_V2_MIGRATION_RUN_ID,
  targetRunId = process.env.MAPPING_PROFILE_V2_MIGRATION_TARGET_RUN_ID,
} = {}) {
  const normalizedMode = String(mode || "off").trim().toLowerCase();
  if (!MIGRATION_MODES.has(normalizedMode)) {
    throw new Error(
      "MAPPING_PROFILE_V2_MIGRATION_MODE phải là off, dry-run, apply hoặc rollback",
    );
  }
  const report = emptyReport(normalizedMode, { migrationId, runId, targetRunId });
  if (normalizedMode === "off") return report;
  if (normalizedMode === "rollback") {
    return rollbackMappingProfilesV1ToV2({
      sourceModel,
      targetModel,
      auditModel,
      connection,
      migrationId,
      runId,
      targetRunId,
    });
  }
  if (normalizedMode === "apply") {
    return applyMappingProfilesV1ToV2({
      sourceModel,
      targetModel,
      auditModel,
      connection,
      migrationId,
      runId,
    });
  }

  const profiles = await readLegacyProfiles(sourceModel);
  report.scanned = profiles.length;
  for (const profile of profiles) {
    const candidate = buildMigrationCandidate(profile);
    if (candidate.action === "quarantine") {
      report.quarantined += 1;
      report.quarantine.push({
        legacyProfileId: candidate.legacyProfileId,
        ownerScope: candidate.ownerScope,
        reasons: candidate.reasons,
        riskFlags: candidate.riskFlags,
      });
      continue;
    }
    const exists = await targetModel.exists({
      legacyProfileId: candidate.legacyProfileId,
    });
    if (exists) {
      report.skippedExisting += 1;
      continue;
    }
    report.planned += 1;
    if (normalizedMode === "dry-run") continue;
  }
  return report;
}

async function rollbackMappingProfilesV1ToV2({
  sourceModel = MappingProfile,
  targetModel = MappingProfileV2,
  auditModel = MappingProfileV2MigrationAudit,
  connection = mongoose.connection,
  migrationId,
  targetRunId,
  runId,
} = {}) {
  const identity = {
    migrationId: migrationIdentity(migrationId, "migrationId"),
    targetRunId: migrationIdentity(targetRunId, "targetRunId"),
    runId: migrationIdentity(runId, "runId"),
  };
  const report = emptyReport("rollback", identity);
  await runTransaction(connection, async (session) => {
    if (typeof targetModel.deleteMany !== "function") {
      throw new Error("MappingProfileV2 model không hỗ trợ rollback deleteMany");
    }
    const migrationFilter = {
      "mappingProfileV2Migration.kind": MIGRATION_KIND,
      "mappingProfileV2Migration.migrationId": identity.migrationId,
      "mappingProfileV2Migration.appliedRunId": identity.targetRunId,
    };
    const deletion = await targetModel.deleteMany(migrationFilter, { session });
    report.removed = Number(deletion?.deletedCount || 0);

    const quarantinedProfiles = await readLegacyProfiles(
      sourceModel,
      {
        ...migrationFilter,
        "mappingProfileV2Migration.state": "applied",
      },
      session,
    );
    report.scanned = quarantinedProfiles.length;
    for (const profile of quarantinedProfiles) {
      await sourceModel.updateOne(
        { _id: profile._id, ...migrationFilter, "mappingProfileV2Migration.state": "applied" },
        rollbackPatch(profile.mappingProfileV2Migration, {
          runId: identity.runId,
          rolledBackAt: new Date(),
        }),
        { session },
      );
      report.quarantineRestored += 1;
    }
    await recordAudit(auditModel, report, "rollback", session);
  });
  return report;
}

function derivedIndexName(keys = {}, options = {}) {
  if (options.name) return options.name;
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

function explicitIndexSpec(keys, options = {}) {
  const name = derivedIndexName(keys, options);
  return Object.freeze({
    name,
    keys: Object.freeze({ ...keys }),
    options: Object.freeze({ ...options, name }),
  });
}

const MAPPING_PROFILE_V2_INDEX_SPECS = Object.freeze([
  explicitIndexSpec({ ownerScope: 1 }),
  explicitIndexSpec({ workspace: 1 }),
  explicitIndexSpec({ user: 1 }),
  explicitIndexSpec({ status: 1 }),
  explicitIndexSpec(
    { ownerScope: 1, profileFamilyId: 1, version: 1 },
    { unique: true },
  ),
  explicitIndexSpec(
    { ownerScope: 1, profileFamilyId: 1 },
    { unique: true, partialFilterExpression: { status: "active" } },
  ),
  explicitIndexSpec(
    { legacyProfileId: 1 },
    {
      unique: true,
      partialFilterExpression: { legacyProfileId: { $type: "objectId" } },
    },
  ),
  explicitIndexSpec({ ownerScope: 1, status: 1, updatedAt: -1 }),
  explicitIndexSpec({
    "mappingProfileV2Migration.migrationId": 1,
    "mappingProfileV2Migration.appliedRunId": 1,
  }),
]);
const MAPPING_PROFILE_V2_AUDIT_INDEX_SPECS = Object.freeze([
  explicitIndexSpec({ runId: 1 }, { unique: true }),
  explicitIndexSpec({ migrationId: 1, createdAt: -1 }),
]);

async function existingIndexes(model) {
  if (typeof model?.collection?.indexes !== "function") return [];
  try {
    return await model.collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

async function planModelIndexes(model, desired = []) {
  const existing = await existingIndexes(model);
  const conflictsBySpec = new Map(desired.map((spec) => [
    spec.name,
    existing.filter((current) => (
      current.name === spec.name
      || sameIndexKeys(current.key, spec.keys)
    ) && !indexMatchesContract(current, spec)),
  ]));
  const incompatibleIndexNames = [...conflictsBySpec.values()]
    .flatMap((conflicts) => conflicts.map((index) => index.name).filter(Boolean))
    .filter((name, index, names) => names.indexOf(name) === index);
  const createIndexes = desired.filter((spec) => (
    !existing.some((current) => indexMatchesContract(current, spec))
    && conflictsBySpec.get(spec.name).length === 0
  ));

  return {
    existingIndexNames: existing.map((index) => index.name).filter(Boolean),
    desiredIndexNames: desired.map((spec) => spec.name),
    createIndexNames: createIndexes.map((spec) => spec.name),
    createIndexes,
    incompatibleIndexNames,
  };
}

async function planMappingProfileV2Indexes({
  model = MappingProfileV2,
  auditModel = model === MappingProfileV2 ? MappingProfileV2MigrationAudit : null,
  modelIndexSpecs = MAPPING_PROFILE_V2_INDEX_SPECS,
  auditIndexSpecs = MAPPING_PROFILE_V2_AUDIT_INDEX_SPECS,
} = {}) {
  return {
    model: await planModelIndexes(model, modelIndexSpecs),
    audit: auditModel
      ? await planModelIndexes(auditModel, auditIndexSpecs)
      : {
        existingIndexNames: [],
        desiredIndexNames: [],
        createIndexNames: [],
        createIndexes: [],
        incompatibleIndexNames: [],
      },
  };
}

async function ensureMappingProfileV2Indexes({
  model = MappingProfileV2,
  auditModel = model === MappingProfileV2 ? MappingProfileV2MigrationAudit : null,
  mode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
  modelIndexSpecs = MAPPING_PROFILE_V2_INDEX_SPECS,
  auditIndexSpecs = MAPPING_PROFILE_V2_AUDIT_INDEX_SPECS,
} = {}) {
  const normalizedMode = String(mode || "off").trim().toLowerCase();
  if (!MIGRATION_MODES.has(normalizedMode)) {
    throw new Error(
      "MAPPING_PROFILE_V2_MIGRATION_MODE phải là off, dry-run, apply hoặc rollback",
    );
  }
  const indexPlan = await planMappingProfileV2Indexes({
    model,
    auditModel,
    modelIndexSpecs,
    auditIndexSpecs,
  });
  const report = {
    mode: normalizedMode,
    skipped: normalizedMode === "off" || normalizedMode === "rollback",
    indexPlan,
    indexes: [],
    auditIndexes: [],
  };
  if (normalizedMode !== "apply") return report;

  const incompatible = [
    ...indexPlan.model.incompatibleIndexNames,
    ...indexPlan.audit.incompatibleIndexNames,
  ];
  if (incompatible.length) {
    throw new Error(
      `MappingProfile V2 index compatibility check failed: ${incompatible.join(", ")}`,
    );
  }
  if (
    indexPlan.model.createIndexes.length
    && typeof model?.collection?.createIndex !== "function"
  ) {
    throw new Error("MappingProfileV2 collection không hỗ trợ createIndex");
  }
  if (
    indexPlan.audit.createIndexes.length
    && typeof auditModel?.collection?.createIndex !== "function"
  ) {
    throw new Error("MappingProfileV2 audit collection không hỗ trợ createIndex");
  }
  for (const index of indexPlan.model.createIndexes) {
    await model.collection.createIndex(index.keys, index.options);
    report.indexes.push(index.name);
  }
  for (const index of indexPlan.audit.createIndexes) {
    await auditModel.collection.createIndex(index.keys, index.options);
    report.auditIndexes.push(index.name);
  }
  return report;
}

module.exports = {
  MIGRATION_MODES,
  MAPPING_PROFILE_V2_AUDIT_INDEX_SPECS,
  MAPPING_PROFILE_V2_INDEX_SPECS,
  buildMigrationCandidate,
  ensureMappingProfileV2Indexes,
  inferLegacyDocumentType,
  migrateMappingProfilesV1ToV2,
  planMappingProfileV2Indexes,
  rollbackMappingProfilesV1ToV2,
};
