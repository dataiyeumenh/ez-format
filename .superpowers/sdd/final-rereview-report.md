# Final Independent Re-review: Accounting Student Assistant Phase 0-6

Date: 2026-07-17  
Scope: Phase 0-6 only; Phase 7 excluded.  
Method: master spec, all phase plans, current dirty tree, focused/full automated tests, and targeted runtime probes. No implementation files were edited.

## Verdict

**NO-GO / not production-ready.** No Critical finding was found, but seven Important findings remain. Completion must be rejected until they are fixed and re-reviewed.

## Findings

### Important 1 - Retained sessions still lose their FastAPI upload when the first 10-minute context expires

- `backend/services/conversionContextService.js:108` creates student contexts with a default lifetime of 10 minutes.
- `backend/controllers/studentSessionController.js:456` retains the Mongo session for 24 hours, and `backend/controllers/studentSessionController.js:498` correctly allows the authenticated owner to refresh context without the old context.
- However, `converter/app/student_store.py:261` stores upload expiry as `min(claims.exp, now + ttl_seconds)`. Therefore the raw upload expires with the original 10-minute token, not with the retained session.
- `converter/app/student_store.py:284` and `converter/app/student_store.py:310` reject the upload after that timestamp. The frontend refresh/retry at `frontend/src/utils/studentAssistant.js:499` consequently retries with a fresh token against an already expired upload and receives 410.
- Runtime probe: requested retention `86400`, context TTL `600`, actual upload TTL `600`.

Impact: session resume works only within the first context lifetime despite the 24-hour retained-session contract.

### Important 2 - Student rate limits are reset by context refresh and can be bypassed

- Student endpoints call the limiter before their workflow validation, for example `converter/app/main.py:311` and `converter/app/main.py:471`.
- `converter/app/main.py:1142` builds the bucket key from a SHA-256 hash of the raw context token. A refreshed token creates a different bucket even for the same session.
- `backend/controllers/studentSessionController.js:498` allows an authenticated owner to mint a new context without the old token, so a client can refresh context and reset analyze/question/anonymization/report/export counters.
- Invalid arbitrary tokens also allocate distinct in-memory buckets before token verification, allowing avoidable bucket growth during the 15-minute window.
- Runtime probe confirmed that the same session with old/fresh context tokens produces different limiter keys.

Impact: the environment-configured controls return 429 in the covered test case, but they are not practical per-session controls under token refresh or hostile input.

### Important 3 - Phase 3 does not let a student submit their own work; the UI submits the system answer back to the server

- `frontend/src/components/student/StudentMappingTable.jsx:31` renders the mapping as inspection/select buttons; it has no editable mapping or edited-row state.
- `frontend/src/utils/studentAssistant.js:409` builds the attempt submission directly from `analysis.mapping_suggestion` and `analysis.student_preview`.
- `frontend/src/pages/StudentAssistantPage.jsx:399` submits that derived canonical state as the student's `mapping_attempt`.
- The server expected state is rebuilt from the same overview at `converter/app/student_workflow.py:1091`.

Impact: Check My Work evaluates the converter's current answer against itself instead of evaluating student mapping/data/classification work. This does not satisfy Phase 3's core goal or its "current mapping/edited rows" UI requirement.

### Important 4 - Phase 5 and file-question accounting totals are not Decimal-safe

- `converter/app/parsing.py:25` parses numeric text through binary `float`.
- `converter/app/student_reconciliation.py:365` calls that parser and only then converts the rounded float to `Decimal`.
- `converter/app/student_queries.py:326` uses the same float path for aggregate answers.
- Runtime probe: source `9007199254740993` became `9007199254740992` before reconciliation.

Impact: large or high-precision accounting values can produce incorrect totals, deltas, match/mismatch results, and file answers. This violates the program's deterministic Decimal invariant.

### Important 5 - Formula cells and hidden rows are not surfaced as student warnings

