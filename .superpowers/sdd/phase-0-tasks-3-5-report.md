# Phase 0 Tasks 3-5 Implementation Report

## Status

`DONE`

Tasks 3, 4, and 5 are implemented within the brief file scope. Existing
converter routes remain functional with all student feature flags disabled.

## Task 3 - Mapping-profile owner isolation

### RED

- Node tests failed because the schema still used the workspace unique key,
  serializers omitted `ownerScope`, and student tokens were rejected with 401.
- Python tests failed because `MappingProfile` had no `owner_scope` and SQLite
  APIs could not isolate lookup/get/save/use by owner.

### GREEN

- Mongo `MappingProfile.ownerScope` is required and authoritative; `workspace`
  and `user` remain optional compatibility references.
- The unique schema key is `(ownerScope, targetTemplateId, sourceSignatureHash)`.
- Workspace conversion claims resolve to `workspace:<workspace_id>`; student
  claims use the exact signed `owner_scope`.
- Lookup, get, save, and mark-used filters always include the signed owner.
- SQLite adds/backfills non-empty `owner_scope`, maps legacy workspace rows to
  `workspace:<id>`, maps empty legacy rows to `local:legacy`, creates the owner
  signature index, and rejects empty owner updates/inserts.
- New local writes use `LOCAL_MAPPING_OWNER_SCOPE`, default `local:default`.
- Compatibility serializer fields `workspaceId`/`workspace_id` are preserved.

### Tests

- `node.exe --test backend/tests/mappingProfiles.test.js`: 4 passed.
- `python.exe -m pytest tests/test_mapping_profile_client.py tests/test_misa_profile_api.py -q --basetemp=.pytest-tmp/task3`: 17 passed.

## Task 4 - FastAPI student context and retention

### RED

- Initial collection failed with `ModuleNotFoundError: app.student_context`.
- A security regression test showed analyze could accept both student and
  conversion contexts instead of failing closed.
- A path-boundary test showed upload id `..` was not rejected as an invalid id.

### GREEN

- Added a stdlib HS256 verifier compatible with Node/jsonwebtoken; no new JWT
  package was added.
- Verification requires valid signature, purpose, session, user, owner scope,
  explicit required scope, and unexpired `exp`.
- Student upload metadata contains only session/user/owner/workspace ids and
  expiry in `student.json`; raw workbook bytes remain only in the upload folder.
- Analyze binds the upload before student operations continue; preview,
  readiness, confirm, and export reject missing, cross-owner, cross-session, or
  expired student contexts.
- Student and conversion contexts cannot be combined on one analyze request.
- Startup and request-opportunistic cleanup delete expired student upload
  directories without logging row contents.

### Tests

- `python.exe -m pytest tests/test_student_context.py -q`: 11 passed.
- Brief-focused Task 4 command plus API profile tests: 25 passed.

## Task 5 - Anonymization primitive and rollback gate

### RED

- Initial collection failed with
  `ModuleNotFoundError: app.student_anonymization`.
- Environment documentation tests failed because the root example and student
  rollback flags did not exist.

### GREEN

- Added deterministic HMAC pseudonyms scoped by session, category, and source
  value for company, counterparty, tax code, address, email, phone, bank
  account, and optional document number.
- Blank values remain unchanged; identifier replacements stay strings and keep
  leading zeroes in the generated numeric token.
- Added a recursive confidential-value scanner that returns matched categories,
  not the original confidential values.
- Documented all seven rollback flags plus `CONVERSION_CONTEXT_SECRET`, local
  mapping owner scope, upload retention, and cleanup interval values.
- No workbook anonymization/export endpoint was added, as required for Phase 0.

### Tests

- `python.exe -m pytest tests/test_student_anonymization.py -q`: 6 passed.

## Final Verification

- Node focused regression: 21 passed, 0 failed.
- Python focused/regression/smoke with all seven student flags set to `false`:
  48 passed, 0 failed.
- Python verification included mapping profile client/API, student context,
  anonymization, master-data workflow, API health/validate/convert smoke, and
  Excel pipeline tests.
- `git diff --check` reported no whitespace errors for the scoped files.
- No files were staged or committed.

## Files

- `backend/models/MappingProfile.js`
- `backend/services/mappingProfileService.js`
- `backend/controllers/accountingWorkspaceController.js`
- `backend/tests/mappingProfiles.test.js`
- `converter/app/mapping_profile_client.py`
- `converter/app/misa_profiles.py`
- `converter/app/misa_workflow.py`
- `converter/app/main.py`
- `converter/app/student_context.py`
- `converter/app/student_store.py`
- `converter/app/student_anonymization.py`
- `converter/tests/test_mapping_profile_client.py`
- `converter/tests/test_misa_profile_api.py`
- `converter/tests/test_student_context.py`
- `converter/tests/test_student_anonymization.py`
- `.env.example`
- `converter/.env.example`
- `frontend/.env.example`
- `.superpowers/sdd/phase-0-tasks-3-5-report.md`

## Original Concerns

1. The Mongoose schema now declares the owner-scope unique index, but this task
   did not run against a live MongoDB. A deployed database may still retain the
   old unique index on `(workspace, targetTemplateId, sourceSignatureHash)`;
   production rollout should inspect and drop that obsolete index before
   relying on multiple user-scoped profiles with `workspace=null`.
