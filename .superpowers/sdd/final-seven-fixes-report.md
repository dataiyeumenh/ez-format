# Final Seven Important Fixes - RED/GREEN Report

Date: 2026-07-17  
Scope: Accounting Student Assistant Phases 0-6 only; Phase 7 excluded.  
Git policy: no staging, commit, reset, checkout, or unrelated dirty-work cleanup performed.

## Result

All seven Important findings from `final-rereview-report.md` are fixed with regression coverage. AI scoring/severity/export boundaries remain unchanged, owner scope remains mandatory, workbook bytes remain temporary-only, and the existing converter suite passes.

## Fix 1 - Retained upload survives short context refresh

- Node now signs `retention_expires_at` into every student context. Session-issued tokens use the durable session `retentionExpiresAt`; direct short-lived tokens safely default the signed boundary to their own expiry.
- FastAPI verifies the signed future retention boundary and caps it at 24 hours.
- Temporary upload expiry is `min(signed retention boundary, configured upload retention)` rather than `min(context token expiry, configured retention)`.
- A refreshed valid context for the same session/user/owner/workspace can access the upload after the original token expiry, but never after signed retention.

RED:

```text
/mnt/c/nvm4w/nodejs/node.exe --test tests/studentSessions.test.js
Result: exit 1; 24 passed, 2 failed (missing signed retention claim/boundary validation).

PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_accounting_map.py tests/test_student_reports.py -q
Result: exit 1; retention regression failed because upload expiry equaled the original context exp.
```

GREEN:

```text
/mnt/c/nvm4w/nodejs/node.exe --test tests/studentSessions.test.js
Result: 26 passed, 0 failed.

PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py -q -k 'retention or survives_context_refresh or rate_limit or invalid_student_context_does_not_allocate'
Result: 4 passed, 54 deselected.
```

## Fix 2 - Stable validated student rate-limit buckets

- Student contexts are signature/scope/session validated before bucket allocation.
- Bucket identity is stable across token refresh: action + owner scope + session + user, never the raw token hash.
- Invalid arbitrary tokens and path-session mismatches do not allocate buckets.
- Existing environment limits, 15-minute window, cleanup behavior, and HTTP 429 response remain intact.

RED:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_accounting_map.py tests/test_student_reports.py -q
Result: refreshed token bypass returned 200 instead of 429; arbitrary invalid token left one bucket allocated.
```

GREEN: covered by the 4/4 focused command under Fix 1 and the 92/92 focused converter integration run below.

## Fix 3 - Student-owned Phase 3 attempt state

- The browser now owns a separate student work draft for mapping, classification, and edited preview cells.
- A new draft starts with no submitted mapping/classification and no edited cells, so the converter answer is not silently submitted against itself.
- Mapping selects, classification select, and editable bounded preview inputs populate the draft only through student interaction.
- Submission sanitizes source/target headers, scalar cell values, string lengths, and at most 25 rows before deterministic scoring.

RED:

```text
/mnt/c/nvm4w/nodejs/node.exe --test src/utils/studentAssistant.test.mjs
Result: exit 1; new presentation/submission behavior was missing.

/mnt/c/nvm4w/nodejs/node.exe --test --test-name-pattern='new student work draft' src/utils/studentAssistant.test.mjs
Result: exit 1; draft still submitted system mapping, classification, and preview totals.
```

GREEN:

```text
/mnt/c/nvm4w/nodejs/node.exe --test src/utils/studentAssistant.test.mjs
Result: 25 passed, 0 failed.
```

## Fix 4 - Decimal-safe reconciliation and student totals

- Added `parse_decimal` without a binary-float round trip.
- Student reconciliation and aggregate file questions use `Decimal` end-to-end.
- High-precision values such as `9007199254740993.0000000001` are preserved.
- Blank remains `None`/insufficient while textual or numeric zero remains a valid contributing value.

RED:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_accounting_map.py tests/test_student_reports.py -q
Result: reconciliation and query totals rounded to 9007199254740994.
```

GREEN:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_api.py -q -k 'high_precision or formula_and_hidden'
Result: 3 passed, 57 deselected.
```

## Fix 5 - Formula and hidden-row warnings in student analyze

- Student analyze inspects the temporary workbook using the existing structure inspector before building the overview.
- Formula cells and hidden rows/columns are returned as bounded structure metadata and merged into readiness as warning-only issues.
- Warning explanations include bounded source cell/row/column evidence plus deterministic rule evidence.
- Structural warnings do not change export gates or become business-rule blockers.
- Structure metadata stays in the temporary upload state/response; Mongo analysis sync remains sanitized metadata only.

RED:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_accounting_map.py tests/test_student_reports.py -q
Result: student overview had no workbook_structure and no formula/hidden warnings.
```

