# Main Experimental Release Runbook

Status: `BLOCKED` until the private deployment record, live service URLs, and
operator evidence below exist. This is an execution runbook, not staging
evidence. No deployment was performed while these values were unavailable.

## Release identity and guardrails

- Task 13 source tree inspected: `e05764be8bbed6c9ad2bcaa47f7fabc5665f9459`.
- Candidate parent for the Task 12 runbooks:
  `e8632a023ae33a17c1db58e44a21e53a6f47f99b`.
- The deployable candidate must be an immutable commit SHA recorded after all
  release documents are committed. Do not deploy a moving branch or `HEAD`.
- Required emergency rollback ref:
  `rollback/main-pre-experimental-integration-20260730-055323`.
- Required rollback SHA:
  `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
- Initial staging and production configuration keeps every new integration
  gate disabled. Task 13 enablement is a separate change and requires live
  evidence for each capability.
- Browser traffic goes to Node only. Do not put a converter URL in Vercel
  environment variables or frontend code.
- Artifact metadata and bytes remain in MongoDB/GridFS. Do not configure an
  object-storage provider.
- No S3, R2, MinIO, or other object-storage variables are required.

## Blocked preflight

The release owner must not start the deployment until every item is checked.

- [ ] Release owner records the immutable candidate SHA and release ID.
- [ ] DBA records a successful Mongo backup before the first integrated Node
      backend start.
- [ ] DBA records the cluster label, database name, UTC backup timestamp,
      backup ID or private archive location, and the exact private restore
      command.
- [ ] Render owner supplies the converter service ID and HTTPS service URL.
- [ ] Render owner supplies the Node service ID and HTTPS service URL.
- [ ] Vercel owner supplies the project name and production/staging domain.
- [ ] Owners have deployment access and a private secret manager. No
      credentials, tokens, Mongo URIs, or private deployment URLs go in Git.
- [ ] QA owner supplies live staging evidence for both health endpoints and
      the smoke checklist. No live evidence is currently available.

Required user actions to unblock:

1. Create or identify the staging Mongo database and complete the private
   backup record in the template below.
2. Create/identify two Render services with the roots and commands in this
   document. Supply their actual HTTPS URLs.
3. Configure the Node and converter environment values in the Render secret
   store. Generate two distinct shared secrets, each at least 32 characters;
   use the same value for each named secret on both services.
4. Configure the Vercel project with the frontend values below. Supply its
   actual domain to Node `FRONTEND_URL` and converter `CORS_ORIGINS`.
5. Deploy the candidate SHA, capture health responses and smoke results with
   UTC timestamps, then attach the evidence to the private deployment record.

## Mongo backup record

Complete this record in the private deployment system before the first
integrated backend start. The record may contain secret references; this Git
document may not contain their values.

```text
release_id: <private-release-id>
candidate_sha: <full-candidate-sha>
backup_timestamp_utc: <YYYY-MM-DDTHH:MM:SSZ>
cluster_label: <provider-cluster-label>
database_name: <database-name>
backup_method: <managed-snapshot-or-approved-mongodump>
backup_id_or_private_archive: <private-reference>
backup_validation: <provider-verified-or-restore-tested>
restore_command: <exact-command-kept-in-private-record>
restore_target: <private-target-cluster-and-database>
restore_approval_owner: <name-or-team>
recorded_by: <name>
```

Use the approved MongoDB provider backup workflow or the installed MongoDB
Database Tools version. Before execution, verify the exact `mongodump` or
provider snapshot syntax and record the exact restore command privately. Keep
credentials in the provider secret manager or a protected runtime file, never
in this repository, command examples, logs, or commit messages.

Backup boundary:

- The backup is a point-in-time protection boundary for the named database
  before this release. It is not a backup of Render, Vercel, source code, or
  post-backup writes.
- Do not restore it for a normal feature-flag or code rollback.
- A restore is allowed only after confirmed migration, data, or index damage,
  with DBA and release-owner approval. Capture a current database snapshot
  before any destructive restore.
- Keep failed release logs and artifact metadata for diagnosis. Never copy
  raw customer workbooks into logs or the Git repository.

## Initial flags-off configuration

Set these values explicitly. Do not rely on platform defaults. Replace every
angle-bracket value with a real private deployment value before saving it in a
platform dashboard. The values shown here are not credentials.

### Node Render service

Service root: `backend`

Build command:

```text
npm ci
```

Start command:

```text
npm start
```

Health path: `/api/health`

Set the existing production authentication, payment, and database variables
from `backend/.env.example` in the Render secret store. At minimum, the
release record must identify values for `MONGO_URI`, `JWT_SECRET`,
`GOOGLE_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CLIENT_ID`,
`PAYOS_CHECKSUM_KEY`, `PAYOS_RETURN_URL`, `PAYOS_CANCEL_URL`,
`PAYOS_WEBHOOK_URL`, and `FRONTEND_URL`. Do not paste their values into Git.

```env
NODE_ENV=production
FRONTEND_URL=https://<vercel-domain>
CONVERSION_CONTEXT_SECRET=<same-private-value-on-both-services>
CONVERTER_SERVICE_TOKEN=<different-same-private-value-on-both-services>
CONVERTER_INTERNAL_URL=https://<converter-service>.onrender.com
CONVERTER_TIMEOUT_MS=60000
CONVERTER_PUBLIC_PROXY_ENABLED=false
CONVERTER_GATEWAY_USAGE_READY=false
CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb
CONVERTER_MONGODB_GRIDFS_BUCKET=conversion_artifacts
MASTER_DATA_WORKSPACES_ENABLED=false
MISA_IMPORT_REPAIR_ENABLED=false
STUDENT_ASSISTANT_ENABLED=false
VOUCHER_RECONSTRUCTION_ENABLED=false
FEATURE_MAPPING_PROFILE_V2=false
FEATURE_ANOMALY_DETECTION=false
FEATURE_BULK_CORRECTION=false
FEATURE_RECONCILIATION=false
FEATURE_ACCOUNTING_ASSISTANT=false
FEATURE_AI_EXPLANATION=false
MAPPING_PROFILE_V2_MIGRATION_MODE=off
```

`PORT` is supplied by Render. Do not add an object-storage setting. The
`conversion_artifacts` bucket name matches the current `backend/.env.example`;
changing it requires a reviewed Mongo/GridFS migration decision.

The current backend example does not declare every runtime gate consumed by
the integrated routes. Set `STUDENT_ASSISTANT_ENABLED` explicitly as shown;
its safe default remains `false`. Do not silently infer a missing platform
value.

### Converter Render service

Deploy this service first, after the Mongo backup record is complete.

Service root: `converter`

Build command:

```text
pip install -r requirements.txt
```

Start command:

```text
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Health path: `/healthz`

