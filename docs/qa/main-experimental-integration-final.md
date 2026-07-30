# Main Experimental Integration - Task 11 QA

Date: 2026-07-30
Worktree: E:\0. EXE2\ez-format-main-experimental-integration
Branch: codex/main-experimental-production-integration
Tested code/test/gate tree digest: e9882edd90044b643e5e5a0d75dd646017fa7be522563292d6659142f09d8578
Merge revision: bff29ca024cb0b4b7b4c814cce7af1372e65ef86

## Verdict

**INCOMPLETE**

Local code QA completed with zero executable test failures. Release certification is incomplete. Do not claim production-ready: mandatory replica MongoDB, real MongoDB/GridFS, and live gateway evidence are absent.

## Origin Drift and Merge Evidence

Task 11 started with git fetch origin exit 0.

- Plan base: 8d1a9343dc98a8abb715fe7efc8df9adf65a10fa.
- Refreshed origin/main: 2250102293021a54bcd1cf4fc8a7d6037e980524.
- Remote drift: 7 files, 121 insertions, 35 deletions from the plan base.
- Pre-merge git merge-tree --write-tree reported known conflicts in backend/services/paymentStatusSync.js, backend/tests/coupons.test.js, and frontend/src/App.jsx.
- Tracked merge result: docs/qa/task-11-command-results.json. The local .artifacts merge-tree log is optional provenance only.
- Normal merge commit: bff29ca024cb0b4b7b4c814cce7af1372e65ef86; parents are the integrated branch parent and refreshed origin/main.
- Conflict resolution preserved latest main payment/coupon contracts while retaining integrated transactional settlement, idempotency coverage, and feature-gated Student routing.
- Experimental commit 2da3d8f6b4214304d331dc9e1f06e6ac28ccc50a is not an ancestor.
- No merge, rebase, cherry-pick, reset, or checkout-destructive command was used during this rerun.

Rollback ref pushed before reconciliation:

refs/heads/rollback/main-pre-task11-reconcile-20260730-203721 at 2250102293021a54bcd1cf4fc8a7d6037e980524.

## Release Gate Modes

- npm run qa:main-integration: exit 2. Machine status: RELEASE_BLOCKED; missing replica_mongo, gridfs, live_gateway.
- npm run qa:main-integration:local-incomplete: exit 0. Machine status: LOCAL_INCOMPLETE; runs the local code matrix only and cannot certify release.
- npm run qa:main-integration:local-incomplete sets REQUIRE_REPLICA_TESTS off only for explicit local skip reporting. Release mode fails before the matrix when mandatory evidence is missing.

## Full Local Matrix

The local-incomplete matrix is historical command evidence. Current focused checks bind the tracked code/test/gate files to the deterministic digest above. Evidence-only commits may change HEAD without changing or weakening that digest.

| Command | Result |
|---|---|
| npm run qa:main-contracts | 84 total; 75 passed; 0 failed; 9 replica skips. Frontend payment contract: 2 passed. |
| Backend node --test | 407 total; 395 passed; 0 failed; 12 skipped. |
| Converter python -m pytest -q --tb=short | 550 passed; 2 skipped; 0 failed; 1 FastAPI deprecation warning; 170.24s. |
| Frontend npm test | 109 passed; 0 failed; 0 skipped. |
| Frontend npm run lint | Exit 0; 2 existing warnings in frontend/src/pages/admin/RevenuePage.jsx. |
| Frontend npm run build | Exit 0; 2 Vite chunk-size warnings (575 kB and 368 kB chunks). |
| Playwright gateway UI | 2 skipped; QA_EXPECT_LIVE=true and live inputs absent. |
| Playwright gateway API | 1 skipped; QA_EXPECT_LIVE=true and live inputs absent. |
| Playwright MISA import repair | 8 passed in 20.1s. |
| npm run qa:fast | QA/QC PASSED (9 steps); generated summary refreshed. |
| Conflict markers / frontend URL / object-storage scans | Clean. |
| git diff --check during matrix | Only preserved generated QA summary whitespace was reported; canonical final files were normalized afterward. |

## Exact Skips and Gaps

- Backend: 9 payment settlement tests skipped because PAYMENT_REPLICA_SET_TEST_URI is not set; 2 real-Mongo MISA repair tests skipped because neither MISA_IMPORT_REPAIR_TEST_MONGO_URI nor MONGO_URI is set; 1 GridFS integration test skipped because GRIDFS_INTEGRATION_TEST_URI is not set.
- Converter: 2 explicit skips. The performance benchmark requires RUN_ACCOUNTING_OPERATIONS_PERFORMANCE=1; the export-manifest test skips when create_export_manifest is not composed by the Task 9 converter app.
- Playwright live suites require QA_EXPECT_LIVE=true, QA_FRONTEND_URL, QA_GATEWAY_URL, QA_CONVERTER_URL, owner credentials/JWT, release ID, and an existing QA_RAW_FIXTURE.
- No real replica MongoDB, real GridFS round-trip, live gateway UI journey, or live gateway API journey ran. These are release blockers, not PASS results.
- No S3, R2, MinIO, or other object-storage provider was introduced; the scanned storage contract remains MongoDB/GridFS.

## Evidence Validation

- Machine-readable evidence: docs/qa/task-11-evidence.json.
- Tracked command/results: docs/qa/task-11-command-results.json.
- Tracked tree manifest: docs/qa/task-11-code-tree.manifest.json.
- Binding validator: pwsh -NoProfile -File scripts/validate-task11-evidence.ps1 -RepositoryRoot .
- Schema validator: pwsh $HOME/.agents/skills/extreme-qa-qc/scripts/qa-evidence.ps1 validate docs/qa/task-11-evidence.json --root . --json.
- Both validators must pass without .artifacts; no exact HEAD SHA is asserted.
- Tree hashing canonicalizes CRLF to LF; .gitattributes pins byte-addressed Task 11 evidence to LF.
- Focused guard suite adds exact release exit-code 2 assertions plus temporary-clone code/evidence mutation rejection; no external artifact is required.

## Task 11 Ownership

Task 11 substantive changes:

- scripts/qa-main-integration.ps1
- scripts/qa-main-integration-status.ps1
- package.json
- backend/.env.example
- backend/tests/mainIntegrationReleaseGate.test.js
- backend/tests/mongoGridFsArtifactStorage.integration.test.js
- backend/tests/releaseReplicaGate.test.js
- backend/tests/task11EvidenceBinding.test.js
- converter/tests/test_e2e_extreme.py
- converter/tests/test_stress_999.py
- docs/qa/main-first-integration-baseline.md
- scripts/validate-task11-evidence.ps1
- docs/qa/task-11-code-tree.manifest.json
- docs/qa/task-11-command-results.json
- Fresh Task 11 receipt and generated QA summaries.

Unrelated .superpowers/sdd/progress.md, Student EOL changes, and existing Student/QA noise remain unstaged.
