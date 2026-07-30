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

function ownerScopeSummary(report = {}) {
  return {
    plannedBackfills: Number(report.plannedBackfills || 0),
    backfilled: Number(report.backfilled || 0),
    indexPlan: report.indexPlan || {
      dropIndexNames: [],
      createIndexes: [],
      incompatibleIndexNames: [],
    },
    droppedIndexes: report.droppedIndexes || [],
    createdIndexes: report.createdIndexes || [],
  };
}

function v2IndexSummary(report = {}) {
  return {
    indexPlan: report.indexPlan || { model: {}, audit: {} },
    indexes: report.indexes || [],
    auditIndexes: report.auditIndexes || [],
  };
}

function phaseDefinitions(mode) {
  const checks = [
    { name: "owner-scope-preflight", mutates: false },
    { name: "v2-index-preflight", mutates: false },
  ];
  if (mode === "rollback") {
    return [...checks, { name: "v2-rollback", mutates: true }];
  }
  checks.push({ name: "v2-data-preflight", mutates: false });
  if (mode !== "apply") return checks;
  return [
    ...checks,
    { name: "owner-scope-apply", mutates: true },
    { name: "v2-index-apply", mutates: true },
    { name: "v2-data-apply", mutates: true },
  ];
}

function rollbackBoundary(report) {
  const completedMutationPhases = report.phases
    .filter((phase) => phase.mutates && phase.status === "completed")
    .map((phase) => phase.name);
  const failed = report.phases.find((phase) => phase.status === "failed");
  const possiblyPartialMutationPhase = failed?.mutates ? failed.name : null;
  return {
    atomicity: "phase-scoped; no transaction spans owner, index, and V2 phases",
    v2RollbackScope: "target-run-only",
    manualRecoveryScopes: ["owner-scope", "mapping-profile-indexes"],
    completedMutationPhases,
    failedPhase: failed?.name || null,
    possiblyPartialMutationPhase,
    manualRecoveryRequired: report.status === "failed" && (
      completedMutationPhases.length > 0 || Boolean(possiblyPartialMutationPhase)
    ),
  };
}

function publicError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code ?? null,
    codeName: error?.codeName ?? null,
  };
}

async function runPhase(report, name, work, summarize, validate = null) {
  const phase = report.phases.find((item) => item.name === name);
  phase.status = "running";
  try {
    const result = await work();
    phase.report = summarize(result);
    if (validate) validate(result);
    phase.status = "completed";
    return result;
  } catch (error) {
    phase.status = "failed";
    phase.error = publicError(error);
    report.status = "failed";
    report.rollbackBoundary = rollbackBoundary(report);
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.report = report;
    throw failure;
  }
}

function incompatibleIndexNames(indexReport = {}) {
  return [
    ...(indexReport.indexPlan?.model?.incompatibleIndexNames || []),
    ...(indexReport.indexPlan?.audit?.incompatibleIndexNames || []),
  ];
}

function assertApplyCompatible(ownerReport, indexReport) {
  const incompatible = [
    ...(ownerReport.indexPlan?.incompatibleIndexNames || []),
    ...incompatibleIndexNames(indexReport),
  ];
  if (incompatible.length) {
    throw new Error(
      `MappingProfile index compatibility check failed: ${incompatible.join(", ")}`,
    );
  }
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
  const report = {
    mode: normalizedMode,
    status: "pending",
    writesAllowed: normalizedMode === "apply" || normalizedMode === "rollback",
    phases: phaseDefinitions(normalizedMode).map((phase) => ({
      ...phase,
      status: "pending",
    })),
    ownerScope: ownerScopeSummary(),
    v2Indexes: v2IndexSummary(),
    v2: v2Counts(),
  };

  const ownerPreflight = await runPhase(
    report,
    "owner-scope-preflight",
    () => migrateOwnerScope({ model: sourceModel, mode: "dry-run" }),
    ownerScopeSummary,
  );
  report.ownerScope = ownerScopeSummary(ownerPreflight);

  const indexPreflightMode = normalizedMode === "off" || normalizedMode === "rollback"
    ? normalizedMode
    : "dry-run";
  const indexPreflight = await runPhase(
    report,
    "v2-index-preflight",
    () => ensureV2Indexes({
      model: targetModel,
      auditModel,
      mode: indexPreflightMode,
    }),
    v2IndexSummary,
    normalizedMode === "apply"
      ? (result) => assertApplyCompatible(ownerPreflight, result)
      : null,
  );
  report.v2Indexes = v2IndexSummary(indexPreflight);

  if (normalizedMode === "rollback") {
    const rollback = await runPhase(
      report,
      "v2-rollback",
      () => migrateV2({
        sourceModel,
        targetModel,
        auditModel,
        connection,
        mode: "rollback",
      }),
      v2Counts,
    );
    report.v2 = v2Counts(rollback);
    report.status = "completed";
    report.rollbackBoundary = rollbackBoundary(report);
    return report;
  }

  const v2Preflight = await runPhase(
    report,
    "v2-data-preflight",
    () => migrateV2({
      sourceModel,
      targetModel,
      auditModel,
      connection,
      mode: "dry-run",
    }),
    v2Counts,
  );
  report.v2 = v2Counts(v2Preflight);

  if (normalizedMode === "apply") {
    const ownerApply = await runPhase(
      report,
      "owner-scope-apply",
      () => migrateOwnerScope({ model: sourceModel, mode: "apply" }),
      ownerScopeSummary,
    );
    report.ownerScope = ownerScopeSummary(ownerApply);

    const indexApply = await runPhase(
      report,
      "v2-index-apply",
      () => ensureV2Indexes({
        model: targetModel,
        auditModel,
        mode: "apply",
      }),
      v2IndexSummary,
    );
    report.v2Indexes = v2IndexSummary(indexApply);

    const v2Apply = await runPhase(
      report,
      "v2-data-apply",
      () => migrateV2({
        sourceModel,
        targetModel,
        auditModel,
        connection,
        mode: "apply",
      }),
      v2Counts,
    );
    report.v2 = v2Counts(v2Apply);
  }

  report.status = "completed";
  report.rollbackBoundary = rollbackBoundary(report);
  return report;
}

function fallbackFailureReport(
  error,
  mode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
) {
  const report = {
    mode: String(mode || "off").trim().toLowerCase(),
    status: "failed",
    writesAllowed: false,
    phases: [{
      name: "command-bootstrap",
      mutates: false,
      status: "failed",
      error: publicError(error),
    }],
  };
  report.rollbackBoundary = rollbackBoundary(report);
  return report;
}

async function executeProductionMigrationCommand({
  runner = runProductionMigrationPreflight,
  runOptions = {},
  writeLine = (line) => console.log(line),
} = {}) {
  try {
    const report = await runner(runOptions);
    writeLine(JSON.stringify(report));
    return report;
  } catch (error) {
    const report = error?.report || fallbackFailureReport(error, runOptions.mode);
    writeLine(JSON.stringify(report));
    throw error;
  }
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
  return executeProductionMigrationCommand({
    runner: async () => {
      if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI is required for production migration preflight");
      }
      await mongoose.connect(process.env.MONGO_URI, {
        autoCreate: false,
        autoIndex: false,
      });
      try {
        return await runProductionMigrationPreflight();
      } finally {
        await mongoose.disconnect();
      }
    },
  });
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  executeProductionMigrationCommand,
  main,
  runProductionMigrationPreflight,
};