Set the following values in the converter Render environment. Values named as
shared secrets must exactly match the corresponding Node values while staying
distinct from each other.

```env
NODE_ENV=production
CONVERSION_CONTEXT_SECRET=<same-private-value-as-node>
CONVERTER_SERVICE_TOKEN=<same-private-value-as-node>
NODE_INTERNAL_API_URL=https://<node-service>.onrender.com/api/internal
OPERATION_STORE_PROVIDER=node
OPERATION_STORE_ALLOW_LOCAL=false
ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS=false
ALLOW_LEGACY_ROW_EXPORT=false
CORS_ORIGINS=https://<vercel-domain>
AI_PROVIDER=disabled
AI_REQUIRED=false
STUDENT_ASSISTANT_ENABLED=false
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

The converter names above are present in `converter/.env.example`, except for
the explicit production/runtime hardening values that default safely in code.
Review the complete example before deployment; preserve its size limits,
retention values, AI settings, and `CONVERSION_CONTEXT_SECRET`/
`CONVERTER_SERVICE_TOKEN` contract. Replace its development internal URL with
the HTTPS Node Render URL shown above.

### Vercel frontend

Project root: `frontend`

Build command:

```text
npm run build
```

Output directory: `dist`

Set these public, non-secret build values:

```env
VITE_API_URL=https://<node-service>.onrender.com
VITE_MASTER_DATA_WORKSPACES_ENABLED=false
VITE_STUDENT_ASSISTANT_ENABLED=false
VITE_STUDENT_FILE_QA_ENABLED=false
VITE_STUDENT_FILE_EXPLAIN_ENABLED=false
VITE_STUDENT_ACCOUNTING_MAP_ENABLED=false
VITE_STUDENT_RECONCILIATION_ENABLED=false
VITE_STUDENT_INTERNSHIP_ENABLED=false
VITE_VOUCHER_RECONSTRUCTION_ENABLED=false
```

`VITE_GOOGLE_CLIENT_ID` may be set to the approved public client ID when the
existing Google login flow requires it. `VITE_PYTHON_API_URL` must be absent.
`VITE_NODE_API_URL` is not part of the current frontend example; do not add a
second API base URL. All production API values must be HTTPS and non-loopback.

## Deployment sequence

1. Freeze the release ID and candidate SHA. Confirm the rollback ref resolves
   to the canonical SHA
   `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
