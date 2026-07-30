# Main Experimental Integration - Task 11 QA

Date: 2026-07-30
Worktree: `E:\0. EXE2\ez-format-main-experimental-integration`
Branch: `codex/main-experimental-production-integration`
QA starting HEAD: `c1669ea48c4ac4a156c23c089e2579ddcab5a2e0`

## Verdict

**INCOMPLETE: local code QA complete; live and real-Mongo gates remain unverified.**

This is not a production-ready certification. No merge, rebase, or cherry-pick was performed after the required `origin/main` drift was detected.

## Base Drift

Required plan base: `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`

Observed after `git fetch origin`:

- `origin/main`: `2250102293021a54bcd1cf4fc8a7d6037e980524`
- Base-to-origin divergence: `1` base-side commit, `6` origin-side commits.
- Origin delta: 7 files, 121 insertions, 35 deletions.
- `git merge-tree --messages HEAD origin/main` conflicts: `backend/services/paymentStatusSync.js`, `backend/tests/coupons.test.js`, `frontend/src/App.jsx`.
- No functional merge resolution attempted. Drift was reported before Task 11 functional work; Task 11 changes are test fixtures/contracts, the QA runner, and evidence documents only.

## Command Evidence

All commands below ran from the worktree. The final `npm run qa:main-integration` exit code was `0`.

| Command | Result |
|---|---|
| `npm run qa:main-contracts` | Backend: 83 tests, 74 passed, 0 failed, 9 skipped. Frontend payment contract: 2 passed. |
| `node --test` from `backend` | 402 tests, 391 passed, 0 failed, 11 skipped. |
| `python -m pytest -q --tb=short` from `converter` | 549 passed, 2 skipped, 1 warning; exit `0`; 166.92s in final gate run. |
| `npm test` from `frontend` | 109 passed, 0 failed. |
| `npm run lint` from `frontend` | Exit `0`. |
| `npm run build` from `frontend` | Exit `0`; Vite warning for 575 kB and 368 kB chunks. |
| Gateway UI Playwright suite | 2 skipped. |
| Gateway API Playwright suite | 1 skipped. |
| MISA import repair Playwright suite | 8 passed. |
| `npm run qa:fast` | `QA/QC PASSED (9 steps)`; latest repair evidence: `.artifacts/qa/misa-import-repair/20260730-202729`. |
| Conflict marker scan | Clean. |
| Frontend production URL scan | Clean; no direct FastAPI/localhost production URL hit in `frontend/src` production files. |
| Forbidden object-storage provider scan | Clean; no S3/R2/MinIO provider pattern in scanned source. MongoDB/GridFS remains the storage contract. |
| `git diff --check` | Known pre-existing generated QA whitespace only in `docs/qa-last-run.json` and `docs/qa-log.md`; preserved by instruction. |

## Explicit Skips and Gaps

- Payment replica-set tests: skipped because `PAYMENT_REPLICA_SET_TEST_URI` is not set. This covers nine main-contract tests and nine duplicate tests in the full backend run.
- Real Mongo MISA repair model tests: two skipped because `MISA_IMPORT_REPAIR_TEST_MONGO_URI` and `MONGO_URI` are not set.
- Converter performance benchmark: two pytest cases skipped because `RUN_ACCOUNTING_OPERATIONS_PERFORMANCE=1` is not set.
- Gateway UI Playwright: two tests skipped because `QA_EXPECT_LIVE=true` is not set; no live gateway URL or short-lived UI credentials were supplied.
- Gateway API Playwright: one test skipped for the same missing `QA_EXPECT_LIVE=true` live-stack prerequisite.
- Real staging Vercel -> Node -> converter journey: not run.
- Real MongoDB/GridFS artifact round-trip: not run; local GridFS adapter contract tests passed, but no live Mongo/GridFS environment was supplied.

## Regression Handling

The six initial converter failures were reproduced. They were stale test/setup contracts exposed by the operation-session and fail-closed export behavior, not production-code failures:

- Signed context helper was patched to validate real signed tokens after the analyze-only stub.
- Readiness/export fixtures now provide explicit safe sales defaults and mutate the trusted source workbook for blank-value coverage.
- Session export tests now distinguish missing server state from the automatic authenticated test context.
- Preview-edit export asserts client rows are ignored when a trusted operation session exists.
- Safe-default export expectations no longer infer unmapped `ĐVT` values.
- A fresh intermittent failure in `test_generated_purchase_workbooks_are_stable_and_readable` was reproduced: `docProps/core.xml` contained openpyxl's wall-clock modified timestamp. `converter/app/purchase_scenarios.py` now canonicalizes that timestamp; the focused test passed 20 consecutive runs.

Focused tests passed, then the full converter suite passed. The initial six fixes are test-contract/setup changes; the deterministic workbook timestamp required the production fix noted above.

## Release Decision

Local code and static QA evidence are green. Mandatory external gates are not green because the real replica Mongo/GridFS and live gateway environments are absent. Keep the release status **code-complete, live-unverified**. Do not claim production-ready until those gates execute against the same certified SHA.
