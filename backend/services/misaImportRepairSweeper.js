const MisaImportIssue = require("../models/MisaImportIssue");
const MisaImportRepairConfirmation = require("../models/MisaImportRepairConfirmation");
const MisaImportRepairSession = require("../models/MisaImportRepairSession");
const MisaRetryBatch = require("../models/MisaRetryBatch");
const { emitMisaImportRepairAuditEvent } = require("./misaImportRepairService");

const DEFAULT_SWEEP_INTERVAL_SECONDS = 5 * 60;
const DEFAULT_SWEEP_BATCH_SIZE = 100;

let activeDefaultSweeper = null;
const activeOwnerSweepers = new WeakMap();

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function configuredIntervalMs(env) {
  return boundedInteger(
    env.MISA_IMPORT_REPAIR_SWEEP_INTERVAL_SECONDS,
    DEFAULT_SWEEP_INTERVAL_SECONDS,
    10,
    24 * 60 * 60,
  ) * 1000;
}

function configuredBatchSize(env) {
  return boundedInteger(
    env.MISA_IMPORT_REPAIR_SWEEP_BATCH_SIZE,
    DEFAULT_SWEEP_BATCH_SIZE,
    1,
    1000,
  );
}

function defaultModels() {
  return {
    Confirmation: MisaImportRepairConfirmation,
    RetryBatch: MisaRetryBatch,
    Issue: MisaImportIssue,
    RepairSession: MisaImportRepairSession,
  };
}

function emptyDeletedCounts() {
  return { confirmations: 0, retryBatches: 0, issues: 0, repairSessions: 0 };
}

function databaseAvailable(models) {
  return Object.values(models).every(
    (model) => model?.db?.readyState === undefined || model.db.readyState === 1,
  );
}

async function deleteExpired(model, cutoff, limit) {
  const documents = await model.find({ expiresAt: { $lte: cutoff } })
    .sort({ expiresAt: 1, _id: 1 })
    .limit(limit)
    .select({ _id: 1 })
    .lean();
  if (documents.length === 0) return 0;
  const result = await model.deleteMany({
    _id: { $in: documents.map((document) => document._id) },
    expiresAt: { $lte: cutoff },
  });
  return Number(result?.deletedCount || result?.n || 0);
}

async function sweepExpiredMisaImportRepairRecords({
  models = defaultModels(),
  now = () => new Date(),
  limit = DEFAULT_SWEEP_BATCH_SIZE,
} = {}) {
  const deleted = emptyDeletedCounts();
  if (!databaseAvailable(models)) {
    return { skipped: true, reason: "database_unavailable", deleted };
  }

  const cutoff = now();
  const boundedLimit = boundedInteger(limit, DEFAULT_SWEEP_BATCH_SIZE, 1, 1000);
  // Dependents go first so no live issue or batch points at a removed session.
  const dependentCollections = [
    ["Confirmation", "confirmations", models.Confirmation],
    ["RetryBatch", "retryBatches", models.RetryBatch],
    ["Issue", "issues", models.Issue],
  ];
  const failedCollections = [];
  for (const [collectionName, resultKey, model] of dependentCollections) {
    try {
      deleted[resultKey] = await deleteExpired(model, cutoff, boundedLimit);
    } catch {
      failedCollections.push(collectionName);
    }
  }
  const skippedCollections = [];
  if (failedCollections.length === 0) {
    try {
      deleted.repairSessions = await deleteExpired(
        models.RepairSession,
        cutoff,
        boundedLimit,
      );
    } catch {
      failedCollections.push("RepairSession");
    }
  } else {
    skippedCollections.push("RepairSession");
  }
  return {
    skipped: false,
    failed: failedCollections.length > 0,
    ...(failedCollections.length > 0
      ? {
          reason: "collection_failure",
          failedCollections,
          ...(skippedCollections.length > 0 ? { skippedCollections } : {}),
        }
      : {}),
    deleted,
  };
}

function startMisaImportRepairSweeper({
  models = defaultModels(),
  env = process.env,
  now = () => new Date(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
  owner = null,
} = {}) {
  const ownerObject = owner && typeof owner === "object" ? owner : null;
  const existing = ownerObject
    ? activeOwnerSweepers.get(ownerObject)
    : activeDefaultSweeper;
  if (existing) return existing;

  const limit = configuredBatchSize(env);
  let running = null;
  let stopped = false;
  let cleared = false;
  const runOnce = () => {
    if (stopped) return Promise.resolve({ skipped: true, reason: "stopped", deleted: emptyDeletedCounts() });
    if (running) return running;
    const startedAt = Date.now();
    running = Promise.resolve(sweepExpiredMisaImportRepairRecords({ models, now, limit }))
      .then((result) => {
        emitMisaImportRepairAuditEvent({
          event: result.failed
            ? "misa_import_repair.sweep.failed"
            : result.skipped
              ? "misa_import_repair.sweep.skipped"
              : "misa_import_repair.sweep.completed",
          issueCount: result.deleted.issues,
          durationMs: Date.now() - startedAt,
          statusCode: result.failed || result.skipped ? 503 : 200,
        }, { logger });
        return result;
      })
      .catch(() => {
        emitMisaImportRepairAuditEvent({
          event: "misa_import_repair.sweep.failed",
          durationMs: Date.now() - startedAt,
          statusCode: 503,
        }, { logger });
        return {
          skipped: true,
          failed: true,
          reason: "sweep_failed",
          failedCollections: ["unknown"],
          deleted: emptyDeletedCounts(),
        };
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const ready = runOnce();
  const timer = setIntervalImpl(runOnce, configuredIntervalMs(env));
  timer?.unref?.();
  const sweeper = {
    ready,
    runOnce,
    stop() {
      if (cleared) return;
      stopped = true;
      cleared = true;
      clearIntervalImpl(timer);
      if (ownerObject) activeOwnerSweepers.delete(ownerObject);
      else if (activeDefaultSweeper === sweeper) activeDefaultSweeper = null;
    },
  };
  if (ownerObject) activeOwnerSweepers.set(ownerObject, sweeper);
  else activeDefaultSweeper = sweeper;
  return sweeper;
}

module.exports = {
  startMisaImportRepairSweeper,
  sweepExpiredMisaImportRepairRecords,
};