2. Complete and privately verify the Mongo backup record.
3. Deploy the converter Render service. Wait for a successful `/healthz`
   response before deploying Node.
4. Deploy Node with all gates off. A temporary converter outage must not make
   the flags-off Node health check fail.
5. Deploy Vercel with `VITE_API_URL` pointing only to Node. Confirm the build
   uses the candidate SHA and contains no direct converter base URL.
6. Run the smoke checklist below. Do not enable any feature in this task.
7. Record evidence. Only a complete evidence record can unblock Task 13.

## Health checks

The following commands are templates. Replace placeholders privately; they
were not run from this worktree.

```powershell
$converter = "https://<converter-service>.onrender.com"
$node = "https://<node-service>.onrender.com"

$converterHealth = Invoke-RestMethod "$converter/healthz"
if ($converterHealth.status -ne "ok") { throw "converter health failed" }

$nodeHealth = Invoke-RestMethod "$node/api/health"
if ($nodeHealth.status -ne "OK") { throw "node health failed" }
if ($nodeHealth.capabilities.converterGateway -ne $false) { throw "gateway flag is not off" }
if ($nodeHealth.capabilities.studentAssistant -ne $false) { throw "student flag is not off" }
```

Record HTTP status, response body (redacted of IDs/tokens), service deployment
SHA, environment revision, timestamp, and operator for each check.

## Flags-off smoke checklist

All items remain unchecked until performed against live staging.

- [ ] Converter Render deploy uses the candidate SHA; build and start logs are
      free of secret values.
- [ ] `GET /healthz` returns HTTP `200` and JSON `status: "ok"`.
- [ ] Node Render deploy uses the candidate SHA; startup completes with the
      gateway and all new feature flags off.
- [ ] `GET /api/health` returns HTTP `200` and JSON `status: "OK"`.
- [ ] Node health reports `converterGateway: false` and
      `studentAssistant: false`.
- [ ] Vercel build succeeds with output directory `dist` and no
      `VITE_PYTHON_API_URL`.
- [ ] Browser reaches Node through `VITE_API_URL`; no browser request reaches
      the converter service directly.
- [ ] Existing login succeeds.
- [ ] Google login succeeds, if enabled for the environment.
- [ ] Ban handling remains correct.
- [ ] Admin users, plans, revenue, files, and normal navigation remain
      usable.
- [ ] Pricing and coupon flows remain usable.
- [ ] PayOS callback status remains correct; do not send a real payment unless
      the payment owner authorizes the test.
- [ ] New student, voucher, mapping, anomaly, correction, reconciliation,
      accounting-assistant, AI-explanation, and import-repair surfaces remain
      hidden or reject access while their flags are off.
- [ ] No credentials, raw customer workbook, or private token appears in
      service logs, browser responses, or deployment evidence.

## Evidence required to change status

The private release record must contain the candidate SHA, both Render service
revisions and URLs, the Vercel deployment ID/domain, the Mongo backup record,
the two health responses, the complete smoke results, and the operator/time in
UTC. Until those artifacts exist, status stays `blocked`; code-complete or
local-test evidence is not live staging evidence.

## Progressive enablement admission

Do not start progressive enablement until the flags-off staging checklist is
complete and `docs/qa/main-experimental-live-staging.md` identifies one release
ID and one immutable full SHA. Every Render and Vercel deployment used by a
gate must resolve to that SHA. A branch name, `latest`, a shortened SHA, or a
deployment built from a different tree is not acceptable.

Roles are mandatory:

| Role | Responsibility |
|---|---|
| Release owner | Opens/closes each change window and stops promotion on any failed gate. |
| Render owner | Applies Node/converter environment revisions and records service IDs, revisions, and deployed SHA. |
| Vercel owner | Applies frontend build variables and records project, deployment ID, domain, and deployed SHA. |
| QA owner | Runs the owner/isolation, stale-state, AI-offline, and live API gates. |
| Accounting owner | Approves MISA fixture results, totals, templates, warnings, and retry behavior. |
| DBA | Owns backup/restore evidence and MongoDB replica/GridFS evidence. |

