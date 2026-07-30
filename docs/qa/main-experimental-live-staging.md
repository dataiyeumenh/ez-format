# Main Experimental Live Staging Receipt

Status: `BLOCKED`

No live staging deployment or rollback drill was performed for Task 13.
Credentials, service URLs, backup evidence, replica MongoDB evidence, real
MongoDB/GridFS evidence, and live gateway inputs were not supplied. Unchecked
items are required work, not implied passes.

## Receipt identity

Complete this header in the private release record. Keep secrets and private
URLs out of Git.

```text
release_id: PENDING
integration_source_sha: e05764be8bbed6c9ad2bcaa47f7fabc5665f9459
staging_tested_sha: PENDING
release_tag: PENDING
release_owner: PENDING
render_owner: PENDING
vercel_owner: PENDING
qa_owner: PENDING
accounting_owner: PENDING
dba: PENDING
window_start_utc: PENDING
window_end_utc: PENDING
render_converter_service_id: PENDING_PRIVATE
render_converter_revision: PENDING_PRIVATE
render_node_service_id: PENDING_PRIVATE
render_node_revision: PENDING_PRIVATE
vercel_project_environment: PENDING_PRIVATE
vercel_deployment_id: PENDING_PRIVATE
mongo_backup_record: PENDING_PRIVATE
```

`staging_tested_sha` must be the full post-merge commit deployed by both Render
services and Vercel. Do not replace `PENDING` until deployment metadata proves
the exact value.

## Release-stopping inputs

All are currently absent:

- [ ] Named release, service, QA, accounting, security, and DBA owners.
- [ ] Immutable post-merge full candidate SHA.
- [ ] Render access, converter/Node service IDs, HTTPS URLs, current and prior
      environment revisions, and deployed commit metadata.
- [ ] Vercel access, project/environment, HTTPS domain, deployment ID, current
      and prior build-variable revisions, and deployed commit metadata.
- [ ] Private secret references for Mongo, inter-service authentication,
      Student anonymization, QA owner/foreign identities, and fixtures.
- [ ] Successful Mongo backup record: cluster, database, UTC timestamp, method,
      backup ID/private archive, validation, exact private restore command,
      restore target, and DBA approval.
- [ ] Replica Mongo payment evidence from `PAYMENT_REPLICA_SET_TEST_URI` with no
      payment settlement skips.
- [ ] Real MISA Mongo evidence from `MISA_IMPORT_REPAIR_TEST_MONGO_URI` or the
      approved private `MONGO_URI` with no MISA repair Mongo skips.
- [ ] Real GridFS round-trip evidence from `GRIDFS_INTEGRATION_TEST_URI` with no
      GridFS integration skip.
- [ ] Private TLS Redis service/reference for restart-safe Smart Voucher state.
- [ ] `QA_EXPECT_LIVE=true`, `QA_FRONTEND_URL`, `QA_GATEWAY_URL`,
      `QA_CONVERTER_URL`, release ID, owner/foreign auth inputs, approved raw
      fixture, live contract, and charge-audit snapshots.
- [ ] Approved HTTPS AI endpoint/token if AI Explanation is in release scope;
      otherwise its flags remain false.

No S3 or other object-storage input is required or permitted. MongoDB/GridFS is
the artifact storage boundary.

## Evidence rules

- Record evidence in the private release system; this tracked receipt records
  only status and private evidence references.
- Record full service SHA, environment revision, request ID, redacted response,
  output hash/count, operator, and UTC timestamp for every gate.
- Never record passwords, JWTs, service tokens, Mongo/Redis URLs, AI tokens,
  raw workbook bytes, raw cells, customer names, tax IDs, or payment secrets.
- Use two short-lived QA identities: an owner and an unrelated foreign user.
  Use an approved disposable workspace/database and non-customer fixtures.
- Browser traffic must use the Vercel origin and Node `/api` only. Any browser
  request to FastAPI fails the release.
- All staging URLs must be HTTPS and non-loopback.
- `SKIPPED`, `INCOMPLETE`, missing evidence, or an intercepted/mock-only journey
  is a failure for release promotion.

## Flags-off baseline

