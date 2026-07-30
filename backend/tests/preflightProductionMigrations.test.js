const assert = require("node:assert/strict");
const test = require("node:test");

let preflight = {};
try {
  preflight = require("../scripts/preflight-production-migrations");
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}

test("production migration preflight exposes a testable runner", () => {
  assert.equal(typeof preflight.runProductionMigrationPreflight, "function");
  assert.equal(typeof preflight.executeProductionMigrationCommand, "function");
});

function migrationDependencies() {
  const calls = [];
  let writes = 0;
  let applyRuns = 0;
  return {
    calls,
    get writes() {
      return writes;
    },
    dependencies: {
      sourceModel: {},
      targetModel: {},
      auditModel: {},
      connection: {},
      async migrateOwnerScope({ mode }) {
        calls.push(["owner", mode]);
        if (mode === "apply") writes += 1;
        return {
          mode,
          skipped: false,
          plannedBackfills: 2,
          backfilled: mode === "apply" ? 2 : 0,
          indexPlan: { dropIndexNames: ["legacy_unique"] },
          droppedIndexes: mode === "apply" ? ["legacy_unique"] : [],
        };
      },
      async ensureV2Indexes({ mode }) {
        calls.push(["indexes", mode]);
        if (mode === "apply") writes += 1;
        return {
          mode,
          skipped: mode === "off",
          indexPlan: {
            model: { createIndexNames: ["v2_unique"] },
            audit: { createIndexNames: ["audit_run"] },
          },
          indexes: mode === "apply" ? ["v2_unique"] : [],
          auditIndexes: mode === "apply" ? ["audit_run"] : [],
        };
      },
      async migrateV2({ mode }) {
        calls.push(["v2", mode]);
        if (mode === "apply") {
          writes += 1;
          applyRuns += 1;
        }
        if (mode === "rollback") writes += 1;
        return {
          mode,
          skipped: false,
          scanned: 3,
          planned: 1,
          created: mode === "apply" && applyRuns === 1 ? 1 : 0,
          skippedExisting: mode === "apply" && applyRuns > 1 ? 1 : 0,
          quarantined: 1,
          quarantinePersisted: mode === "apply" ? 1 : 0,
          quarantineRestored: mode === "rollback" ? 1 : 0,
          removed: mode === "rollback" ? 1 : 0,
          quarantine: [{ legacyProfileId: "must-not-be-printed" }],
        };
      },
    },
  };
}

test("production migration preflight off mode reports plans with zero writes", async () => {
  const fixture = migrationDependencies();
  const report = await preflight.runProductionMigrationPreflight({
    mode: "off",
    ...fixture.dependencies,
  });

  assert.ok(report);
  assert.equal(report.mode, "off");
  assert.equal(report.status, "completed");
  assert.equal(report.writesAllowed, false);
  assert.equal(report.ownerScope.plannedBackfills, 2);
  assert.deepEqual(report.ownerScope.indexPlan.dropIndexNames, ["legacy_unique"]);
  assert.deepEqual(report.v2Indexes.indexPlan.model.createIndexNames, ["v2_unique"]);
  assert.equal(report.v2.scanned, 3);
  assert.equal("quarantine" in report.v2, false);
  assert.equal(fixture.writes, 0);
  assert.deepEqual(fixture.calls, [
    ["owner", "dry-run"],
    ["indexes", "off"],
    ["v2", "dry-run"],
  ]);
  assert.deepEqual(report.phases.map(({ name, status }) => [name, status]), [
    ["owner-scope-preflight", "completed"],
    ["v2-index-preflight", "completed"],
    ["v2-data-preflight", "completed"],
  ]);
});

test("production migration preflight dry-run mode performs zero writes", async () => {
  const fixture = migrationDependencies();
  const report = await preflight.runProductionMigrationPreflight({
    mode: "dry-run",
    ...fixture.dependencies,
  });

  assert.ok(report);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.status, "completed");
  assert.equal(report.writesAllowed, false);
  assert.equal(fixture.writes, 0);
  assert.deepEqual(fixture.calls, [
    ["owner", "dry-run"],
    ["indexes", "dry-run"],
    ["v2", "dry-run"],
  ]);
});