For every stage:

1. Record the owner, start time, prior environment revision, proposed revision,
   and the exact SHA before changing a flag.
2. Change only the flag group for that stage. Previously passed groups stay at
   their recorded values; later groups stay `false`.
3. Deploy converter, then Node, then Vercel when that stage changes those
   services. Wait for health before moving to the next service.
4. Run all five gates: authorized owner, foreign-owner isolation, stale
   state/version rejection, `AI_PROVIDER=disabled` with `AI_REQUIRED=false`,
   and a real browser/API journey through the staging Node origin.
5. Record redacted request IDs, HTTP status, environment revisions, service
   SHA, output hashes/counts, operator, and UTC timestamps. Never record JWTs,
   passwords, service tokens, Mongo/Redis URLs, or raw workbook cells.
6. On any unexpected success, data mutation, wrong total, direct browser call
   to the converter, secret exposure, or false-success UI, stop. Restore the
   stage's prior environment revisions and execute the rollback drill.

Browser requests must use `VITE_API_URL` and Node `/api` routes only. Direct
browser access to FastAPI is forbidden. All URLs must be HTTPS and
non-loopback. Operator health probes may address the converter `/healthz`
endpoint directly; browser tests may not.

## Exact enablement order and flag groups

The order is fixed:

1. Converter gateway and MongoDB/GridFS artifacts.
2. Smart Voucher reconstruction.
3. Student Assistant supported capabilities.
4. Accounting operations, one capability at a time.
5. MISA import repair.
6. Exact-SHA production promotion.

Do not combine stages. Do not advance while a row in the live staging receipt
is `PENDING`, `FAIL`, `SKIPPED`, `INCOMPLETE`, or lacks an evidence reference.

### Stage 1 - Converter gateway

Owner: Render owner changes Node; QA owner executes gates; DBA approves real
GridFS evidence. Converter baseline settings from the flags-off deployment stay
unchanged.

Set this exact Node group:

```env
CONVERTER_PUBLIC_PROXY_ENABLED=true
CONVERTER_GATEWAY_USAGE_READY=true
CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb
CONVERTER_MONGODB_GRIDFS_BUCKET=conversion_artifacts
```

Keep these production boundaries:

```env
MAPPING_PROFILE_V2_MIGRATION_MODE=off
```

`MONGO_URI`, `CONVERSION_CONTEXT_SECRET`, `CONVERTER_SERVICE_TOKEN`, and
`CONVERTER_INTERNAL_URL` must already be present privately. The current backend
contract uses `conversion_artifacts`, matching `backend/.env.example`.
`CONVERTER_OBJECT_STORAGE_REQUIRED` is not consumed by the current code; do not
add it. No S3 or other object-storage variable is part of this stage.

Required gates:

- Owner: the authorized QA owner completes raw upload, mapping, readiness,
  preview, warning acknowledgement, and a real purchase or sales MISA export.
- Isolation: the foreign QA identity cannot read, mutate, preview, or export
  the owner's run, upload, profile, session, or artifact; no owner metadata is
  disclosed.
- Stale state: submit the previous operation-session `revision` and
  `state_hash` after creating a newer revision. Node `/api/converter` must
  return the bounded conflict and must not write an export or charge.
- AI offline: keep `AI_PROVIDER=disabled` and `AI_REQUIRED=false`; mapping,
  validation, preview, warning gate, and export remain deterministic.
- Live API: run `npm run qa:converter-gateway` in release mode with the private
  live contract. Browser traffic must cover Node
  `/api/converter/uploads/analyze`, `/api/converter/mappings/preview`,
  `/api/converter/mappings/readiness`, and
  `/api/converter/conversions/export`. The resulting summary must be `pass`,
  `release_eligible=true`, with zero failures and zero skips.
- Restart: during a disposable in-flight session, restart Node once. The UI
  must either resume the owner-bound state or report expired/unavailable; it
  must never report a corrupt success. Confirm GridFS bytes and metadata remain
  owner-bound after restart.

Do not proceed without a real `GRIDFS_INTEGRATION_TEST_URI` run and live
Vercel-to-Node-to-converter evidence.