Owner: release owner coordinates; Render/Vercel owners deploy; QA owner tests;
DBA confirms backup.

```text
environment_revision_before: PENDING_PRIVATE
environment_revision_after: PENDING_PRIVATE
converter_deployed_sha: PENDING
node_deployed_sha: PENDING
vercel_deployed_sha: PENDING
evidence_reference: PENDING_PRIVATE
```

- [ ] Mongo backup completed and validated before first integrated Node start.
- [ ] Converter `/healthz` returns HTTP `200` and `status: "ok"`.
- [ ] Node `/api/health` returns HTTP `200` and `status: "OK"` with gateway and
      Student capability false.
- [ ] Both Render services and Vercel report the same full SHA.
- [ ] Browser API traffic reaches Node only.
- [ ] Login, Google login when configured, ban handling, admin, plans, revenue,
      files, pricing, coupon, PayOS callback status, and navigation pass.
- [ ] Every new converter, voucher, Student, accounting-operation, and MISA
      repair surface is hidden or rejects access.
- [ ] Logs/evidence contain no secret or raw workbook data.

Result: `PENDING`

## Stage 1 - Converter gateway

Flag owner: Render owner. Gate owner: QA owner. Storage approver: DBA.

```env
CONVERTER_PUBLIC_PROXY_ENABLED=true
CONVERTER_GATEWAY_USAGE_READY=true
CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb
CONVERTER_MONGODB_GRIDFS_BUCKET=conversion_artifacts
```

```text
node_environment_revision: PENDING_PRIVATE
gridfs_test_evidence: PENDING_PRIVATE
gateway_summary: PENDING_PRIVATE
restart_evidence: PENDING_PRIVATE
```

| Gate | Required live result | Status | Evidence |
|---|---|---|---|
| Owner | Owner upload -> mapping -> readiness -> preview -> acknowledged real MISA export succeeds. | `PENDING` | `PENDING_PRIVATE` |
| Isolation | Foreign identity cannot access owner run/upload/profile/session/artifact. | `PENDING` | `PENDING_PRIVATE` |
| Stale state | Prior session `revision`/`state_hash` conflicts; no export, artifact, or charge is written. | `PENDING` | `PENDING_PRIVATE` |
| AI offline | `AI_PROVIDER=disabled`, `AI_REQUIRED=false`; deterministic mapping/validation/export remains usable. | `PENDING` | `PENDING_PRIVATE` |
| Live API | Browser covers Node `/api/converter`; release summary is `pass`, `release_eligible=true`, zero skips/failures. | `PENDING` | `PENDING_PRIVATE` |
| Restart | Disposable in-flight restart resumes valid owner state or reports expiry/unavailable, never corrupt success. | `PENDING` | `PENDING_PRIVATE` |

Result: `PENDING`

## Stage 2 - Smart Voucher

Flag owners: Render and Vercel owners. Gate owners: QA and accounting owners.

Converter group:

```env
VOUCHER_RECONSTRUCTION_ENABLED=true
RECONSTRUCTION_SHADOW_MODE=true
RECONSTRUCTION_STORE_PROVIDER=redis
RECONSTRUCTION_REDIS_URL=<private-rediss-url>
RECONSTRUCTION_REDIS_PREFIX=ezformat:production:reconstruction
RECONSTRUCTION_ENVIRONMENT=production
RECONSTRUCTION_STORE_TTL_HOURS=24
AI_PROVIDER=disabled
AI_REQUIRED=false
```

Node group:

```env
MASTER_DATA_WORKSPACES_ENABLED=true
VOUCHER_RECONSTRUCTION_ENABLED=true
RECONSTRUCTION_SHADOW_MODE=true
RECONSTRUCTION_BETA_WORKSPACE_IDS=<approved-staging-workspace-objectids>
```

Vercel group:

```env
VITE_MASTER_DATA_WORKSPACES_ENABLED=true
VITE_VOUCHER_RECONSTRUCTION_ENABLED=true
```

```text
converter_environment_revision: PENDING_PRIVATE
node_environment_revision: PENDING_PRIVATE
vercel_deployment_id: PENDING_PRIVATE
redis_restart_evidence: PENDING_PRIVATE
shadow_exit_revisions: PENDING_PRIVATE
```

