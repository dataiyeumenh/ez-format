# Main Experimental Rollback Runbook

Status: `blocked` for live execution until the private release record contains
the deployed SHA, service IDs, live URLs, operator access, and Mongo backup
record. This document defines a reversible response; no rollback was executed
from this worktree.

## Rollback identity

- Primary emergency ref:
  `rollback/main-pre-task11-reconcile-20260730-203721`.
- Primary emergency SHA:
  `2250102293021a54bcd1cf4fc8a7d6037e980524`.
- Legacy deep fallback only: `rollback/main-pre-experimental-integration-20260730-055323` at SHA `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
- Verify the ref before selecting it in Render or Vercel. The expected full
  SHA is `2250102293021a54bcd1cf4fc8a7d6037e980524`.
- Never select `latest`, a moving branch, or an unverified deployment.

Verify from a trusted checkout:

```powershell
$rollbackSha = git rev-parse rollback/main-pre-task11-reconcile-20260730-203721
if ($rollbackSha -ne "2250102293021a54bcd1cf4fc8a7d6037e980524") {
  throw "rollback ref does not match the approved SHA"
}
```

## Trigger conditions

Start rollback when any of these occurs after the candidate deploy:

- converter or Node health is not HTTP `200` after the agreed startup window;
- Node fails to start, or flags-off startup unexpectedly requires the
  converter;
- login, Google login, ban handling, admin, pricing, coupon, PayOS, or normal
  navigation regresses;
- an unauthorized direct converter path, secret exposure, or unsafe export is
  observed;
- smoke testing shows data corruption, wrong owner access, or false success;
- a confirmed migration, index, or data write damages MongoDB behavior.

Record the trigger, UTC time, affected service, deployed SHA, request IDs,
redacted logs, and decision owner. Preserve evidence before changing service
configuration.

## Lifecycle key rotation precondition

Lifecycle HMAC rotation requires a one-key bootstrap release before any
multi-key release:

1. Deploy this code with the existing key ID and material as the sole active
   key, `*_PREVIOUS_KEYS={}`, and a blank `*_ROTATION_HORIZON`. Start both
   services and verify the Node Mongo canary and converter lifecycle-root canary
   were persisted without recording their fingerprints.
2. In a later release, configure the new active key, place the bootstrapped key
   in `*_PREVIOUS_KEYS`, and set a horizon no earlier than every artifact,
   context, and fence retention deadline. Run the Node lifecycle migration in
   its documented apply sequence before mixed-version traffic.
3. Keep every previous key configured through that horizon and at least the
   supported two-release rolling window. Never shorten the horizon or reuse a
   key ID with different material.

A missing previous-key canary, fingerprint mismatch, shortened horizon, or
early key removal must fail startup closed. Do not bypass this gate during
rollback; use the bootstrapped key material or remain on the current SHA.

## First response: flags off

For a feature or gateway regression, disable the gates first and redeploy the
affected services. Use these exact values; do not only hide the frontend.

### Node Render

```env
CONVERTER_PUBLIC_PROXY_ENABLED=false
CONVERTER_GATEWAY_USAGE_READY=false
MASTER_DATA_WORKSPACES_ENABLED=false
MISA_IMPORT_REPAIR_ENABLED=false
STUDENT_ASSISTANT_ENABLED=false
STUDENT_PRIVACY_RETENTION_ENABLED=true
ARTIFACT_LIFECYCLE_MIGRATION_MODE=off
VOUCHER_RECONSTRUCTION_ENABLED=false
FEATURE_MAPPING_PROFILE_V2=false
FEATURE_ANOMALY_DETECTION=false
FEATURE_BULK_CORRECTION=false
FEATURE_RECONCILIATION=false
FEATURE_ACCOUNTING_ASSISTANT=false
FEATURE_AI_EXPLANATION=false
MAPPING_PROFILE_V2_MIGRATION_MODE=off
```

### Converter Render

```env
OPERATION_STORE_PROVIDER=node
OPERATION_STORE_ALLOW_LOCAL=false
ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS=false
STUDENT_ASSISTANT_ENABLED=false
STUDENT_PRIVACY_RETENTION_ENABLED=true
STUDENT_FILE_QA_ENABLED=false
STUDENT_FILE_EXPLAIN_ENABLED=false
STUDENT_ACCOUNTING_MAP_ENABLED=false
STUDENT_RECONCILIATION_ENABLED=false
STUDENT_INTERNSHIP_ENABLED=false
VOUCHER_RECONSTRUCTION_ENABLED=false
FEATURE_MAPPING_PROFILE_V2=false
FEATURE_ANOMALY_DETECTION=false
FEATURE_BULK_CORRECTION=false
FEATURE_RECONCILIATION=false
FEATURE_ACCOUNTING_ASSISTANT=false
FEATURE_AI_EXPLANATION=false
```

### Vercel

```env
VITE_MASTER_DATA_WORKSPACES_ENABLED=false
VITE_STUDENT_ASSISTANT_ENABLED=false
VITE_STUDENT_FILE_QA_ENABLED=false
VITE_STUDENT_FILE_EXPLAIN_ENABLED=false
VITE_STUDENT_ACCOUNTING_MAP_ENABLED=false
VITE_STUDENT_RECONCILIATION_ENABLED=false
VITE_STUDENT_INTERNSHIP_ENABLED=false
VITE_VOUCHER_RECONSTRUCTION_ENABLED=false
```

Redeploy the affected service after saving its environment revision. Then
repeat the converter health, Node health, and existing-main-product smoke
checks. If core behavior is healthy, stop here; do not restore MongoDB.
Keep Student privacy retention enabled until coordinated expiry purge reports
no remaining Student raw state or metadata, even while the product feature is off.

## Mandatory legacy deep-fallback drain gate

The legacy deep fallback SHA is allowed only while the release is fully
quiesced. First quiesce ingress, normal Node and converter workers, every queue
producer and consumer, scheduled jobs, and autoscaling. Drain in-flight HTTP
requests, worker jobs, leases, and queues to zero. Only the current SHA's
dedicated privacy and lifecycle drain commands may run after quiescence.

The pre-rollback drain report from the currently deployed code must then prove
all of these independently:

- zero active/pending Student rows, including active, `deleting`,
  `delete_failed`, question-event, activity, and retry-job records;
- zero artifact lifecycle rows in `active` or `purging` state and zero pending
  artifact metadata or GridFS bytes for Student operation bindings;
- zero raw uploads in Node/GridFS and in every converter Student upload and
  operation-session directory.

Run the coordinated Student deletion sweeper and artifact sweeper until two
consecutive bounded passes report zero. Query Mongo collection counts plus the
GridFS binding count from the current code, then inspect the converter retention
roots with the current cleanup command. Record only counts, current SHA, UTC
timestamp, environment revision, and operator; never record identifiers or raw
bytes. A release owner must attest that the three zero results refer to the same
drain window.

Keep ingress, workers, and queues quiesced. Immediately before any old SHA
process starts, recheck every count and queue depth with the current SHA. Record
a fresh same-window zero result. Do not start an old SHA container, worker,
health probe, or one-off command while any privacy data or lifecycle state
remains. MongoDB/GridFS only is supported for artifact bytes; no S3 drain,
fallback, restore, or deletion path is valid.

If any count is non-zero, unknown, stale, or the purge verifier is unavailable,
fail closed: stay on the current code with flags off and
`STUDENT_PRIVACY_RETENTION_ENABLED=true`. Do not deploy the legacy deep fallback,
remove lifecycle keys, or claim rollback completion. The primary emergency SHA
also keeps retention enabled; this stricter zero-data gate applies before any SHA
old enough to lack the coordinated privacy lifecycle.

## Code rollback to the approved ref

Use this path when flags-off redeploy does not restore core behavior, or when
the candidate itself is unsafe.

1. Freeze writes or follow the incident team's approved write-control process
   if data integrity is in question. Do not delete collections, GridFS files,
   audit records, or failed-release logs.
2. Verify the emergency ref resolves to the exact approved SHA above.
3. In Render, deploy the converter and Node services from the exact emergency
   SHA. For the legacy deep fallback, repeat the mandatory zero recheck
   immediately before starting either service; a non-zero, unknown, or stale
   result forbids startup. Keep production roots, build commands, start
   commands, and secret references unchanged unless the incident owner
   approves a change.
4. In Vercel, redeploy the deployment built from the same emergency SHA. Keep
   `VITE_API_URL` pointed to Node and retain the flags-off values.
5. Check `GET /healthz` and `GET /api/health`, then repeat the smoke checklist
   from the release runbook.
6. Record every service revision, health response, environment revision,
   operator, and UTC timestamp in the private incident record.

The emergency ref is a code/config rollback only. It does not undo MongoDB
writes made after deployment and it does not roll back Render/Vercel settings
automatically. Restore those settings explicitly from the recorded previous
environment revision.

## Mongo restore boundary

Do not restore the pre-release Mongo backup for a health, UI, API, or code
regression. The approved backup protects only the named database state at its
recorded pre-release timestamp. Restoring it can discard valid writes made
after that timestamp and cannot restore source code, service configuration, or
frontend deployments.

Mongo restore requires all of the following:

- confirmed migration, index, or data damage;
- DBA and release-owner approval;
- a current snapshot of the affected database before destructive work;
- the exact private backup ID/archive and restore command from the release
  record;
- a post-restore validation record covering indexes, owner boundaries, payment
  state, artifact metadata, and GridFS byte references.

If Mapping Profile V2 migration apply mode was used, automatic rollback is
run-specific and not a substitute for the pre-apply backup. Use the exact
apply run ID and a new rollback run ID only after reviewing the migration JSON
boundary described in `docs/deployment/main-integration-migrations.md`:

```env
MAPPING_PROFILE_V2_MIGRATION_MODE=rollback
MAPPING_PROFILE_V2_MIGRATION_ID=<same-migration-id-as-apply>
MAPPING_PROFILE_V2_MIGRATION_TARGET_RUN_ID=<exact-apply-run-id>
MAPPING_PROFILE_V2_MIGRATION_RUN_ID=<new-rollback-run-id>
```

Automatic migration rollback may not reverse owner-scope backfills, legacy
index changes, or unrelated data. Inspect the recorded
`rollbackBoundary`/`manualRecoveryRequired` result before any retry or restore.
Initial flags-off release configuration must keep
`MAPPING_PROFILE_V2_MIGRATION_MODE=off`; no migration is implied by a feature
flag.

## Post-rollback checks

- [ ] Converter `/healthz` returns HTTP `200` with `status: "ok"`.
- [ ] Node `/api/health` returns HTTP `200` with `status: "OK"`.
- [ ] Gateway and every new feature flag are false in Node, converter, and
      Vercel where applicable.
- [ ] Existing login, Google login, ban handling, admin, pricing, coupon,
      PayOS callback status, and normal navigation pass.
- [ ] No direct browser-to-converter request exists.
- [ ] No secret, raw workbook, or private token appears in evidence/logs.
- [ ] Mongo restore was not performed unless the restore boundary above was
      approved and recorded.
- [ ] Failed release logs and artifact metadata remain available for diagnosis.

## Live-execution blockers

No live rollback claim is permitted until the operator supplies:

- Render converter and Node service IDs plus their current URLs;
- Vercel project/domain and deployment access;
- the deployed candidate SHA and all prior environment revisions;
- the private Mongo backup record and DBA approver;
- a release owner to authorize flag changes, code rollback, or database
  restore.