### Stage 2 - Smart Voucher reconstruction

Owner: Render owner changes converter and Node; Vercel owner changes the
frontend; QA and accounting owners execute gates. This stage requires a private
TLS Redis connection because Render filesystem storage is not a restart-safe
production reconstruction store. Redis is session state, not artifact object
storage; MongoDB/GridFS remains the workbook artifact contract.

Apply the group in this order.

Converter first:

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

Node second:

```env
MASTER_DATA_WORKSPACES_ENABLED=true
VOUCHER_RECONSTRUCTION_ENABLED=true
RECONSTRUCTION_SHADOW_MODE=true
RECONSTRUCTION_BETA_WORKSPACE_IDS=<approved-staging-workspace-objectids>
RECONSTRUCTION_STORE_TTL_HOURS=24
RECONSTRUCTION_CREATE_LIMIT_PER_15_MINUTES=20
```

Vercel last in the same change window:

```env
VITE_MASTER_DATA_WORKSPACES_ENABLED=true
VITE_VOUCHER_RECONSTRUCTION_ENABLED=true
```

Required gates:

- Owner: the approved beta workspace owner analyzes goods-only, service-only,
  and mixed fixtures; row count, document count, type, totals, and source-row
  conservation match accounting expectations.
- Isolation: an unrelated user/workspace cannot list, read, edit, validate,
  approve, export, or activate the owner's reconstruction/profile.
- Stale version: update a draft, then replay the prior `expected_revision`;
  Node `/api/reconstructions` must return conflict without changing the latest
  draft. Repeat profile activation with an obsolete profile version/state.
- AI offline: with the converter values above, all three fixtures still reach
  deterministic review. The UI may report AI unavailable; it must not block
  manual review or claim AI output.
- Live API: the browser uses Node `/api/reconstructions` only. Validate analyze,
  draft edit, split/merge, validation, approval, and export behavior. While
  shadow mode is `true`, export must be rejected and traditional mapping export
  must remain usable.
- Restart: restart the converter after creating a disposable draft; the same
  owner can resume it from Redis and a foreign owner cannot.

After every shadow-mode gate passes, change
`RECONSTRUCTION_SHADOW_MODE=false` on converter and Node, redeploy in that
order, then execute one approved non-customer export. Keep the Vite flags as
recorded. Any mismatch returns both services to `RECONSTRUCTION_SHADOW_MODE=true`
or disables the whole stage.

### Stage 3 - Student Assistant

Owner: security/release owner provisions the anonymization secret; Render owner
changes Node and converter; Vercel owner changes frontend; QA owner executes
gates. `STUDENT_ANONYMIZATION_SECRET` must be a dedicated private value of at
least 32 characters and distinct from `CONVERSION_CONTEXT_SECRET` and
`CONVERTER_SERVICE_TOKEN`.

Converter first:

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

Node second:

```env
STUDENT_ASSISTANT_ENABLED=true
STUDENT_FILE_EXPLAIN_ENABLED=true
STUDENT_FILE_QA_ENABLED=true
STUDENT_CHECK_WORK_ENABLED=false
STUDENT_ACCOUNTING_MAP_ENABLED=true
STUDENT_RECONCILIATION_ENABLED=true
STUDENT_INTERNSHIP_ENABLED=true
```

Vercel last:

```env
VITE_STUDENT_ASSISTANT_ENABLED=true
VITE_STUDENT_FILE_EXPLAIN_ENABLED=true
VITE_STUDENT_FILE_QA_ENABLED=true
VITE_STUDENT_ACCOUNTING_MAP_ENABLED=true
VITE_STUDENT_RECONCILIATION_ENABLED=true
VITE_STUDENT_INTERNSHIP_ENABLED=true
```

Do not create `VITE_STUDENT_CHECK_WORK_ENABLED`. Grading/check-work is removed
from this release. Keep `STUDENT_CHECK_WORK_ENABLED=false` so Student attempt
completion and score persistence cannot be enabled accidentally.

Required gates:

- Owner: the session owner completes analyze/explanation, file questions,
  accounting map, reconciliation, anonymization preview/export, and internship
  report through Node `/api/student`.
- Isolation: a foreign identity cannot obtain the owner session, signed
  context, source row, activity, question, map, reconciliation, anonymized
  export, or internship report.
