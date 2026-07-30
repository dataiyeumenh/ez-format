const path = require("node:path");
const mongoose = require("mongoose");

const MappingProfile = require("../models/MappingProfile");
const MappingProfileV2 = require("../models/MappingProfileV2");
const MappingProfileV2MigrationAudit = require("../models/MappingProfileV2MigrationAudit");
const {
  migrateMappingProfileOwnerScope,
} = require("../services/mappingProfileMigrationService");
const {
  ensureMappingProfileV2Indexes,
  migrateMappingProfilesV1ToV2,
} = require("../services/mappingProfileV2MigrationService");

const MODES = new Set(["off", "dry-run", "apply", "rollback"]);
const V2_COUNT_FIELDS = [
  "scanned",
  "planned",
  "created",
  "skippedExisting",
  "quarantined",
  "quarantinePersisted",
  "quarantineRestored",
  "removed",
];

function normalizeMode(mode) {
  const normalized = String(mode || "off").trim().toLowerCase();
  if (!MODES.has(normalized)) {
    throw new Error("Migration mode must be off, dry-run, apply, or rollback");
  }
  return normalized;
}

function v2Counts(report = {}) {
  return Object.fromEntries([
    ["mode", report.mode],
    ["skipped", Boolean(report.skipped)],
    ...V2_COUNT_FIELDS.map((field) => [field, Number(report[field] || 0)]),
  ]);
}

async function runProductionMigrationPreflight({
  mode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
  sourceModel = MappingProfile,
  targetModel = MappingProfileV2,
  auditModel = MappingProfileV2MigrationAudit,
  connection = mongoose.connection,
  migrateOwnerScope = migrateMappingProfileOwnerScope,
  ensureV2Indexes = ensureMappingProfileV2Indexes,
  migrateV2 = migrateMappingProfilesV1ToV2,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const ownerMode = normalizedMode === "apply" ? "apply" : "dry-run";
  const v2Mode = normalizedMode === "off" ? "dry-run" : normalizedMode;

  const ownerScope = await migrateOwnerScope({ model: sourceModel, mode: ownerMode });
  const v2Indexes = await ensureV2Indexes({
    model: targetModel,
    auditModel,
    mode: normalizedMode,
  });
  const v2 = await migrateV2({
    sourceModel,
    targetModel,
    auditModel,
    connection,
    mode: v2Mode,
  });

  return {
    mode: normalizedMode,
    writesAllowed: normalizedMode === "apply" || normalizedMode === "rollback",
    ownerScope: {
      plannedBackfills: Number(ownerScope.plannedBackfills || 0),
      backfilled: Number(ownerScope.backfilled || 0),
      indexPlan: ownerScope.indexPlan || { dropIndexNames: [] },
      droppedIndexes: ownerScope.droppedIndexes || [],
    },
    v2Indexes: {
      indexPlan: v2Indexes.indexPlan,
      indexes: v2Indexes.indexes || [],
      auditIndexes: v2Indexes.auditIndexes || [],
    },
    v2: v2Counts(v2),
  };
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required for production migration preflight");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    autoCreate: false,
    autoIndex: false,
  });
  try {
    const report = await runProductionMigrationPreflight();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[MIGRATION] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  runProductionMigrationPreflight,
};
