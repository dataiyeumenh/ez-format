# Task 13 Report - Progressive Production Promotion

Status: `BLOCKED`

## Scope

- Worktree: `E:\0. EXE2\ez-format-main-experimental-integration`
- Starting HEAD: `e05764be8bbed6c9ad2bcaa47f7fabc5665f9459`
- Plan task: Task 13, progressive feature enablement and exact-SHA production
  promotion.
- Modified: `docs/deployment/main-experimental-release-runbook.md`
- Created: `docs/qa/main-experimental-live-staging.md`
- Created: `.superpowers/sdd/task-13-report.md`
- Existing Student and `.superpowers/sdd/progress.md` working-tree changes were
  not edited or staged.

## Implemented documentation

- Exact service flag groups and fixed order for converter gateway, Smart
  Voucher, supported Student Assistant functions, six accounting-operation
  capabilities, and MISA import repair.
- Per-stage named owners plus owner, foreign-owner isolation, stale
  version/context, AI-offline, live Node API, restart, and evidence gates.
- Browser boundary: Vercel to Node `/api`; no direct browser-to-FastAPI or
  loopback production URL.
- MongoDB/GridFS artifact contract; no S3 or other object-storage provider.
- Exact post-merge staging-tested SHA requirement for Render converter, Render
  Node, Vercel, release QA, tag, and production deployment.
- Reverse-order feature rollback, exact emergency ref/SHA, conditional Mongo
  restore boundary, and a staging rollback-drill receipt.
- Feature inventory with `implemented`, `partial`, `removed`, `uncertain`, and
  separate `live-verified` status.
- Explicit `BLOCKED` decision and exact private inputs required to unblock.

## Contract findings

- Current backend example/code uses
  `CONVERTER_MONGODB_GRIDFS_BUCKET=conversion_artifacts`; the runbook uses that
  value.
- Current gateway startup code requires `MONGO_URI`,
  `CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb`, and a non-empty GridFS bucket.
- `CONVERTER_OBJECT_STORAGE_REQUIRED` is not consumed by the current code, so
  the runbook does not set it.
- Smart Voucher production state requires private TLS Redis; this is ephemeral
  reconstruction session state, not workbook artifact storage.
- Student grading/check-work remains excluded:
  `STUDENT_CHECK_WORK_ENABLED=false`; no Vite check-work flag is introduced.
- Accounting operation UI remains server-capability driven; no Vite operation
  force-enable flags are introduced.
- MISA repair has one Node enable flag and no separate converter/Vite flag.

## Validation evidence

```text
git diff --check -- docs/deployment/main-experimental-release-runbook.md docs/qa/main-experimental-live-staging.md
exit: 0
```

```text
target-doc browser URL scan
result: no localhost, loopback, VITE_PYTHON_API_URL assignment, or Vite converter/FastAPI URL assignment
```

```text
current env/code key validation
env_keys_checked=53
missing=none
task13_contract=pass
```

Repository has no `scripts/verify.ps1` or
`scripts/run-outcomes-grader.ps1`. The applicable release contract was run:

```text
npm run qa:main-integration
status: RELEASE_BLOCKED
exit: 2
missing: replica_mongo, gridfs, live_gateway
detail: PAYMENT_REPLICA_SET_TEST_URI is not set
detail: GRIDFS_INTEGRATION_TEST_URI is not set
detail: QA_EXPECT_LIVE=true is not set
```

Task 11 evidence also records absent real MISA Mongo execution because neither
`MISA_IMPORT_REPAIR_TEST_MONGO_URI` nor `MONGO_URI` was supplied to that gate.
No live tests were reclassified as pass.

## Release blockers

- No release/service/QA/accounting/DBA owners or approved change windows.
- No immutable post-merge staging-tested SHA or same-SHA service revisions.
- No Render/Vercel credentials, service/project IDs, HTTPS URLs, deployment
  revisions, or prior environment revisions.
- No Mongo backup/restore record.
- No replica payment, real MISA Mongo, or real GridFS evidence.
- No private QA identities, fixtures, live contract, or charge snapshots.
- No TLS Redis staging input for restart-safe Smart Voucher state.
- No flags-off live smoke, progressive live gates, or rollback drill.
- No approved AI endpoint/token if AI Explanation is included.

No live deployment, production promotion, rollback, database migration, or
database restore was attempted.

## Decision

`BLOCKED`: release-stopping live, backup, replica MongoDB, GridFS, identity,
service, and exact-SHA evidence is absent.