| Gate | Required live result | Status | Evidence |
|---|---|---|---|
| Owner | Approved beta owner validates goods, service, mixed rows/documents/totals and row conservation. | `PENDING` | `PENDING_PRIVATE` |
| Isolation | Foreign user/workspace cannot list/read/edit/validate/approve/export/activate owner state. | `PENDING` | `PENDING_PRIVATE` |
| Stale version | Prior draft `expected_revision` and obsolete profile state conflict without mutation. | `PENDING` | `PENDING_PRIVATE` |
| AI offline | Deterministic reconstruction/manual review works; UI reports AI unavailable truthfully. | `PENDING` | `PENDING_PRIVATE` |
| Live API | Browser uses Node `/api/reconstructions`; shadow export rejects while traditional mapping export remains usable. | `PENDING` | `PENDING_PRIVATE` |
| Restart | Owner draft resumes after converter restart from TLS Redis; foreign owner remains denied. | `PENDING` | `PENDING_PRIVATE` |
| Shadow exit | Converter then Node set `RECONSTRUCTION_SHADOW_MODE=false`; one approved fixture export matches accounting evidence. | `PENDING` | `PENDING_PRIVATE` |

Result: `PENDING`

## Stage 3 - Student Assistant

Secret owner: security/release owner. Flag owners: Render and Vercel owners.
Gate owner: QA owner.

Converter group:

```env
STUDENT_ANONYMIZATION_SECRET=<private-distinct-secret-at-least-32-characters>
STUDENT_ASSISTANT_ENABLED=true
STUDENT_FILE_EXPLAIN_ENABLED=true
STUDENT_FILE_QA_ENABLED=true
STUDENT_ACCOUNTING_MAP_ENABLED=true
STUDENT_RECONCILIATION_ENABLED=true
STUDENT_INTERNSHIP_ENABLED=true
AI_PROVIDER=disabled
AI_REQUIRED=false
```

Node group:

```env
STUDENT_ASSISTANT_ENABLED=true
STUDENT_FILE_EXPLAIN_ENABLED=true
STUDENT_FILE_QA_ENABLED=true
STUDENT_CHECK_WORK_ENABLED=false
STUDENT_ACCOUNTING_MAP_ENABLED=true
STUDENT_RECONCILIATION_ENABLED=true
STUDENT_INTERNSHIP_ENABLED=true
```

Vercel group:

```env
VITE_STUDENT_ASSISTANT_ENABLED=true
VITE_STUDENT_FILE_EXPLAIN_ENABLED=true
VITE_STUDENT_FILE_QA_ENABLED=true
VITE_STUDENT_ACCOUNTING_MAP_ENABLED=true
VITE_STUDENT_RECONCILIATION_ENABLED=true
VITE_STUDENT_INTERNSHIP_ENABLED=true
```

```text
anonymization_secret_reference: PENDING_PRIVATE
converter_environment_revision: PENDING_PRIVATE
node_environment_revision: PENDING_PRIVATE
vercel_deployment_id: PENDING_PRIVATE
```

| Gate | Required live result | Status | Evidence |
|---|---|---|---|
| Owner | Owner completes explanation, questions, accounting map, reconciliation, anonymization, internship report. | `PENDING` | `PENDING_PRIVATE` |
| Isolation | Foreign identity cannot access owner session/context/source/activity/output. | `PENDING` | `PENDING_PRIVATE` |
| Stale context | Changed source/mapping invalidates prior signature/context; refreshed context stays owner/session bound. | `PENDING` | `PENDING_PRIVATE` |
| AI offline | Deterministic evidence/map/reconciliation/anonymization/report works; AI-only question is bounded, not fabricated. | `PENDING` | `PENDING_PRIVATE` |
| Live API | Browser uses Node `/api/student`; capability intersection and desktop/mobile states pass. | `PENDING` | `PENDING_PRIVATE` |
| Removed scope | Check-work stays false; no Vite flag/grading UI is exposed and supported flows create no attempt/score state. | `PENDING` | `PENDING_PRIVATE` |
| Privacy | Dedicated secret is distinct; evidence/logs contain no raw cells or reversible PII. | `PENDING` | `PENDING_PRIVATE` |

