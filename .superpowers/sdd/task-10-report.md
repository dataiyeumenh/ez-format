# Task 10 Report

Status: PASS

Branch: `codex/main-experimental-production-integration`

## Delivered

- Owner-scope and V2 index migrations default to `off`.
- Startup passes the explicit mode, mutates mapping-profile data/indexes only in
  `apply`, and rejects startup rollback.
- `off`/`dry-run` compatibility paths report counts and index plans with zero
  writes.
- Explicit production command supports `off`, `dry-run`, idempotent `apply`,
  and target-run-scoped `rollback`.
- V2 index compatibility blockers report before apply; unexpected index errors
  fail closed.
- Deployment guide documents operator commands and the non-atomic rollback
  boundary.

## TDD Evidence

RED failures observed before implementation:

- owner migration queried Mongo in default mode and wrote during dry-run;
- V2 index setup wrote in default/dry-run modes;
- startup omitted explicit owner/index modes and allowed startup rollback;
- production preflight runner/report did not exist.

GREEN verification:

```text
node --test tests/mappingProfileMigration.test.js tests/mappingProfileV2Migration.test.js
20 tests, 20 pass, 0 fail (exit 0)

node --test tests/serverStartupReadiness.test.js tests/preflightProductionMigrations.test.js
20 tests, 20 pass, 0 fail (exit 0)

npm run qa:fast
QA/QC PASSED (9 steps) (exit 0)
```

Syntax checks passed for `server.js`, both mapping migration services, and the
production preflight script. Task-file `git diff --check` passed.

## Scope

Task 10 changes are limited to mapping migration services, startup composition,
the production migration command, focused tests, deployment documentation, and
this report. Existing Student line-ending changes, QA reports, and
`.superpowers/sdd/progress.md` remain unstaged.

Blockers: none.

## Important Review Fix

- Removed broad `syncIndexes()` and model-wide `createIndexes()` calls.
- Added frozen V1/V2/audit index allowlists; preflight reports the exact
  create/drop specs. Unmanaged and unrelated schema indexes remain untouched.
- Apply now completes all available read-only checks before mutation.
- Added machine-readable phase states and rollback-boundary output on success
  or failure. Failed commands emit JSON, rethrow, and exit non-zero.
- Added regression coverage for unmanaged indexes, unrelated missing schema
  indexes, incompatible specs, and failure after owner mutation.

Review-fix verification:

```text
node --test tests/mappingProfileMigration.test.js tests/mappingProfileV2Migration.test.js tests/serverStartupReadiness.test.js tests/preflightProductionMigrations.test.js
45 tests, 45 pass, 0 fail (exit 0)

npm run qa:fast
QA/QC PASSED (9 steps) (exit 0)
```