- The student analyze path calls the ordinary analyzer at `converter/app/student_workflow.py:97`.
- XLSX input is loaded with `data_only=True` at `converter/app/excel_io.py:160`, so formula identity is discarded while reading the active table.
- Formula/hidden-row inspection exists in `converter/app/document_structure.py:44`, but it is only invoked by reconstruction at `converter/app/reconstruction_workflow.py:96`; the student workflow never invokes or merges those warnings.

Impact: the explicit security/privacy invariant that formula cells and hidden rows remain visible as warnings is unmet. Students can review a workbook without being told that visible values came from formulas or that hidden data exists.

### Important 6 - Accounting Map can show an unresolved empty voucher as balanced and green

- `converter/app/student_accounting_map.py:118` handles an unresolved business event by returning no entries but `balanced=True` at `converter/app/student_accounting_map.py:131`.
- `frontend/src/components/student/AccountingMapPanel.jsx:44` renders every `balanced=true` map with the green success treatment and does not render `map.issues`.
- Runtime probe produced `{event_status: unresolved, entries: 0, balanced: True, issues: [business_event_unresolved]}`.

Impact: an unsupported accounting event can be presented as a successful Nợ/Có balance, and the warning explaining the unresolved event is hidden from the user.

### Important 7 - Internship reports can expose confidential file/sheet metadata

- `converter/app/student_workflow.py:373` sends the original filename and sheet name into the report.
- `converter/app/student_workflow.py:382` builds the scanner dictionary only from recognized confidential values in table cells.
- `converter/app/student_reports.py:38` renders file metadata directly, while `converter/app/student_reports.py:180` can reject only values present in the supplied scanner dictionary.

Impact: a company/customer name present only in a filename or worksheet name can enter the supposedly portfolio-safe report without being detected. This violates Phase 6's no-raw-confidential-values default.

## Prior Important Findings Re-check

1. Missing/unparseable required line amounts: **fixed for the covered resolved-voucher path**. `converter/app/student_accounting_map.py:138` records the condition, `converter/app/student_accounting_map.py:143` adds a blocker, and `converter/app/student_accounting_map.py:239` prevents `balanced=true`. Regression coverage exists at `converter/tests/test_student_accounting_map.py:188`.
2. Context refresh: **partially fixed, still failing end-to-end retention**. Node refresh and frontend retry are implemented, but Important 1 remains because FastAPI upload expiry is tied to the old token.
3. Resource controls: **partially implemented, still bypassable**. 20 MB chunked read, extension/magic checks, environment limits and 429 exist, but Important 2 prevents accepting the rate-limit requirement as complete.

## Verified Strengths

- Owner/session/workspace checks are consistently present across Node internal APIs, Mongo entities, FastAPI contexts, temporary uploads, and mapping profiles.
- Mongo student entities do not store workbook bytes/raw rows; FastAPI raw workbooks remain in temporary upload directories.
- Supported file-specific answers validate evidence IDs, active sheet, row bounds, fields and actual values.
- AI is not used to set scores or readiness severity, and AI-sourced defaults are marked for review.
- Anonymized workbook export creates a copy and scanner-gates recognized confidential values.
- Existing converter export gates remain server-side.

## Fresh Verification Evidence

- Focused converter student tests: `70 passed in 3.61s`.
- Full converter suite: `319 passed in 148.83s`.
- Full backend Node suite: `127 passed, 0 failed`.
- Frontend tests: `46 passed, 0 failed`.
- Frontend ESLint: exit 0.
- Frontend production build: exit 0.
- `git diff --check` reports trailing whitespace in generated QA artifacts (`docs/qa-last-run.json`, `docs/qa-log.md`); no merge conflict markers were found.

Passing tests do not override the Important spec/behavior gaps above; several current tests encode the incomplete behavior, especially the frontend test that explicitly reuses the current system mapping as the attempt submission.