2. Node owner-isolation controller tests use model stubs rather than a live
   MongoDB integration fixture. The query filters and signed-token behavior are
   covered, but physical index migration is not.
3. Windows Python needed a workspace-local pytest `--basetemp`; SQLite locked
   when pytest used WSL `/tmp` through a UNC path. This is a test-environment
   issue, not a converter failure.

## Reviewer Rejection Fixes

The rollout/index concerns above are superseded by the automatic migration
implemented in this fix pass. The reviewer requested no live MongoDB test, so
the migration is covered with deterministic model/collection stubs.

### 1. Rollout-safe Mongo migration

#### RED

- `backend/tests/mappingProfileMigration.test.js` initially failed with
  `MODULE_NOT_FOUND` because no migration service existed.

#### GREEN

- Added `backend/services/mappingProfileMigrationService.js`.
- Legacy documents missing `ownerScope` are backfilled to
  `workspace:<workspace>`; only documents without a workspace fall back to
  `user:<updatedBy>`.
- Migration fails closed for an orphan document without either owner source.
- The obsolete unique index
  `workspace_1_targetTemplateId_1_sourceSignatureHash_1` is dropped when
  present, then `MappingProfile.syncIndexes()` creates/synchronizes the current
  owner-scope indexes.
- `backend/server.js` now awaits database connection and this migration before
  calling `app.listen`; existing student flags and loopback CORS dirty edits are
  preserved.
- Unit tests verify owner planning, obsolete-index planning, and execution order
  `bulkWrite -> dropIndex -> syncIndexes` without requiring MongoDB.
- A fresh-database regression verifies `NamespaceNotFound` from index listing is
  treated as an empty collection and still proceeds to `syncIndexes()`.

### 2. Node student JWT hardening

#### RED

- New tests showed no-exp tokens, scalar `allowed_scopes`, and HS512 tokens were
  accepted.

#### GREEN

- `verifyStudentContextToken` pins `algorithms: ["HS256"]`.
- Verification requires a finite numeric future `exp`.
- Verification requires `allowed_scopes` to be an Array before checking the
  required operation scope.

### 3. Operation-specific student scopes

#### RED

- An export-only token could not get a profile because every internal route
  defaulted to `analyze`.
- An analyze-only token could save a durable profile.
- FastAPI preview and confirm accepted analyze-only tokens.

#### GREEN

- Analyze profile find/mark-used require `analyze`.
- Preview/readiness require `explain`.
- Confirm/durable profile save require `attempt`.
- Export/profile get require `export`.
- Tests prove analyze-only cannot save and export-only can get the matching
  owner profile.

### 4. SQLite legacy local profile compatibility

#### RED

- Rows correctly migrated to `local:legacy` but default local lookup/get could
  no longer use them.

#### GREEN

- A `local:default` lookup or get atomically claims the matching
  `local:legacy` row before returning it.
- User/workspace owner scopes cannot claim legacy local rows.
- Regression tests cover both signature lookup and direct profile get.

### 5. Legacy workspace upload metadata

#### RED

- Export treated metadata without `owner_scope` as `local:default` even when the
  stored conversion context contained a workspace id.

#### GREEN

- Confirm/export derive `workspace:<workspace_id>` from legacy
  `conversion_context.workspace_id` before falling back to local ownership.
- Export regression reaches workbook generation with the derived workspace
  owner.

### 6. Student raw-retention crash window

#### RED

- A simulated workbook write failure left an upload directory without
  `student.json`, so expiry cleanup could not discover it.

#### GREEN

- Student uploads now create and atomically bind `student.json` immediately
  after directory creation and before writing workbook bytes.
- A simulated failure between binding and byte write leaves no raw input file,
  and expiry cleanup removes the bound directory.

## Reviewer Fix Verification

- Node student + mapping + migration tests: 30 passed, 0 failed.
- Python focused/regression suite with all seven student flags disabled:
  51 passed, 0 failed.
- No test suite remained blocked by the Windows/WSL SQLite lock; verification
  used a workspace-local `--basetemp`.
- No files were staged or committed.

## Second Re-review Fixes

### 1. Prevent Mongoose auto-index race

#### RED

- The schema regression reported `MappingProfile.schema.options.autoIndex` as
  `null`, so Mongoose could attempt index creation before the startup migration.

#### GREEN

- `MappingProfile` now sets schema option `autoIndex: false`.
- Index creation/synchronization remains centralized in the startup migration,
  after legacy owner backfill and obsolete-index removal.
- The mapping profile schema test asserts `autoIndex === false`.

### 2. Concurrent obsolete-index drops

#### RED

- A deterministic concurrent-start test reproduced Mongo `IndexNotFound`
  (`code=27`) when another process dropped the obsolete index first.

#### GREEN

- The migration ignores only `IndexNotFound`/code 27 and continues to
  `syncIndexes()`.
- Other drop errors still reject the migration before index sync, preserving
  fail-closed startup behavior.

### Second Re-review Verification

- Node student + mapping + migration tests: 30 passed, 0 failed.
- JavaScript syntax checks passed for server, model, migration service and
  conversion-context service.
- Scoped `git diff --check` passed.
- No files were staged or committed.