Result: `PENDING`

## Stage 4 - Accounting operations

Flag owner: Render owner. Gate owner: QA owner. Approval owner: independent
accounting reviewer. Set each flag on converter, then Node. No Vite flag may
force-enable an operation.

| Order | Capability/flag | Owner isolation | Stale version/state | AI offline | Live Node API | Status/evidence |
|---:|---|---|---|---|---|---|
| 1 | Mapping Profile V2: `FEATURE_MAPPING_PROFILE_V2=true` | Foreign scope cannot access profile/history/export. | Obsolete `expected_version`/`state_hash` rejected; no mutation. | Deterministic matching/confirm/export works. | `/api/mapping-profiles/v2` | `PENDING` / `PENDING_PRIVATE` |
| 2 | Anomaly Detection: `FEATURE_ANOMALY_DETECTION=true` | Foreign scope cannot access session/findings. | Prior session revision/hash rejected. | Deterministic findings work. | `/api/converter/sessions` | `PENDING` / `PENDING_PRIVATE` |
| 3 | Bulk Correction: `FEATURE_BULK_CORRECTION=true` | Foreign scope cannot simulate/apply/undo. | Prior session revision/hash rejected; history unchanged. | Deterministic simulate/apply/undo works. | `/api/converter/sessions` | `PENDING` / `PENDING_PRIVATE` |
| 4 | Reconciliation: `FEATURE_RECONCILIATION=true` | Foreign scope cannot access files/results. | Prior revision/hash or comparison binding rejected. | Deterministic reconciliation works. | `/api/converter/sessions` | `PENDING` / `PENDING_PRIVATE` |
| 5 | Accounting Assistant: `FEATURE_ACCOUNTING_ASSISTANT=true` | Foreign scope cannot access commands/state. | Prior revision/hash rejected; no mutation. | AI-only action bounded; deterministic state remains. | `/api/converter/sessions` | `PENDING` / `PENDING_PRIVATE` |
| 6 | AI Explanation: `FEATURE_AI_EXPLANATION=true` | Foreign scope cannot access explanation/state. | Obsolete session/profile explanation rejected. | No fabricated explanation; deterministic operations remain. | `/api/converter/sessions` | `PENDING` / `PENDING_PRIVATE` |

Shared requirements:

- [ ] `MAPPING_PROFILE_V2_MIGRATION_MODE=off` throughout feature enablement.
- [ ] Three consecutive `npm run qa:accounting-operations` release-eligible
      passes, zero skips/failures.
- [ ] Independent `ke-toan` report: `PASS`, zero P0/P1,
      `implementation_involvement: none`.
- [ ] 10k/50k budgets, real MISA template fidelity, desktop/mobile UI,
      privacy-canary, timeout, invalid JSON, and offline fallback pass.
- [ ] If live AI provider inputs are absent, `FEATURE_AI_EXPLANATION=false` and
      AI Explanation remains `partial`, not live-verified.

Result: `PENDING`

## Stage 5 - MISA import repair

Flag owner: Render owner. Gate owners: QA and accounting owners.

```env
MISA_IMPORT_REPAIR_ENABLED=true
```

```text
node_environment_revision: PENDING_PRIVATE
real_mongo_evidence: PENDING_PRIVATE
misa_fixture_hashes: PENDING_PRIVATE
charge_audit_before_after: PENDING_PRIVATE
```

