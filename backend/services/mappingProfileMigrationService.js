const MappingProfile = require("../models/MappingProfile");

const OBSOLETE_WORKSPACE_UNIQUE_INDEX =
  "workspace_1_targetTemplateId_1_sourceSignatureHash_1";
const OWNER_SCOPE_UNIQUE_INDEX =
  "ownerScope_1_targetTemplateId_1_sourceSignatureHash_1";
const OWNER_SCOPE_UNIQUE_INDEX_KEYS = Object.freeze({
  ownerScope: 1,
  targetTemplateId: 1,
  sourceSignatureHash: 1,
});
const OWNER_SCOPE_UNIQUE_INDEX_SPEC = Object.freeze({
  name: OWNER_SCOPE_UNIQUE_INDEX,
  keys: OWNER_SCOPE_UNIQUE_INDEX_KEYS,
  options: Object.freeze({ name: OWNER_SCOPE_UNIQUE_INDEX, unique: true }),
});
const OWNER_SCOPE_MIGRATION_MODES = new Set(["off", "dry-run", "apply"]);
const LEGACY_OWNER_SCOPE_FILTER = {
  $or: [
    { ownerScope: { $exists: false } },
    { ownerScope: null },
    { ownerScope: "" },
  ],
};

function normalizedId(value) {
  if (value == null) return "";
  return String(value?._id || value).trim();
}

function buildLegacyOwnerScopeUpdate(profile = {}) {
  const profileId = normalizedId(profile._id);
  const workspaceId = normalizedId(profile.workspace);
  const updatedBy = normalizedId(profile.updatedBy);
  if (!profileId) throw new Error("Legacy mapping profile id is required");
  if (!workspaceId && !updatedBy) {
    throw new Error(
      `Legacy mapping profile ${profileId} has no workspace or updatedBy`,
    );
  }
  return {
    updateOne: {
      filter: { _id: profile._id, ...LEGACY_OWNER_SCOPE_FILTER },
      update: {
        $set: {
          ownerScope: workspaceId
            ? `workspace:${workspaceId}`
            : `user:${updatedBy}`,
        },
      },
    },
  };
}

function planMappingProfileIndexMigration(indexes = []) {
  const sameKeys = (index) => JSON.stringify(index?.key || {})
    === JSON.stringify(OWNER_SCOPE_UNIQUE_INDEX_KEYS);
  const compatibleIndex = indexes.some(
    (index) => sameKeys(index) && index?.unique === true,
  );
  const incompatibleIndexNames = indexes
    .filter((index) => (
      index?.name === OWNER_SCOPE_UNIQUE_INDEX || sameKeys(index)
    ) && !(sameKeys(index) && index?.unique === true))
    .map((index) => index.name)
    .filter(Boolean);

  return {
    dropIndexNames: indexes
      .filter((index) => index?.name === OBSOLETE_WORKSPACE_UNIQUE_INDEX)
      .map((index) => index.name),
    createIndexes: compatibleIndex || incompatibleIndexNames.length
      ? []
      : [OWNER_SCOPE_UNIQUE_INDEX_SPEC],
    incompatibleIndexNames,
  };
}

async function existingMappingProfileIndexes(model) {
  try {
    return await model.collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
      return [];
    }
    throw error;
  }
}

function isIndexNotFound(error) {
  return error?.code === 27 || error?.codeName === "IndexNotFound";
}

async function migrateMappingProfileOwnerScope({
  model = MappingProfile,
  mode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
} = {}) {
  const normalizedMode = String(mode || "off").trim().toLowerCase();
  if (!OWNER_SCOPE_MIGRATION_MODES.has(normalizedMode)) {
    throw new Error(
      "MappingProfile owner migration mode must be off, dry-run, or apply",
    );
  }
  const report = {
    mode: normalizedMode,
    skipped: normalizedMode === "off",
    plannedBackfills: 0,
    backfilled: 0,
    indexPlan: {
      dropIndexNames: [],
      createIndexes: [],
      incompatibleIndexNames: [],
    },
    droppedIndexes: [],
    createdIndexes: [],
  };
  if (normalizedMode === "off") return report;
  if (model.db?.readyState !== 1) {
    return { ...report, skipped: true };
  }

  const legacyProfiles = await model
    .find(LEGACY_OWNER_SCOPE_FILTER)
    .select("_id workspace updatedBy")
    .lean();
  const operations = legacyProfiles.map(buildLegacyOwnerScopeUpdate);
  const indexes = await existingMappingProfileIndexes(model);
  const plan = planMappingProfileIndexMigration(indexes);
  report.plannedBackfills = operations.length;
  report.indexPlan = plan;
  if (normalizedMode === "dry-run") return report;
  if (plan.incompatibleIndexNames.length) {
    throw new Error(
      `MappingProfile index compatibility check failed: ${plan.incompatibleIndexNames.join(", ")}`,
    );
  }

  if (operations.length) {
    await model.bulkWrite(operations, { ordered: true });
  }

  for (const indexName of plan.dropIndexNames) {
    try {
      await model.collection.dropIndex(indexName);
    } catch (error) {
      if (!isIndexNotFound(error)) throw error;
    }
  }
  for (const index of plan.createIndexes) {
    await model.collection.createIndex(index.keys, index.options);
  }

  report.backfilled = operations.length;
  report.droppedIndexes = plan.dropIndexNames;
  report.createdIndexes = plan.createIndexes.map((index) => index.name);
  return report;
}

module.exports = {
  LEGACY_OWNER_SCOPE_FILTER,
  OWNER_SCOPE_UNIQUE_INDEX,
  OWNER_SCOPE_UNIQUE_INDEX_KEYS,
  OBSOLETE_WORKSPACE_UNIQUE_INDEX,
  buildLegacyOwnerScopeUpdate,
  migrateMappingProfileOwnerScope,
  planMappingProfileIndexMigration,
};
