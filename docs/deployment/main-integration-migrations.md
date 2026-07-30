# Main Integration Mongo Migrations

Mapping-profile migrations are disabled by default:

```env
MAPPING_PROFILE_V2_MIGRATION_MODE=off
```

`off` and `dry-run` are read-only. Only exact `apply` mode may backfill owner
scopes, drop or create indexes, quarantine legacy profiles, or create V2
profiles. Enabling the Mapping Profile V2 feature does not apply indexes.
Startup rejects `rollback`; rollback is available only through the explicit
production migration command.

## Preflight

Run from the repository root. The command connects with Mongoose automatic
index and collection creation disabled. Its JSON output contains counts,
explicit index specifications, phase states, and the rollback boundary, not
profile contents.

```powershell
$env:MAPPING_PROFILE_V2_MIGRATION_MODE = "off"
node backend/scripts/preflight-production-migrations.js

$env:MAPPING_PROFILE_V2_MIGRATION_MODE = "dry-run"
node backend/scripts/preflight-production-migrations.js
```

Review these fields before applying:

- `ownerScope.plannedBackfills` and `ownerScope.indexPlan.dropIndexNames`
- `ownerScope.indexPlan.createIndexes`
- `v2Indexes.indexPlan.*.createIndexes`
- `v2Indexes.indexPlan.*.incompatibleIndexNames`
- `v2.scanned`, `v2.planned`, `v2.skippedExisting`, and `v2.quarantined`
- `phases[].status` and `rollbackBoundary`

Index writes use frozen allowlists. The apply path issues only the create/drop
operations shown in these plans. It does not call `syncIndexes()` or
model-wide `createIndexes()`. Unmanaged indexes and new schema indexes outside
the reviewed allowlists remain untouched.

Any index inspection error other than a missing collection fails the command.
Any apply error, including non-`IndexNotFound` drop errors, stops remaining
work and returns a non-zero exit code. A failed command still prints one JSON
report. The failed phase is `failed`; completed work remains `completed`; work
not attempted remains `pending`.

## Apply

Take a Mongo backup first. Use stable migration identity plus a unique apply
run identity:

```powershell
$env:MAPPING_PROFILE_V2_MIGRATION_MODE = "apply"
$env:MAPPING_PROFILE_V2_MIGRATION_ID = "main-integration-v1-v2"
$env:MAPPING_PROFILE_V2_MIGRATION_RUN_ID = "apply-2026-07-30-01"
node backend/scripts/preflight-production-migrations.js
```

Apply is idempotent. Re-running the same command does not duplicate V2
profiles; completed owner-scope backfills and obsolete-index drops are absent
from the next plan. Return startup to `off` after the explicit run.

Before any apply mutation, the command runs owner-scope, V2-index, and V2-data
preflight phases. Compatibility blockers therefore fail before mutation when
they are observable during preflight. State can still change between preflight
and apply, so each mutating service checks its plan again and fails closed.

Startup also honors exact `apply` mode for controlled deployments. Prefer the
standalone command after reviewing `off` or `dry-run` output because it emits
the execution report separately from service availability.

## Rollback

Rollback requires the exact apply run ID. Use a new rollback run ID:

```powershell
$env:MAPPING_PROFILE_V2_MIGRATION_MODE = "rollback"
$env:MAPPING_PROFILE_V2_MIGRATION_ID = "main-integration-v1-v2"
$env:MAPPING_PROFILE_V2_MIGRATION_TARGET_RUN_ID = "apply-2026-07-30-01"
$env:MAPPING_PROFILE_V2_MIGRATION_RUN_ID = "rollback-2026-07-30-01"
node backend/scripts/preflight-production-migrations.js
```

Rollback removes only V2 documents tagged with the target apply run and
restores only legacy quarantine state captured by that run. It refuses to
guess `MAPPING_PROFILE_V2_MIGRATION_TARGET_RUN_ID`.

## Rollback Boundary

The migration is not one transaction across all phases. V2 data, quarantine,
and audit changes use a Mongo transaction. Owner-scope backfill plus its
allowlisted index operations are not one transaction. V2 index creates are
also separate Mongo operations. A failure inside either index/data preparation
phase can leave earlier operations in that phase committed.

Automatic rollback does not revert V1 `ownerScope` backfills, recreate the
obsolete workspace unique index, remove newly-created V2/audit indexes, or
restore unrelated data. Reversing those changes requires the pre-apply backup
or a separately reviewed manual index/data operation. A failure after an
earlier phase may therefore leave that earlier phase committed; inspect the
JSON report and Mongo state before retrying or rolling back.

`rollbackBoundary.completedMutationPhases` lists committed phases.
`rollbackBoundary.possiblyPartialMutationPhase` identifies a failed mutating
phase that may have written before failing. `manualRecoveryRequired` becomes
true when automatic V2 target-run rollback cannot restore the full run.