test("production migration preflight apply mode remains idempotent", async () => {
  const fixture = migrationDependencies();
  const first = await preflight.runProductionMigrationPreflight({
    mode: "apply",
    ...fixture.dependencies,
  });
  const second = await preflight.runProductionMigrationPreflight({
    mode: "apply",
    ...fixture.dependencies,
  });

  assert.ok(first);
  assert.equal(first.v2.created, 1);
  assert.equal(second.v2.created, 0);
  assert.equal(second.v2.skippedExisting, 1);
  assert.deepEqual(fixture.calls.slice(0, 3), [
    ["owner", "dry-run"],
    ["indexes", "dry-run"],
    ["v2", "dry-run"],
  ]);
  assert.deepEqual(fixture.calls.slice(3, 6), [
    ["owner", "apply"],
    ["indexes", "apply"],
    ["v2", "apply"],
  ]);
  assert.deepEqual(first.phases.map(({ status }) => status), [
    "completed",
    "completed",
    "completed",
    "completed",
    "completed",
    "completed",
  ]);
});

test("production migration command keeps rollback explicit and V2-scoped", async () => {
  const fixture = migrationDependencies();
  const report = await preflight.runProductionMigrationPreflight({
    mode: "rollback",
    ...fixture.dependencies,
  });

  assert.ok(report);
  assert.equal(report.mode, "rollback");
  assert.equal(report.writesAllowed, true);
  assert.equal(report.ownerScope.backfilled, 0);
  assert.equal(report.v2.removed, 1);
  assert.equal(report.v2.quarantineRestored, 1);
  assert.deepEqual(fixture.calls, [
    ["owner", "dry-run"],
    ["indexes", "rollback"],
    ["v2", "rollback"],
  ]);
});

test("production migration failure after owner mutation reports phase and rollback boundary", async () => {
  let v2Calls = 0;
  let ownerWrites = 0;
  const error = new Error("index create denied");
  error.code = 13;
  let failure;

  try {
    await preflight.runProductionMigrationPreflight({
      mode: "apply",
      sourceModel: {},
      targetModel: {},
      auditModel: {},
      connection: {},
      migrateOwnerScope: async ({ mode }) => {
        if (mode === "apply") ownerWrites += 1;
        return {
          plannedBackfills: 1,
          backfilled: mode === "apply" ? 1 : 0,
          indexPlan: { dropIndexNames: [], createIndexes: [] },
          droppedIndexes: [],
        };
      },
      ensureV2Indexes: async ({ mode }) => {
        if (mode === "apply") throw error;
        return {
          indexPlan: { model: {}, audit: {} },
          indexes: [],
          auditIndexes: [],
        };
      },
      migrateV2: async () => { v2Calls += 1; },
    });
  } catch (caught) {
    failure = caught;
  }

  assert.match(failure?.message || "", /index create denied/);
  assert.equal(ownerWrites, 1);
  assert.equal(v2Calls, 1);
  assert.equal(failure.report.status, "failed");
  assert.deepEqual(
    failure.report.phases.map(({ name, status }) => [name, status]),
    [
      ["owner-scope-preflight", "completed"],
      ["v2-index-preflight", "completed"],
      ["v2-data-preflight", "completed"],
      ["owner-scope-apply", "completed"],
      ["v2-index-apply", "failed"],
      ["v2-data-apply", "pending"],
    ],
  );
  assert.deepEqual(
    failure.report.rollbackBoundary.completedMutationPhases,
    ["owner-scope-apply"],
  );
  assert.equal(failure.report.rollbackBoundary.failedPhase, "v2-index-apply");
  assert.equal(failure.report.rollbackBoundary.manualRecoveryRequired, true);
});

test("production migration command emits JSON phase report before rethrowing failure", async () => {
  const lines = [];
  const failure = new Error("partial migration");
  failure.report = {
    mode: "apply",
    status: "failed",
    phases: [{ name: "owner-scope-apply", status: "failed" }],
    rollbackBoundary: { manualRecoveryRequired: true },
  };

  await assert.rejects(
    preflight.executeProductionMigrationCommand({
      runner: async () => { throw failure; },
      writeLine: (line) => lines.push(line),
    }),
    /partial migration/,
  );

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), failure.report);
});

test("production migration command emits machine-readable invalid-mode failure", async () => {
  const lines = [];

  await assert.rejects(
    preflight.executeProductionMigrationCommand({
      runOptions: { mode: "invalid-mode" },
      writeLine: (line) => lines.push(line),
    }),
    /mode must be/i,
  );

  const report = JSON.parse(lines[0]);
  assert.equal(report.mode, "invalid-mode");
  assert.equal(report.status, "failed");
  assert.deepEqual(
    report.phases.map(({ name, status }) => [name, status]),
    [["command-bootstrap", "failed"]],
  );
});
