const MappingProfile = require("../models/MappingProfile");

const OBSOLETE_WORKSPACE_UNIQUE_INDEX =
  "workspace_1_targetTemplateId_1_sourceSignatureHash_1";
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
  return {
    dropIndexNames: indexes
      .filter((index) => index?.name === OBSOLETE_WORKSPACE_UNIQUE_INDEX)
      .map((index) => index.name),
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

async function migrateMappingProfileOwnerScope({ model = MappingProfile } = {}) {
  if (model.db?.readyState !== 1) {
    return { skipped: true, backfilled: 0, droppedIndexes: [] };
  }

  const legacyProfiles = await model
    .find(LEGACY_OWNER_SCOPE_FILTER)
    .select("_id workspace updatedBy")
    .lean();
  const operations = legacyProfiles.map(buildLegacyOwnerScopeUpdate);
  if (operations.length) {
    await model.bulkWrite(operations, { ordered: true });
  }

  const indexes = await existingMappingProfileIndexes(model);
  const plan = planMappingProfileIndexMigration(indexes);
  for (const indexName of plan.dropIndexNames) {
    try {
      await model.collection.dropIndex(indexName);
    } catch (error) {
      if (!isIndexNotFound(error)) throw error;
    }
  }
  await model.syncIndexes();

  return {
    skipped: false,
    backfilled: operations.length,
    droppedIndexes: plan.dropIndexNames,
  };
}

module.exports = {
  LEGACY_OWNER_SCOPE_FILTER,
  OBSOLETE_WORKSPACE_UNIQUE_INDEX,
  buildLegacyOwnerScopeUpdate,
  migrateMappingProfileOwnerScope,
  planMappingProfileIndexMigration,
};
