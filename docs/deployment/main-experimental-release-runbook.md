# Main Experimental Release Runbook

Status: `blocked` until the private deployment record, live service URLs, and
operator evidence below exist. This is an execution runbook, not staging
evidence. No deployment was performed while these values were unavailable.

## Release identity and guardrails

- Candidate parent inspected for this task: `e8632a023ae33a17c1db58e44a21e53a6f47f99b`.
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
