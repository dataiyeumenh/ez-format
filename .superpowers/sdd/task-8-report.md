# Task 8 Report: Final-Reviewed MISA Import Repair

## Status

Implemented the Task 8 isolated repair slice from source
`1a1d0e6971ccf5bd1140e676c63a5210a1111cbe`. Shared integration changes were
composed onto the reviewed gateway, GridFS, converter, and frontend hook
contracts; existing Student Assistant changes were not staged or altered.

## Enforced Contracts

- Phase 1 persists `manual_excel_v1` with `verified=false`; matching remains a
  suggestion until an action-bound human confirmation token is consumed.
- Unknown, ambiguous, unmatched, unresolved, stale-version, stale-readiness,
  warning-acknowledgement, ownership, auth, and expiry states fail closed.
- Retry expands selected failures to complete `document_group` rows, records an
  exact non-import acknowledgement, remains idempotent, and consumes zero
  additional credit.
- AI input cannot mutate accounting, master-data, or mapping-profile decisions;
  repair patches remain allowlisted and current-run only.
- MongoDB stores bounded metadata only. Owner-bound binary content remains in
  GridFS; response DTOs and audit logs drop workbook bytes and nested sensitive
  payloads.
- Retry export fills the real MISA workbook template rather than recreating its
  layout. Product-operation source: https://helpact.misa.vn/kb/html_10050000/
  (checked 2026-07-30).
- Issue and document-group cursors are independently exhausted with stalled
  cursor and maximum-page guards.

## TDD Evidence

RED was observed before production transplant: backend repair modules/routes,
converter parser/manifest modules, and frontend repair utilities/hooks were
missing. The focused suites failed on those exact missing contracts.

Final focused evidence:

```text
Backend repair gateway/models/security/retry:
102 passed, 0 failed, 3 skipped
  - 2 real-Mongo concurrency tests skipped because no Mongo test URI was configured
  - 1 backend/server.js sweeper-registration test deferred to Task 9

Converter parser/security/manifest/repair/matching:
62 passed, 3 deselected, 1 existing FastAPI on_event deprecation warning

Frontend importRepair/converter gateway utilities:
12 passed, 0 failed

Transplant canonical verifier:
pass; 1 reconstruction mount, 1 route module, 25 Mongoose model registrations

git diff --check:
pass
```

Raw receipts:

- `.artifacts/task-8-backend-green3.log`
- `.artifacts/task-8-converter-focused-final.log`
- `.artifacts/task-8-frontend-green2.log`
- `.artifacts/task-8-manifest-final.log`

## Deferred Shared Registrations

Per the Task 8 brief, `converter/app/main.py`, `backend/server.js`,
`frontend/src/pages/ConvertPage.jsx`, and frontend API files were not copied or
composed. Consequently, the converter HTTP endpoint portion reports 404/missing
handler until Task 9 registers the already-tested workflows. Playwright was
skipped because the repair panel is not mounted in `ConvertPage.jsx` before that
Task 9 composition; no runnable user journey exists in this Task 8 worktree.

## Manifest

All Task 8 touched/new paths have exactly one ownership rule. Two reviewed Task
7 model paths that were the remaining manifest failures were assigned their
existing compose ownership; no product code from Task 7 was changed.

## Concerns

- Task 9 must register converter import-result/readiness/export endpoints, start
  the repair sweeper, mount `MisaImportRepairPanel`, then run the full converter
  API suite and Playwright repair journey.
- Real MongoDB atomic confirmation/idempotency coverage remains environment
  dependent.
- FastAPI still emits the existing `on_event` deprecation warning.
