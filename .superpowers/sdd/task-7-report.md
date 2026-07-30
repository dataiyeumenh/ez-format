# Task 7 Report

## Status

Implemented Accounting Operations and Mapping Profile V2 from reviewed source
`1a1d0e6971ccf5bd1140e676c63a5210a1111cbe`. Intended commit:
`feat: integrate accounting operations assistance`.

## Contracts Preserved

- Mapping Profile V2 uses immutable versions and state hashes, signed owner scope,
  explicit activation, drift/high-risk review, and semantic quarantine.
- V1 migration defaults to `off`; index creation and `apply` migration remain
  explicit startup actions.
- Deterministic rules retain blocker/warning authority. AI provides explanation
  only and uses sealed evidence-packet citation IDs.
- Correction apply/undo accepts backend-issued patch IDs and revision/state-hash
  concurrency guards.
- Reconciliation keeps insufficient evidence visible and never reports it as
  successful matching.
- Node and FastAPI capabilities are fetched independently; frontend operation
  capability normalization intersects both and fails closed. Vite cannot enable
  a backend-disabled operation.
- Gateway session routes preserve service authentication, conversion-context
  ownership, request IDs, bounded workbook uploads, and binary export behavior.
- Mongo payloads remain metadata-only; raw workbooks and full sensitive rows stay
  in TTL-bound operation storage and are not logged or serialized to Mongo.
- Existing converter, reconstruction, and Student Assistant capabilities remain
  present. Student flows securely infer their server-created operation session
  without requiring the older browser contract to submit revision fields.

## TDD Evidence

- Imported focused tests first; initial runs failed on missing modules/routes.
- Converter focused accounting/session/mapping suites: `105 passed, 2 skipped`.
- Student compatibility probes after operation-state composition: `2 passed`.
- Backend Mapping Profile V2/runtime/startup/student suites: `63 passed`.
- Frontend utility/render/status suite: `82 passed`.
- Frontend production build: passed.
- Frontend ESLint: passed.
- Ownership/canonical transplant verifier: passed; `172` owned, `8` excluded.

## Scope Notes

- The five operation components and their contract utilities are source-reviewed.
  Mapping Profile V2 is mounted in the existing conversion page only when the
  capability intersection enables it; other operation surfaces remain isolated
  components until their product workflow is enabled.
- The reviewed legacy `/api/convert` route remains mounted alongside the guarded
  converter gateway; Task 7 does not remove an existing main contract.
- The pre-existing Student file line-ending changes and
  `.superpowers/sdd/progress.md` were not staged.

## Concerns

- Focused tests use mocked persistence and local operation storage; no live MongoDB
  or production GridFS deployment was exercised.
- FastAPI retains the existing `on_event` deprecation warning.

## Findings Remediation - 2026-07-30

- Strong reconciliation now excludes already-used comparison records before
  strong or fallback candidate matching. One source record cannot auto-match
  multiple primary records; duplicate/ambiguous strong keys remain conflicts.
- Reconciliation reports persist `usable_evidence`. Candidate review reuses that
  original state instead of forcing it true, so mixed usable/insufficient roles
  remain `insufficient_evidence` until a new report has valid evidence.
- V1-to-V2 apply now requires explicit `migrationId` and `runId`, executes all
  writes and audit persistence in one Mongo transaction, and remains idempotent
  by legacy profile identity.
- Rollback requires the exact `migrationId`, apply `targetRunId`, and rollback
  `runId`. It transactionally deletes only V2 documents tagged by that apply run,
  restores captured legacy quarantine fields, and records a durable audit run.
  Reapply after rollback is supported. Default mode remains `off`.

### Regression Evidence

- RED: one comparison record produced two strong matches; mixed-role candidate
  review lacked `usable_evidence`; migration writes had no transaction session or
  rollback operation.
- GREEN: backend focused Task 7 suites: `28 passed`.
- GREEN: converter focused Task 7 suites: `69 passed`.
- `git diff --check`: passed; only pre-existing line-ending warnings emitted.
- Live Mongo replica-set migration apply/rollback was not run; transactional
  behavior is covered with session-asserting persistence doubles.
