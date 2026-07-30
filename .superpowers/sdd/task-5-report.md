# Task 5 Report

## Status

Implemented the support-only Student Assistant vertical slice from exact source
`1a1d0e6971ccf5bd1140e676c63a5210a1111cbe` and composed it with the Task 4
gateway. Intended commit message: `feat: integrate feature-gated student assistant`.

## Implementation

- Transplanted the reviewed backend session/activity/question modules, converter
  `student_*` modules, frontend page/components/hook/utility, fixtures, and focused
  tests. A byte comparison confirmed 30 source-owned Student Assistant blobs match
  the exact source SHA.
- Kept `backend/server.js`, `converter/app/main.py`, and `frontend/src/App.jsx`
  composed. Main admin/coupon/payment routes remain intact.
- Mounted public and internal Student Assistant routes only when
  `STUDENT_ASSISTANT_ENABLED=true`. Student analyze/operation traffic uses the
  authenticated Node gateway and bounded in-memory upload forwarding; browser
  code does not call FastAPI directly.
- Frontend `/student` remains lazy. It requires both the Vite flag and the
  backend/converter capability response; unavailable or disabled states redirect
  without loading the page.
- Removed attempt, skill-progress, scoring, grading endpoints, grading flags, and
  grading UI. Removed readiness-score persistence from student metadata.
- Kept MongoDB student documents metadata-only. Tests reject raw rows, workbook
  bytes, full answer payloads, and non-owner access. Gateway request bodies are
  operation-specific allowlists.
- Added production startup validation: enabled Student Assistant requires
  `STUDENT_ANONYMIZATION_SECRET` with at least 32 characters, distinct from
  `CONVERSION_CONTEXT_SECRET` and `CONVERTER_SERVICE_TOKEN`. Disabled mode does
  not require this secret.
- Updated `docs/integration/main-experimental-transplant.yml` so every Task 5
  changed path has exactly one owner.

## TDD Evidence

Observed RED before implementation:

- Backend source tests failed on the attempt scope and public attempt route.
- Converter source tests failed on grading endpoints, missing reviewed
  anonymization APIs, and missing startup secret validation.
- Frontend source tests failed on missing support-only utility exports and the
  backend-capability gate.

All focused tests then passed after the minimal integration changes.

## Verification

```text
backend focused + preserved contracts:
node --test tests/studentActivities.test.js tests/studentQuestions.test.js tests/studentSessions.test.js tests/converterGatewayStartup.test.js tests/conversionArtifacts.test.js tests/mongoGridFsArtifactStorage.test.js tests/internalConverterSessions.test.js tests/serverStartupReadiness.test.js tests/paymentSettlementReadiness.test.js tests/coupons.test.js tests/adminContracts.test.js
87 passed, 0 failed

converter focused:
python -m pytest -q tests/test_student_accounting_map.py tests/test_student_anonymization.py tests/test_student_api.py tests/test_student_context.py tests/test_student_explanations.py tests/test_student_queries.py tests/test_student_reconciliation.py tests/test_student_reports.py
133 passed, 0 failed, 1 FastAPI on_event deprecation warning

frontend focused:
node --test src/utils/studentAssistant.test.mjs
25 passed, 0 failed
npm run build
passed
npm run lint
passed

additional checks:
git diff --check
passed
Student route mount probe: disabled=false, enabled=true
Support-only static audit: no grading/attempt/score symbols
Task 5 ownership check: 41 changed paths singly owned
Exact-source check: 30 source-owned student blobs matched
```

## Concerns

- No live MongoDB/GridFS plus Node-to-converter deployment was available for an
  end-to-end Student Assistant request. Task 4 GridFS/payment/gateway regressions
  pass, but staging still needs the live round trip.
- `student_queries.py` contains a scoped document-total fallback because shared
  `document_totals.py` belongs to Task 6. Task 6 should replace the fallback with
  the shared source module.
- The repo-wide ownership verifier still reports 48 pre-existing unowned Task
  3/4 integration paths. All Task 5 paths have exactly one owner; unrelated prior
  ownership decisions were not guessed in this task.
- `useVoucherReconstruction.js` temporarily owns its gateway error wrapper so the
  required frontend build passes before the shared `converterOperations.js` task.

## Reviewer Findings Closure (2026-07-30)

All six Task 5 reviewer findings were reproduced with failing tests before the
fixes:

- Anonymized `.xlsx` exports now rebuild from sanitized visible cell output.
  Hidden sheets, comments, hyperlinks, names, custom/core metadata, drawings and
  other unclassified workbook layers are not copied. External links and embedded
  binary objects fail closed. The scanner inspects every exported cell and OOXML
  text part before `scanner_status=passed` is returned.
- `student-overview.json` now stores only schema, counts, state hashes and generic
  labels. Raw preview/mapped rows remain ephemeral in the response. Student upload
  JSON also uses generic file and sheet labels.
- Question events now persist SHA-256, length, deterministic intent category,
  operation and bounded evidence metadata. Raw questions and answers remain
  ephemeral. Startup purges legacy raw question/answer/row/workbook fields through
  the native Mongo collection API, avoiding strict-schema migration loss.
- Desktop and mobile Student links now use the Vite gate plus live backend
  capability. `/student` remains a lazy production chunk. Rendered Navbar and hook
  integration tests cover disabled/enabled matrices.
- Root and converter environment examples document the dedicated 32+ character
  anonymization secret and required distinctness.
- Student gateway operations now use eight explicit route/method pairs; the
  wildcard GET/POST operation route was removed.

Fresh focused verification after remediation:

```text
backend Task 5 + startup: 52 passed, 0 failed
converter Task 5: 135 passed, 0 failed, 1 existing FastAPI deprecation warning
frontend student utility: 25 passed, 0 failed
frontend rendered/integration: 4 passed, 0 failed
frontend build: passed; StudentAssistantPage remains a separate lazy chunk
frontend lint: passed
git diff --check: passed
ownership verifier: all new/reviewed Task 5 paths singly owned; 48 pre-existing
  Task 3/4 unowned paths remain unchanged
```
