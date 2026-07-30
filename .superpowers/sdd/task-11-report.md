# Task 11 Report - Extreme Local Release QA

Date: 2026-07-30
Worktree: E:\0. EXE2\ez-format-main-experimental-integration
Branch: codex/main-experimental-production-integration
Tested code/test/gate tree digest: aa710aa553655e78bba78d4587cccd8f86bb424ca69bad4a37238213d6497f66
Merge revision: bff29ca024cb0b4b7b4c814cce7af1372e65ef86

## Verdict

INCOMPLETE. Full local code QA passed with zero failures. Release is not certified and is not production-ready because replica MongoDB, real GridFS, and live gateway evidence are unavailable.

## Origin and Reconciliation

- git fetch origin: exit 0.
- Plan base: 8d1a9343dc98a8abb715fe7efc8df9adf65a10fa.
- Current origin/main: 2250102293021a54bcd1cf4fc8a7d6037e980524; origin moved.
- Merge-tree conflicts: backend/services/paymentStatusSync.js, backend/tests/coupons.test.js, frontend/src/App.jsx.
- Tracked merge result: docs/qa/task-11-command-results.json; local .artifacts output is optional provenance.
- Normal merge committed as bff29ca024cb0b4b7b4c814cce7af1372e65ef86; latest main payment/coupon contracts preserved.
- Experimental commit 2da3d8f6b4214304d331dc9e1f06e6ac28ccc50a is not an ancestor.
- Rollback ref: refs/heads/rollback/main-pre-task11-reconcile-20260730-203721 at 2250102293021a54bcd1cf4fc8a7d6037e980524.

## Machine Gate

- Release command: npm run qa:main-integration, exit 2, status RELEASE_BLOCKED, missing replica_mongo, gridfs, live_gateway.
- Local command: npm run qa:main-integration:local-incomplete, exit 0, status LOCAL_INCOMPLETE.
- The release gate is fail-closed. The local mode is explicitly non-release.

## Results

- Main contracts: backend 84 total, 75 passed, 0 failed, 9 replica skips; frontend payment contract 2 passed.
- Backend node --test: 407 total, 395 passed, 0 failed, 12 skipped.
- Converter pytest: 550 passed, 2 skipped, 0 failed, 1 deprecation warning, 170.24s.
- Frontend: 109 tests passed; lint exit 0 with 2 existing warnings; build exit 0 with Vite chunk-size warnings.
- Playwright: gateway UI 2 skipped; gateway API 1 skipped; MISA import repair 8 passed.
- npm run qa:fast: 9/9 steps passed.
- Conflict, frontend production URL, and forbidden object-storage scans: clean.
- No test/process exceeded the 10-minute stop limit.
- Evidence binds a deterministic tracked tree digest, not a self-referential HEAD SHA.
- Required evidence is tracked under docs/qa; validators do not depend on .artifacts.
- Digest hashing canonicalizes text to LF; durable evidence files enforce LF checkout.

## Skip Reasons

- 9 payment replica tests: PAYMENT_REPLICA_SET_TEST_URI absent.
- 2 real-Mongo MISA repair tests: MISA_IMPORT_REPAIR_TEST_MONGO_URI and MONGO_URI absent.
- 1 real GridFS test: GRIDFS_INTEGRATION_TEST_URI absent.
- 2 converter tests: performance requires RUN_ACCOUNTING_OPERATIONS_PERFORMANCE=1; export manifest skips when create_export_manifest is not composed.
- 3 live Playwright tests: QA_EXPECT_LIVE=true and live URLs/credentials/fixture absent.

## Preservation

Unrelated Student/progress changes remain unstaged. No S3/object-storage provider was added. No merge/rebase/cherry-pick was performed after the completed reconciliation. Fresh Task 11 summaries and receipts are intentionally owned; generated noise outside those files remains untouched.