| Gate | Required live result | Status | Evidence |
|---|---|---|---|
| Owner | Owner covers purchase, sales, multiline, warning, ambiguous, and unknown cases. | `PENDING` | `PENDING_PRIVATE` |
| Isolation | Foreign identity cannot access repair/issues/confirmation/groups/retry/download/artifact/audit. | `PENDING` | `PENDING_PRIVATE` |
| Stale version | Prior `expected_version` returns `409`; no state, artifact, retry, or credit mutation. | `PENDING` | `PENDING_PRIVATE` |
| AI offline | Deterministic schema/readiness/blockers/warnings/confirmation/retry/export works. | `PENDING` | `PENDING_PRIVATE` |
| Live API | Browser uses Node `/api/converter/import-repairs`; real templates and whole-group retry pass. | `PENDING` | `PENDING_PRIVATE` |
| Manual safety | `manual_excel_v1`, `verified=false`; ambiguous/unknown blocked until human confirmation. | `PENDING` | `PENDING_PRIVATE` |
| Billing | Retry/re-download consumes zero additional credit; fresh snapshots bind counts and artifact ID. | `PENDING` | `PENDING_PRIVATE` |

Result: `PENDING`

## Rollback drill receipt

Owner: release owner. Executors: Render/Vercel owners. Validator: QA owner. DBA
participates only if confirmed data/index damage requires restore review.

```text
trigger_stage: PENDING
trigger_time_utc: PENDING
detection_seconds: PENDING
decision_seconds: PENDING
flags_off_seconds: PENDING
core_recovery_seconds: PENDING
rollback_ref_verified_sha: PENDING
database_restore_used: PENDING
evidence_reference: PENDING_PRIVATE
```

- [ ] Controlled non-customer failure detected and recorded.
- [ ] Current stage disabled; prior environment/build revisions restored.
- [ ] Reverse-order all-flags-off path rehearsed.
- [ ] Core health, auth, admin, pricing, coupon, PayOS callback status, and
      navigation pass.
- [ ] Emergency ref resolves exactly to
      `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
- [ ] Emergency SHA redeploy path tested if flags-off was insufficient.
- [ ] Mongo restore not used, or confirmed damage plus new snapshot and DBA/
      release-owner approvals are recorded.
- [ ] No direct browser-to-FastAPI request; no secret/raw workbook in evidence.

Result: `PENDING`

## Exact-SHA promotion attestation

```text
staging_tested_sha: PENDING
release_qa_status: PENDING
release_qa_release_eligible: PENDING
release_qa_missing: PENDING
release_qa_exit_code: PENDING
release_qa_failed_checks: PENDING
release_qa_skipped_checks: PENDING
converter_staging_sha: PENDING
node_staging_sha: PENDING
vercel_staging_sha: PENDING
rollback_drill_result: PENDING
release_tag: PENDING
converter_production_sha: PENDING
node_production_sha: PENDING
vercel_production_sha: PENDING
approved_by: PENDING
approved_at_utc: PENDING
```

- [ ] `npm run qa:main-integration` reports `RELEASE_READY`, exit `0`, zero
      mandatory skips, `releaseEligible=true`, `missing=[]`, bound to
      `staging_tested_sha`.
- [ ] The machine JSON status is the literal `RELEASE_READY`; no alternate
      success token is accepted.
- [ ] Missing/invalid release evidence returns literal `RELEASE_BLOCKED`, exit
      `2`; it never returns a promotable result.
- [ ] `-Mode LocalIncomplete` remains literal `LOCAL_INCOMPLETE`, exit `0`,
      `releaseEligible=false`, and cannot satisfy this attestation.
- [ ] Flags-off plus Stages 1-5 all pass on `staging_tested_sha`.
- [ ] Rollback drill passes on `staging_tested_sha`.
- [ ] Release tag points exactly to `staging_tested_sha`.
- [ ] Every production service selects exactly `staging_tested_sha`.
- [ ] No commit, generated asset, lockfile, or frontend build-input change exists
      after staging certification.

Promotion result: `BLOCKED`

## Feature inventory disposition

The operational inventory is in
`docs/deployment/main-experimental-release-runbook.md`. Current dispositions are
`implemented`, `partial`, `removed`, and `uncertain`; no row is
`live-verified`. Update a row to `live-verified` only after its exact-SHA gate
above passes with a private evidence reference.

## Final decision

`BLOCKED`

Release-stopping evidence: no credentials or live URLs; no Mongo backup/restore
record; replica payment tests, real MISA Mongo tests, and real GridFS integration
remain without evidence; no live Vercel-to-Node-to-converter journey; no
rollback drill; no exact post-merge staging-tested SHA. No production deploy was
attempted.
