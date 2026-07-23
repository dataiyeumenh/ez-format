# Phase 2 Ask About This File Combined Report

**Status:** `DONE`

## Implemented

- Added deterministic Phase 2 question routing for all 12 planned intent families.
- Added a 67-question sales/purchase benchmark with evidence checks against the active sheet, source headers, worksheet row range and returned values.
- Enforced `no evidence => unsupported`; unknown deterministic questions return an explicit AI-unavailable state when optional AI is unavailable.
- Added owner/session/`ask`-scope bounded `POST /api/v1/student/sessions/{id}/questions`, gated by `STUDENT_FILE_QA_ENABLED=true` without weakening Phase 0/1 scopes.
- Added best-effort internal question event delivery. Mongo `StudentQuestionEvent` stores question text, answer type, evidence IDs/count and outcome only; it has no answer, evidence payload or raw-row fields.
- Added `/student` question suggestions, in-session history, loading/retry, supported/unsupported/AI-unavailable labels and evidence navigation carrying exact source row and field into the existing mapping/preview workspace.
- Fixed stale Phase 1 analyze locks with timestamped ownership, heartbeat and guarded reclaim after `STUDENT_ANALYZE_TIMEOUT_SECONDS` (default 120 seconds). Active heartbeating locks remain non-stealable.
- Preserved existing `ConvertPage`; no stage, commit, broad format or unrelated revert was performed.

## Focused Verification

All commands ran inside one hard `timeout 60s` batch and exited `0`:

- Converter: `9 passed, 28 deselected` for Phase 2 question/API and analyze-lock selections.
- Backend: `28 passed` across `studentQuestions.test.js` and `studentSessions.test.js`.
- Frontend utility: `11 passed` in `studentAssistant.test.mjs`.
- Frontend ESLint: passed for the five touched Phase 2 UI/hook/utility files.
- Benchmark fixture contains 67 cases and all 12 intent families; the benchmark test passed.

Observed non-failing warning: FastAPI TestClient emitted the existing Starlette/httpx deprecation warning.

## Concerns / Not Run

- Full Python/Node/frontend suites and `vite build` were intentionally not run after the user requested stopping hanging full checks and limiting validation to 60 seconds.
- No browser E2E/mobile interaction run was performed, so live evidence-chip scrolling/focus behavior is covered by utility logic and ESLint, not Playwright/browser QA.
- MVP aggregation is deterministic over direct numeric source columns. A target field produced only by a mapping formula/default can return `unsupported` instead of calculating from transformed preview rows.
- Optional AI classification/rephrasing is not implemented; deterministic behavior is complete without it, and unsupported unknown questions expose the AI-unavailable state.
- The worktree was already dirty with Phase 0/1 and unrelated changes. This implementation did not revert or stage them.

## Reviewer Remediation

All P1/P2 rejection items were addressed with regression tests before implementation:

1. **Mandatory active Node session:** added authenticated internal `GET /api/internal/student/sessions/:id/active`. It requires the converter service token and signed `ask` context, then validates session ID, user, owner scope, workspace and expiry/deletion state. Converter Q&A and exact source-row retrieval call this check before reading local upload state or executing a query. Node unavailable fails `503`; expired/deleted/missing sessions fail `410`; owner/workspace mismatch fails `403`. Question-event recording after a successful answer remains best-effort.
2. **Non-stealable stale lock:** heartbeat refresh and stale reclamation now acquire the same cross-process reclaim mutex. Reclaimer re-checks staleness while holding that mutex, then unlinks/recreates without an intervening heartbeat update. A deterministic interleaving test pauses after stale detection and proves the heartbeat cannot update between check and unlink.
3. **Zero evidence:** duplicate and VAT mismatch handlers now return explicit `unsupported/no_evidence` when readiness issues cannot produce valid bounded evidence; Pydantic validation no longer escapes as a `500`.
4. **Worksheet coordinates:** numeric `dòng N` references are interpreted as 1-based worksheet rows. Header rows and rows outside the active table return `unsupported/row_out_of_range`; valid worksheet rows are converted through `table.header_row_index`, and returned evidence preserves the exact requested worksheet row. Tests cover a header on worksheet row 2.
5. **Exact rows outside preview:** added owner/session/`ask`-bounded `GET /api/v1/student/sessions/{id}/source-rows/{worksheet_row}`. Evidence clicks fetch the exact source row even beyond the 25-row preview and render it in a dedicated Source Row panel with the exact evidence field highlighted.

## Reviewer Focused Results

Final bounded verification completed successfully before the stop request:

- Converter focused selection: `17 passed, 34 deselected` in 2.67 seconds.
- Node student question/session-active tests: `7 passed`.
- Frontend student utility/navigation tests: `13 passed`.
- ESLint for all touched Phase 2 frontend files, including `SourceRowPanel.jsx`: exit `0`.
- Existing non-failing warning remains: Starlette TestClient/httpx deprecation warning.

Per the final stop instruction, no additional full suite or frontend build was started. No files were staged or committed.