- Stale context: re-analyze or change the source/mapping so the source signature
  changes. A prior context/signature must not authorize or silently reuse the
  new analysis. Expired contexts must fail; refreshed owner contexts must bind
  to the same active session and owner.
- AI offline: deterministic explanations, evidence, accounting map,
  reconciliation, anonymization, and internship report remain usable. A
  question that cannot be answered without AI reports bounded unavailability
  instead of fabricated evidence.
- Live API: browser requests use Node `/api/student` only. Verify capability
  intersection, desktop/mobile UI, redacted logs, no raw workbook retention
  beyond the configured boundary, no grading UI, and no attempt/score state
  created by the supported flows while `STUDENT_CHECK_WORK_ENABLED=false`.

### Stage 4 - Accounting operations

Owner: Render owner changes Node and converter; QA owner runs each capability;
accounting owner signs the release gate. Vercel has no force-enable flag for
these operations; UI visibility must come from the Node/converter capability
intersection.

Start with all six flags `false` on Node and converter. Keep
`MAPPING_PROFILE_V2_MIGRATION_MODE=off`. For each row below, change the named
flag to `true` on converter first, then Node. Previously passed flags remain
`true`; later flags remain `false`.

| Order | Capability | Exact flag | Stale-state gate |
|---:|---|---|---|
| 1 | Mapping Profile V2 | `FEATURE_MAPPING_PROFILE_V2=true` | Reject obsolete `expected_version`/`state_hash`; no profile/export mutation. |
| 2 | Anomaly Detection | `FEATURE_ANOMALY_DETECTION=true` | Reject prior session `revision`/`state_hash`; no finding mutation. |
| 3 | Bulk Correction | `FEATURE_BULK_CORRECTION=true` | Reject prior session `revision`/`state_hash`; correction/undo history unchanged. |
| 4 | Reconciliation | `FEATURE_RECONCILIATION=true` | Reject prior session `revision`/`state_hash` and stale comparison binding. |
| 5 | Accounting Assistant | `FEATURE_ACCOUNTING_ASSISTANT=true` | Reject prior session `revision`/`state_hash`; no command/state mutation. |
| 6 | AI Explanation | `FEATURE_AI_EXPLANATION=true` | Reject explanation for an obsolete session/profile state; no deterministic state mutation. |

The final server-side group, only after all six rows pass, is:

```env
FEATURE_MAPPING_PROFILE_V2=true
FEATURE_ANOMALY_DETECTION=true
FEATURE_BULK_CORRECTION=true
FEATURE_RECONCILIATION=true
FEATURE_ACCOUNTING_ASSISTANT=true
FEATURE_AI_EXPLANATION=true
MAPPING_PROFILE_V2_MIGRATION_MODE=off
```

Run these gates for every row before enabling the next:

- Owner: the correct user/workspace creates and reads only its profiles,
  session revisions, findings, corrections, comparisons, commands, and
  explanations.
- Isolation: replay the owner's IDs and signed context as the foreign identity;
  access is denied without disclosure or mutation.
- Stale version: execute the row-specific stale-state gate above. Expected
  conflict evidence includes the response and unchanged current revision/hash.
- AI offline: keep `AI_PROVIDER=disabled` and `AI_REQUIRED=false`. Mapping,
  anomaly detection, correction/undo, reconciliation, readiness, and export
  remain deterministic. Accounting Assistant and AI Explanation must return a
  bounded unavailable/fallback result when an AI-only action is requested;
  they must not fabricate an explanation or mutate accounting data.
- Live API: exercise Node `/api/mapping-profiles/v2` for Mapping Profile V2 and
  Node `/api/converter/sessions` for session operations. Run
  `npm run qa:accounting-operations` for three consecutive release-eligible
  passes with the independent `ke-toan` report and no skipped checks.

Actual AI Explanation live verification additionally requires an approved
HTTPS AI endpoint and private token. Configure converter
`AI_PROVIDER=remote_http`, `AI_REQUIRED=false`,
`AI_ACCOUNTING_ASSISTANT_BASE_URL=<approved-https-url>`, and the private
`AI_TOKEN` only after the offline gate passes. Re-run privacy-canary, timeout,
invalid JSON, and offline fallback checks. If those private inputs are absent,
leave `FEATURE_AI_EXPLANATION=false` and classify that deployment capability as
`partial`, not live-verified.

### Stage 5 - MISA import repair