GREEN: covered by the 3/3 focused command under Fix 4.

## Fix 6 - Unresolved Accounting Map cannot be green

- An unresolved business event with no entries now returns `balanced=false`.
- Frontend presentation treats unresolved/empty maps as amber unresolved, not green balanced.
- Accounting Map issues are rendered visibly with warning/blocker treatment.

RED:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_accounting_map.py tests/test_student_reports.py -q
Result: unresolved empty map returned balanced=true.
```

GREEN:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_accounting_map.py -q
Result: 8 passed, 0 failed.

/mnt/c/nvm4w/nodejs/node.exe --test src/utils/studentAssistant.test.mjs
Result: unresolved/empty presentation regression passes within 25/25.
```

## Fix 7 - Internship metadata sanitized by default

- Report metadata always replaces the original filename with `student-workbook` plus a safe Excel extension.
- Original sheet names are replaced with `Worksheet`.
- Existing confidential-value scanner still rejects confidential activity/note/report content.

RED:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_accounting_map.py tests/test_student_reports.py -q
Result: confidential filename and worksheet metadata appeared verbatim in Markdown.
```

GREEN:

```text
PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_reports.py -q
Result: 5 passed, 0 failed.
```

## Integration And Full Verification

```text
/mnt/c/nvm4w/nodejs/node.exe --test tests/studentSessions.test.js tests/studentQuestions.test.js tests/studentAttempts.test.js tests/studentActivities.test.js tests/mappingProfiles.test.js
Result: 49 passed, 0 failed.

PYTHONPATH=. uv run --with-requirements requirements.txt pytest tests/test_student_context.py tests/test_student_api.py tests/test_student_reconciliation.py tests/test_student_queries.py tests/test_student_accounting_map.py tests/test_student_reports.py -q
Result: 92 passed, 0 failed.

/mnt/c/nvm4w/nodejs/npm test
Result: 48 passed, 0 failed.

/mnt/c/nvm4w/nodejs/node.exe --test tests/*.test.js
Result: 128 passed, 0 failed.

PYTHONPATH=. uv run --with-requirements requirements.txt pytest -q
Result: 327 passed, 0 failed, 7 environment/deprecation warnings.

/mnt/c/nvm4w/nodejs/npm run lint
Result: exit 0.

Native Windows Vite build with TEMP/TMP set to %LOCALAPPDATA%\Temp
Result: 2462 modules transformed; production build exit 0.

git diff --check -- <all touched paths>
Result: exit 0; no scoped whitespace errors.

rg -n '^(<<<<<<<|=======|>>>>>>>)' <all touched paths>
Result: no conflict markers.
```

The first Vite invocation from WSL failed because Windows Node inherited a WSL UNC temp path for Jiti. Re-running from Windows with native `%LOCALAPPDATA%\Temp` succeeded. Pytest emitted the existing Starlette/httpx deprecation warning and temporary-directory cleanup warnings; no tests failed.

## Changed Files

- `backend/services/conversionContextService.js`
- `backend/controllers/studentSessionController.js`
- `backend/tests/studentSessions.test.js`
- `converter/app/student_context.py`
- `converter/app/student_store.py`
- `converter/app/main.py`
- `converter/app/parsing.py`
- `converter/app/student_reconciliation.py`
- `converter/app/student_queries.py`
- `converter/app/student_workflow.py`
- `converter/app/student_explanations.py`
- `converter/app/student_accounting_map.py`
- `converter/app/student_reports.py`
- `converter/tests/test_student_context.py`
- `converter/tests/test_student_api.py`
- `converter/tests/test_student_reconciliation.py`
- `converter/tests/test_student_queries.py`
- `converter/tests/test_student_accounting_map.py`
- `converter/tests/test_student_reports.py`
- `frontend/src/utils/studentAssistant.js`
- `frontend/src/utils/studentAssistant.test.mjs`
- `frontend/src/components/student/StudentMappingTable.jsx`
- `frontend/src/components/student/CheckWorkPanel.jsx`
- `frontend/src/components/student/AccountingMapPanel.jsx`
- `frontend/src/pages/StudentAssistantPage.jsx`
- `.superpowers/sdd/final-seven-fixes-report.md`

## Preserved Invariants

- AI does not affect score, validation severity, or export gates.
- `owner_scope` remains non-empty and owner/session/workspace checks remain enforced.
- Raw workbook bytes remain in temporary converter upload storage only, not MongoDB.
- New formula/hidden warnings and all student file answers remain evidence-backed.
- Phase 7 remains excluded.
- Full converter/backend/frontend tests pass, including existing behavior with student flags disabled.
