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
index and collection creation disabled. Its JSON output contains counts and
index names, not profile contents.

```powershell
$env:MAPPING_PROFILE_V2_MIGRATION_MODE = "off"
node backend/scripts/preflight-production-migrations.js

$env:MAPPING_PROFILE_V2_MIGRATION_MODE = "dry-run"
node backend/scripts/preflight-production-migrations.js
```

Review these fields before applying:

- `ownerScope.plannedBackfills` and `ownerScope.indexPlan.dropIndexNames`
- `v2Indexes.indexPlan.*.createIndexNames`
- `v2Indexes.indexPlan.*.incompatibleIndexNames`
- `v2.scanned`, `v2.planned`, `v2.skippedExisting`, and `v2.quarantined`

Any index inspection error other than a missing collection fails the command.
Any apply error, including non-`IndexNotFound` drop errors, stops remaining
work and returns a non-zero exit code.

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
and audit changes use a Mongo transaction, but owner-scope and index phases
commit separately.

Automatic rollback does not revert V1 `ownerScope` backfills, recreate the
obsolete workspace unique index, remove newly-created V2/audit indexes, or
restore unrelated data. Reversing those changes requires the pre-apply backup
or a separately reviewed manual index/data operation. A failure after an
earlier phase may therefore leave that earlier phase committed; inspect the
JSON report and Mongo state before retrying or rolling back.