Owner: Render owner changes Node; QA and accounting owners execute gates. The
converter has no separate MISA-repair enable flag; keep the Stage 1 gateway and
converter service contract unchanged. Vercel has no MISA-repair flag.

Set Node:

```env
MISA_IMPORT_REPAIR_ENABLED=true
```

Required gates:

- Owner: create and review purchase, sales, multiline, warning, ambiguous, and
  unknown-column cases. The owner must explicitly acknowledge warnings and
  every whole document group before retry.
- Isolation: the foreign identity cannot read or mutate the repair, issues,
  confirmations, document groups, retry batch, download, artifact, or audit
  state.
- Stale version: replay a mutating request with the prior `expected_version`;
  Node `/api/converter/import-repairs` must return `409` with no issue,
  confirmation, retry, credit, or artifact mutation.
- AI offline: keep `AI_PROVIDER=disabled` and `AI_REQUIRED=false`. Parsing,
  schema selection, readiness, deterministic blockers/warnings, confirmation,
  whole-document retry, and export remain usable. `manual_excel_v1` remains
  `verified=false`; unknown or ambiguous mappings remain blocked until human
  confirmation.
- Live API: use Node `/api/converter/import-repairs` only. Verify purchase and
  sales real-template fidelity, multiline grouping, warning acknowledgement,
  ambiguous/unknown blockers, full failed-document retry groups, and zero
  additional credit on retry/re-download.

Do not pass this stage without a real Mongo run using the private
`MISA_IMPORT_REPAIR_TEST_MONGO_URI` or approved `MONGO_URI` and zero MISA repair
test skips.

## Exact-SHA production promotion

Production promotion is currently `BLOCKED`. When all live staging rows pass:

1. Merge the integration branch into `main` through the reviewed normal merge
   process. Do not deploy the pre-merge integration SHA if the merge produces a
   different commit.
2. Freeze the full merged commit as `STAGING_TESTED_SHA`. Build and deploy that
   exact SHA to staging for converter, Node, and Vercel.
3. On a clean checkout of `STAGING_TESTED_SHA`, run
   `npm run qa:main-integration` in release mode with real replica MongoDB,
   GridFS, live gateway, fixture, and credential inputs. Exit `0`,
   `RELEASE_READY`, zero failed checks, and zero skipped mandatory checks are
   required.
4. Re-run flags-off smoke plus Stages 1-5 against deployments reporting
   `STAGING_TESTED_SHA`. Complete the live receipt and rollback drill.
5. Create the release tag on `STAGING_TESTED_SHA` only after the receipt is
   complete. Record the tag object and commit SHA privately.
6. Select the immutable `STAGING_TESTED_SHA` for each production service. The
   Render converter revision, Render Node revision, and Vercel deployment must
   all report that full SHA before traffic is accepted.
7. Re-run production health and existing-main smoke. Enable feature groups in
   the same order; do not copy an unrecorded staging environment wholesale.

Any code, generated asset, dependency lock, environment-dependent frontend
build input, or merge change after staging certification creates a new SHA.
That SHA must return to step 2. A production deployment that is merely a
descendant of the staging SHA is forbidden.

## Rollback drill

Run the drill on disposable staging data before production promotion. The
release owner calls each step; service owners execute; QA records timings and
results.

1. Trigger a controlled failure in the currently enabled stage without using
   customer data. Record detection time and release-owner decision time.
2. Disable the current stage server flags first, then its Vite flag if present.
   Redeploy the prior environment revisions and prove the preceding stage
   remains healthy.
3. For a wider failure, disable stages in reverse order: MISA repair, accounting
   operations (AI Explanation through Mapping Profile V2), Student Assistant,
   Smart Voucher, then converter gateway.
4. Re-run `/api/health`, login, Google login when configured, ban handling,
   admin, pricing, coupon, PayOS callback status, and normal navigation.
