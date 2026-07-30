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
});

test("production migration preflight dry-run mode performs zero writes", async () => {
  const fixture = migrationDependencies();
  const report = await preflight.runProductionMigrationPreflight({
    mode: "dry-run",
    ...fixture.dependencies,
  });

  assert.ok(report);
  assert.equal(report.mode, "dry-run");
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
    ["owner", "apply"],
    ["indexes", "apply"],
    ["v2", "apply"],
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

test("production migration preflight fails closed before V2 data writes on index errors", async () => {
  let v2Calls = 0;
  const error = new Error("index create denied");
  error.code = 13;

  await assert.rejects(
    () => Promise.resolve(preflight.runProductionMigrationPreflight({
      mode: "apply",
      sourceModel: {},
      targetModel: {},
      auditModel: {},
      connection: {},
      migrateOwnerScope: async () => ({
        plannedBackfills: 0,
        backfilled: 0,
        indexPlan: { dropIndexNames: [] },
        droppedIndexes: [],
      }),
      ensureV2Indexes: async () => { throw error; },
      migrateV2: async () => { v2Calls += 1; },
    })),
    /index create denied/,
  );
  assert.equal(v2Calls, 0);
});