5. If core product remains unhealthy, redeploy
   `rollback/main-pre-experimental-integration-20260730-055323` only after
   verifying it resolves to
   `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
6. Restore MongoDB only for confirmed migration/data/index damage, with DBA and
   release-owner approval and a new pre-restore snapshot. Feature or code
   rollback alone never authorizes a database restore.
7. Preserve redacted logs, request IDs, deployment/environment revisions,
   artifact metadata, and rollback timings. Never preserve raw workbook bytes
   in logs.

The drill passes only when flags-off core smoke is healthy, no browser request
reaches FastAPI directly, no secrets/raw cells appear in evidence, and the
private record proves either successful environment rollback or successful
redeploy of the exact emergency SHA. No drill was run for Task 13 because live
services, credentials, and backup evidence are absent.

## Final feature inventory

`Code status` describes the inspected committed tree. `Live status` changes to
`live-verified` only when the exact-SHA row in the live staging receipt passes.

| Feature | Code status | Live status | Current evidence boundary |
|---|---|---|---|
| Node-to-converter gateway and deterministic MISA conversion | `implemented` | `not live-verified` | Local QA exists; live Vercel-to-Node-to-converter evidence absent. |
| MongoDB/GridFS artifact bytes and metadata | `implemented` | `not live-verified` | Real `GRIDFS_INTEGRATION_TEST_URI` round trip absent. |
| Smart Voucher deterministic reconstruction | `implemented` | `not live-verified` | Goods/service/mixed local QA exists; live TLS Redis and staging evidence absent. |
| Smart Voucher optional AI augmentation | `partial` | `not live-verified` | Code path exists; approved live AI endpoint/token and live fault evidence absent. |
| Student explanation, questions, map, reconciliation, anonymization, internship | `implemented` | `not live-verified` | Supported code paths exist; live owner/privacy/stale-context evidence absent. |
| Student grading/check-work release surface | `removed` | `not applicable` | Intentionally excluded; check-work stays false, no Vite flag/UI is promoted, and supported flows must create no score state. |
| Mapping Profile V2, anomaly, bulk correction, reconciliation | `implemented` | `not live-verified` | Local gates exist; three live release-eligible runs absent. |
| Accounting Assistant deterministic boundary | `implemented` | `not live-verified` | Local tests exist; live owner/stale/offline evidence absent. |
| AI Explanation production deployment | `partial` | `not live-verified` | Provider inputs and live privacy/fallback evidence absent. |
| MISA import repair | `implemented` | `not live-verified` | Local code QA exists; real Mongo and live staging API evidence absent. |
| Current staging/production deployment state | `uncertain` | `not live-verified` | No service credentials, IDs, URLs, revisions, or live responses were supplied. |

## Task 13 release blockers and exact inputs

Status remains `BLOCKED`. No live deploy, promotion, or rollback drill is
authorized until all inputs below are available in the private release system:

- release owner, Render owner, Vercel owner, QA owner, accounting owner, DBA,
  release ID, change windows, and escalation contacts;
- immutable post-merge full candidate SHA and proof that both Render services
  plus the Vercel deployment resolve to it;
- Render access, Node/converter service IDs, HTTPS URLs, current deployment
  revisions, and prior environment revisions;
- Vercel access, project/environment name, HTTPS staging domain, deployment ID,
  commit SHA, and prior build-variable revision;
- private references for `MONGO_URI`, two distinct shared service secrets,
  Student anonymization secret, QA owner/foreign credentials, and approved
  fixture locations; secret values must not enter Git;
- Mongo cluster/database, successful backup timestamp/ID/method, validation,
  exact private restore command, restore target, and DBA approval;
- real replica Mongo evidence with `PAYMENT_REPLICA_SET_TEST_URI`, real MISA
  Mongo evidence with `MISA_IMPORT_REPAIR_TEST_MONGO_URI` or approved
  `MONGO_URI`, and real GridFS evidence with `GRIDFS_INTEGRATION_TEST_URI`, all
  showing the mandatory tests ran with zero relevant skips;
- TLS Redis service/access and private `rediss://` reference for restart-safe
  Smart Voucher staging;
- `QA_EXPECT_LIVE=true`, `QA_FRONTEND_URL`, `QA_GATEWAY_URL`,
  `QA_CONVERTER_URL`, release ID, owner/foreign auth inputs, approved real raw
  fixture, live contract, and charge-audit before/after files;
- flags-off health/smoke evidence, per-stage receipts, complete rollback drill,
  and `npm run qa:main-integration` release-mode `RELEASE_READY` evidence bound
  to `STAGING_TESTED_SHA`;
- approved HTTPS AI endpoint/token only if AI Explanation is to be promoted;
  otherwise that flag remains false and the capability remains `partial`.

No S3, R2, MinIO, object-storage credential, bucket, or provider input is
required or permitted.
