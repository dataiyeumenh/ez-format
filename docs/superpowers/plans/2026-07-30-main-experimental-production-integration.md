# Main-First Experimental Production Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tich hop toan bo chuc nang da QA/QC tu `Experimental` va `codex/misa-import-repair-phase1` vao nen `main` hien tai, khong merge commit khong lo `2da3d8f`, khong lam mat chuc nang production cua `main`, va tao release co the deploy/rollback an toan.

**Architecture:** Dung `main@8d1a934` lam source of truth cho auth, payment, admin, coupon, pricing va deploy contract. Dung `codex/misa-import-repair-phase1@1a1d0e6` lam source tham chieu cuoi cho converter, Student Assistant, Smart Voucher, accounting operations va MISA import repair; transplant theo tung vertical slice thay vi merge/cherry-pick `Experimental@2da3d8f`. Tat ca feature moi fail-closed sau feature flag; backend van khoi dong khi converter optional bi tat; artifact bytes va metadata dung MongoDB/GridFS, khong them object-storage provider moi.

**Tech Stack:** Node.js/Express/Mongoose, Python/FastAPI/Pydantic, React/Vite, MongoDB, Render, Vercel, Playwright, PowerShell QA scripts.

## Global Constraints

- Integration base bat buoc: `main@8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
- Rollback remote bat buoc ton tai: `rollback/main-pre-experimental-integration-20260730-055323@8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`.
- Feature source cuoi: `codex/misa-import-repair-phase1@1a1d0e6971ccf5bd1140e676c63a5210a1111cbe`.
- Khong merge, rebase hoac cherry-pick commit `Experimental@2da3d8f`.
- Khong dung `git merge -X ours`, `git merge -X theirs`, `git checkout --`, `git reset --hard`.
- Khong sua truc tiep `main`; moi thay doi tren worktree/branch `codex/main-experimental-production-integration`.
- Main la source of truth cho auth, Google login, ban/unban user, admin, plan, payment, PayOS, coupon va pricing.
- Source branch la source of truth cho cac contract converter/accounting da duoc final review, tru cac quyet dinh deploy bi thay the trong plan nay.
- Khong them S3, R2, MinIO hoac object-storage provider moi trong MVP nay.
- Artifact metadata luu trong MongoDB; artifact bytes luu trong MongoDB GridFS, khong nhung bytes vao document metadata.
- GridFS bucket phai co checksum, byte length, mime, owner/run binding va expiry; sweeper phai xoa ca metadata lan GridFS object theo batch gioi han.
- MongoDB la source of truth cho session, issue, manifest, retry batch, mapping, artifact metadata va artifact bytes.
- Browser chi goi Node backend; khong expose FastAPI truc tiep.
- `CONVERSION_CONTEXT_SECRET` va `CONVERTER_SERVICE_TOKEN` phai khac nhau, dai toi thieu 32 ky tu, giong nhau giua Node va FastAPI theo tung ten bien.
- Raw workbook co the luu trong MongoDB GridFS theo TTL; khong luu trong document metadata, log hoac JSON response.
- AI optional; AI offline khong duoc chan mapping, validation hoac export deterministic.
- AI khong duoc xac nhan mapping, severity, tai khoan, VAT, master data hoac retry.
- MISA import repair giu `manual_excel_v1`, `verified=false`, auto-match hard-disabled va moi match can human/server confirmation.
- Retry MISA luon theo toan bo `document_group` va khong tru them credit.
- Feature moi mac dinh `false`; chi bat sau staging gate cua feature do pass.
- Moi task ket thuc bang focused tests, review sach va commit rieng.
- Khong commit `.env`, `.env.local`, secret, QA runtime receipt, Playwright runtime output hoac `.superpowers/sdd/*-before`.
- Code-freeze `main` trong thoi gian integration. Neu `origin/main` thay doi, dung va tao merge-tree report moi truoc Task 11.

---

## 1. Ground Truth Va Ownership

### Branch facts

```text
Common base: 937f3bb44775a2485c7290ec0a56435b66b8aa3a
main:        8d1a9343dc98a8abb715fe7efc8df9adf65a10fa
Experimental:2da3d8f6b4214304d331dc9e1f06e6ac28ccc50a
Phase 1:     1a1d0e6971ccf5bd1140e676c63a5210a1111cbe

main changed:         252 files
Experimental changed: 317 files
overlap:              147 files
merge conflicts:       61 (35 add/add, 26 content)
```

### Source-of-truth matrix

| Area | Source of truth | Integration rule |
|---|---|---|
| Auth, Google, ban/unban | `main` | Khong thay controller/model contract neu focused tests khong yeu cau |
| Admin users/revenue/files/logs | `main` | Giu coupon/admin UI va API hien tai |
| Plans/pricing/payment/PayOS/coupon | `main` | Khong lay file wholesale tu source branch |
| Converter gateway/security/session | Phase branch | Port contract + tests; sua deploy gate theo Task 4 |
| MISA sales/purchase mapping/export | Phase branch | Port final implementation va template contract |
| Mapping Profile V2/accounting operations | Phase branch | Port sau gateway foundation |
| Student Assistant | Phase branch | Port vertical slice, flag off mac dinh |
| Smart Voucher reconstruction | So sanh `main` Phase 3 voi phase branch | Giu main API neu tuong duong; chi port final fixes con thieu |
| MISA import repair | Phase branch | Port day du 9 task da final-review |
| Env/deploy docs | Plan nay | Viet lai; khong lay wholesale tu hai nhanh |
| QA receipts/generated output | Khong nhanh nao | Regenerate sau integration |

## 2. Target Runtime Contract

```text
Vercel React
  -> HTTPS Node backend /api
      -> authenticated converter gateway
          -> HTTPS FastAPI converter
      -> MongoDB metadata + GridFS artifact bytes
      -> PayOS / Google / existing admin APIs

Feature flags OFF
  -> existing main product remains available
  -> missing converter config cannot crash auth/payment/admin

Feature flags ON
  -> startup validates secret, converter URL, service token and MongoDB/GridFS readiness
  -> converter failures return bounded 503; Node process stays observable
```

### Production environment contract with MongoDB/GridFS

Node backend:

```env
NODE_ENV=production
CONVERSION_CONTEXT_SECRET=<SECRET_A_32_PLUS>
CONVERTER_SERVICE_TOKEN=<SECRET_B_32_PLUS>
CONVERTER_PUBLIC_PROXY_ENABLED=true
CONVERTER_GATEWAY_USAGE_READY=true
CONVERTER_INTERNAL_URL=https://<converter-render>.onrender.com
CONVERTER_ALLOW_INSECURE_LOCALHOST=false
CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb
CONVERTER_MONGODB_GRIDFS_BUCKET=ezformatArtifacts
CONVERTER_OBJECT_STORAGE_REQUIRED=false
```

FastAPI converter:

```env
NODE_ENV=production
CONVERSION_CONTEXT_SECRET=<SAME_SECRET_A>
CONVERTER_SERVICE_TOKEN=<SAME_SECRET_B>
INTERNAL_SERVICE_TOKEN_REQUIRED=true
NODE_INTERNAL_API_URL=https://<node-render>.onrender.com/api/internal
NODE_INTERNAL_ALLOW_INSECURE_LOCALHOST=false
OPERATION_STORE_PROVIDER=node
OPERATION_STORE_ALLOW_LOCAL=false
ALLOW_LEGACY_ROW_EXPORT=false
ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS=false
```

Vercel frontend:

```env
VITE_API_URL=https://<node-render>.onrender.com
```

`VITE_PYTHON_API_URL` must be absent. `VITE_NODE_API_URL` is only a compatibility fallback and must not point to localhost in a committed file.

---

### Task 0: Create Isolated Integration Worktree

**Files:**
- No repository files modified.

**Interfaces:**
- Consumes: `main@8d1a934`, rollback remote branch.
- Produces: clean branch/worktree `codex/main-experimental-production-integration`.

- [ ] **Step 1: Verify rollback ref and clean main index**

```powershell
git fetch origin
git rev-parse main
git rev-parse origin/rollback/main-pre-experimental-integration-20260730-055323
git diff --cached --quiet
```

Expected: both refs print `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`; cached diff exits `0`.

- [ ] **Step 2: Create isolated worktree from exact main SHA**

```powershell
git worktree add `
  "E:\0. EXE2\.codex-worktrees\ez-format\main-experimental-production-integration" `
  -b codex/main-experimental-production-integration `
  8d1a9343dc98a8abb715fe7efc8df9adf65a10fa
```

Expected: current main/Experimental working tree remains untouched.

- [ ] **Step 3: Record immutable refs in SDD ledger**

Create `.sdd/main-experimental-production-integration/progress.md` outside tracked files with base, source, rollback and task statuses.

---

### Task 1: Establish Main Baseline And Release Invariants

**Files:**
- Create: `docs/qa/main-first-integration-baseline.md`
- Create: `scripts/qa-main-integration.ps1`
- Modify: `package.json`

**Interfaces:**
- Consumes: unchanged `main` behavior.
- Produces: `npm run qa:main-integration`, the mandatory release gate used by later tasks.

- [ ] **Step 1: Write the gate script before porting features**

`scripts/qa-main-integration.ps1` must use `$PSScriptRoot`, stop on first failure and execute:

```powershell
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Push-Location (Join-Path $Root "backend")
try { node --test } finally { Pop-Location }

Push-Location (Join-Path $Root "converter")
try { python -m pytest -q --tb=short } finally { Pop-Location }

Push-Location (Join-Path $Root "frontend")
try {
  npm test
  npm run lint
  npm run build
} finally { Pop-Location }
```

- [ ] **Step 2: Wire root command**

Add to root `package.json` scripts:

```json
"qa:main-integration": "pwsh -File scripts/qa-main-integration.ps1"
```

- [ ] **Step 3: Capture baseline**

Run:

```powershell
npm run qa:main-integration
```

Expected: record exact pass/fail/skip counts in `docs/qa/main-first-integration-baseline.md`. Any pre-existing failure must be documented before feature transplant; do not silently weaken the gate.

- [ ] **Step 4: Commit**

```powershell
git add package.json scripts/qa-main-integration.ps1 docs/qa/main-first-integration-baseline.md
git commit -m "test: establish main-first integration gate"
```

---

### Task 2: Add Deterministic Transplant Manifest

**Files:**
- Create: `docs/integration/main-experimental-transplant.yml`
- Create: `scripts/verify-transplant-manifest.ps1`
- Test: `scripts/verify-transplant-manifest.ps1`

**Interfaces:**
- Consumes: source-of-truth matrix above.
- Produces: a machine-checkable ownership decision for every file touched during integration.

- [ ] **Step 1: Define manifest schema**

Use exactly:

```yaml
base_sha: 8d1a9343dc98a8abb715fe7efc8df9adf65a10fa
source_sha: 1a1d0e6971ccf5bd1140e676c63a5210a1111cbe
rollback_ref: rollback/main-pre-experimental-integration-20260730-055323
rules:
  - path: backend/controllers/authController.js
    owner: main
    reason: production auth contract
  - path: backend/server.js
    owner: compose
    reason: shared route and startup boundary
  - path: converter/app/import_result_parser.py
    owner: source
    reason: final-reviewed MISA repair parser
  - path: frontend/src/App.jsx
    owner: compose
    reason: main coupon routes plus feature-gated student routes
excluded:
  - .superpowers/sdd/**
  - frontend/test-results/**
  - docs/qa-last-run.json
  - docs/qa-log.md
  - frontend/.env.local
```

- [ ] **Step 2: Require every changed path to have one owner**

`scripts/verify-transplant-manifest.ps1` must fail when an integration diff path has zero or multiple matching rules. Valid owners: `main`, `source`, `compose`, `regenerate`, `exclude`.

- [ ] **Step 3: Seed all shared hotspots**

At minimum mark these `compose`:

```text
backend/.env.example
backend/server.js
backend/controllers/accountingWorkspaceController.js
backend/controllers/conversionRunController.js
backend/routes/internal.js
backend/services/conversionContextService.js
backend/services/conversionCreditService.js
backend/services/mappingProfileService.js
converter/.env.example
converter/app/ai_gateway.py
converter/app/excel_io.py
converter/app/main.py
converter/app/mapping_profile_client.py
converter/app/master_data_client.py
converter/app/misa_profiles.py
converter/app/misa_readiness.py
converter/app/misa_workflow.py
frontend/.env.example
frontend/package.json
frontend/src/App.jsx
frontend/src/components/admin/AdminLayout.jsx
frontend/src/pages/ConvertPage.jsx
frontend/src/services/api.js
```

- [ ] **Step 4: Test and commit**

```powershell
pwsh -File scripts/verify-transplant-manifest.ps1
git add docs/integration/main-experimental-transplant.yml scripts/verify-transplant-manifest.ps1
git commit -m "chore: define main-first transplant ownership"
```

Expected: manifest gate passes; no runtime file changed yet.

---

### Task 3: Preserve Main Product Contracts

**Files:**
- Test: `backend/tests/auth*.test.js`
- Test: `backend/tests/payment*.test.js`
- Test: `backend/tests/admin*.test.js`
- Test: existing coupon tests under `backend/tests/` and `frontend/src/`
- Modify only if contract test exposes integration regression: corresponding main-owned file.

**Interfaces:**
- Consumes: current main auth/admin/payment/coupon behavior.
- Produces: explicit non-regression test set that later transplants cannot bypass.

- [ ] **Step 1: Add release-invariant test command**

Add `qa:main-contracts` to root `package.json`; it must invoke existing focused auth, payment, admin, plan and coupon tests without mocks that replace the route under test.

- [ ] **Step 2: Verify current main behavior**

Run:

```powershell
npm run qa:main-contracts
```

Expected invariants:

```text
email/password and Google login still work
isActive=false remains blocked
admin cannot ban/edit self
plan dates and fileCredits transitions remain correct
PayOS status remains synchronized
coupon create/apply/UI remains present
admin revenue/files/users/plans routes remain mounted
```

- [ ] **Step 3: Commit only test wiring**

```powershell
git add package.json backend/tests frontend/src
git commit -m "test: lock production product contracts"
```

---

### Task 4: Port Gateway Foundation With MongoDB/GridFS Artifact Storage

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/services/conversionArtifactService.js`
- Create: `backend/services/mongoGridFsArtifactStorage.js`
- Modify: `backend/services/conversionContextService.js`
- Modify: `backend/services/converterGatewayService.js`
- Modify: `backend/routes/converterGateway.js`
- Modify: `backend/.env.example`
- Modify: `backend/models/ConversionArtifact.js`
- Modify: `converter/app/internal_auth.py`
- Modify: `converter/app/operation_store.py`
- Modify: `converter/app/operation_store_client.py`
- Modify: `converter/app/main.py`
- Modify: `converter/.env.example`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/scripts/check-production-env.mjs`
- Test: `backend/tests/converterGatewayStartup.test.js`
- Test: `backend/tests/conversionArtifacts.test.js`
- Create: `backend/tests/mongoGridFsArtifactStorage.test.js`
- Test: `converter/tests/test_internal_auth.py`
- Test: `converter/tests/test_operation_store.py`
- Test: `frontend/src/services/api.test.mjs`

**Interfaces:**
- Consumes: Node API base, signed conversion context, service token.
- Produces: authenticated Node-to-FastAPI gateway; optional-disabled mode; MongoDB/GridFS artifact storage with bounded cleanup.

- [ ] **Step 1: Write failing backend startup matrix tests**

Required cases:

```js
gateway off + no converter secrets => backend startup guard passes
gateway on + missing context secret => fails closed
gateway on + missing service token => fails closed
gateway on + MongoDB/GridFS not configured => fails closed
gateway on + MongoDB/GridFS configured => passes
gateway off + MongoDB/GridFS not configured => backend core still starts
```

- [ ] **Step 2: Implement MongoDB/GridFS adapter**

Create `backend/services/mongoGridFsArtifactStorage.js` using the existing adapter method contract:

```js
class MongoGridFsArtifactStorageAdapter {
  constructor({ db, bucketName, maxBytes, now }) { /* validate dependencies */ }
  async putArtifact({ key, bytes, metadata }) { /* stream bounded bytes to GridFS */ }
  async getArtifact({ key }) { /* return bounded readable stream + metadata */ }
  async deleteArtifact({ key }) { /* delete only the bound GridFS object */ }
}
```

The adapter must use `mongoose.connection.db`/`GridFSBucket`, reject writes above the configured byte limit, calculate SHA-256 while streaming, and never accept a path or bucket key from the browser. `ConversionArtifact` stores only the GridFS object ID, checksum, size, mime, owner/run binding, expiry and status.

Publish order:

```text
1. stream bytes to a temporary GridFS object
2. validate byte count/checksum
3. persist ConversionArtifact metadata with the exact GridFS object ID
4. on metadata failure, delete the temporary GridFS object
5. on delete failure, keep a redacted tombstone for the bounded sweeper
```

Read/delete must revalidate owner, run, checksum, expiry and artifact status before touching GridFS.

- [ ] **Step 3: Gate optional converter startup**

In `backend/server.js`, call converter-specific assertions, artifact indexes and sweepers only when `converterGatewayUsageReady` is true:

```js
if (converterGatewayUsageReady) {
  assertConversionContextConfig();
  assertConverterGatewayStartupConfig();
  assertArtifactStorageConfigured(); // mongodb driver only when gateway is ready
}
```

Mount converter context, internal conversion session and public gateway routes under the same readiness decision. Auth, payment, admin, plan, coupon and health routes must mount regardless.

- [ ] **Step 4: Preserve strict enabled mode**

When gateway is enabled:

```text
CONVERSION_CONTEXT_SECRET >= 32 chars
CONVERTER_SERVICE_TOKEN >= 32 chars and not placeholder
CONVERTER_INTERNAL_URL uses HTTPS outside localhost
artifact storage driver is `mongodb` and GridFS bucket is reachable
```

- [ ] **Step 5: Normalize frontend API base**

Keep this contract in `frontend/src/services/api.js`:

```js
const configuredBaseURL = import.meta.env.VITE_API_URL || import.meta.env.VITE_NODE_API_URL;
```

No browser code may read `VITE_PYTHON_API_URL` or call FastAPI directly.

- [ ] **Step 6: Run focused tests**

```powershell
cd backend
node --test tests/converterGatewayStartup.test.js tests/conversionArtifacts.test.js
cd ..\converter
python -m pytest -q tests/test_internal_auth.py tests/test_operation_store.py
cd ..\frontend
npm test
```

Expected: all focused tests pass; production gateway-off and MongoDB/GridFS-ready cases are covered.

- [ ] **Step 7: Commit**

```powershell
git add backend converter frontend
git commit -m "feat: add deploy-safe converter gateway foundation"
```

---

### Task 5: Port Student Assistant As A Feature-Gated Vertical Slice

**Files:**
- Modify: `backend/controllers/studentSessionController.js`
- Modify: `backend/models/StudentActivity.js`
- Modify: `backend/models/StudentFileSession.js`
- Modify: `backend/models/StudentQuestionEvent.js`
- Modify: `backend/routes/student.js`
- Modify: `backend/services/studentSessionService.js`
- Modify: `backend/server.js`
- Modify: `converter/app/student_accounting_map.py`
- Modify: `converter/app/student_anonymization.py`
- Modify: `converter/app/student_context.py`
- Modify: `converter/app/student_explanations.py`
- Modify: `converter/app/student_field_dictionary.py`
- Modify: `converter/app/student_models.py`
- Modify: `converter/app/student_queries.py`
- Modify: `converter/app/student_reconciliation.py`
- Modify: `converter/app/student_reports.py`
- Modify: `converter/app/student_session_client.py`
- Modify: `converter/app/student_store.py`
- Modify: `converter/app/student_workflow.py`
- Modify: `frontend/src/pages/StudentAssistantPage.jsx`
- Modify: `frontend/src/components/student/AccountingMapPanel.jsx`
- Modify: `frontend/src/components/student/ExplanationInspector.jsx`
- Modify: `frontend/src/components/student/FileQuestionPanel.jsx`
- Modify: `frontend/src/components/student/InternshipAssistantPanel.jsx`
- Modify: `frontend/src/components/student/ReconciliationPanel.jsx`
- Modify: `frontend/src/components/student/SourceRowPanel.jsx`
- Modify: `frontend/src/components/student/StudentMappingTable.jsx`
- Modify: `frontend/src/components/student/StudentSessionSummary.jsx`
- Modify: `frontend/src/hooks/useStudentAssistantApi.js`
- Modify: `frontend/src/utils/studentAssistant.js`
- Modify: `frontend/src/App.jsx`
- Test: `backend/tests/studentActivities.test.js`
- Test: `backend/tests/studentQuestions.test.js`
- Test: `backend/tests/studentSessions.test.js`
- Test: `converter/tests/test_student_*.py`
- Test: `frontend/src/utils/studentAssistant.test.mjs`

**Interfaces:**
- Consumes: gateway session, owner/workspace scope, safe artifact metadata.
- Produces: support-only Student Assistant without grading, raw-row persistence or AI authority.

- [ ] **Step 1: Transplant isolated modules from exact source SHA**

For files marked `source` in the manifest, copy exact blobs from `1a1d0e6`; do not copy `backend/server.js`, `converter/app/main.py` or `frontend/src/App.jsx` wholesale.

- [ ] **Step 2: Compose shared route files**

Requirements:

```text
main coupon/admin routes remain
Student route mounts only when STUDENT_ASSISTANT_ENABLED=true
frontend route imports lazily and remains hidden when VITE_STUDENT_ASSISTANT_ENABLED=false
no grading/score/attempt state
raw workbook and full answers never enter MongoDB
```

- [ ] **Step 3: Verify production security**

When Student Assistant is enabled in production, require:

```env
STUDENT_ANONYMIZATION_SECRET=<32_PLUS_SECRET_DISTINCT_FROM_A_AND_B>
```

- [ ] **Step 4: Run focused suites**

```powershell
cd backend
node --test tests/studentActivities.test.js tests/studentQuestions.test.js tests/studentSessions.test.js
cd ..\converter
python -m pytest -q tests/test_student_accounting_map.py tests/test_student_anonymization.py tests/test_student_api.py tests/test_student_context.py tests/test_student_explanations.py tests/test_student_queries.py tests/test_student_reconciliation.py tests/test_student_reports.py
cd ..\frontend
node --test src/utils/studentAssistant.test.mjs
```

- [ ] **Step 5: Commit**

```powershell
git add backend converter frontend
git commit -m "feat: integrate feature-gated student assistant"
```

---

### Task 6: Reconcile Smart Voucher Phase 3 Without Regressing Main

**Files:**
- Modify: `backend/controllers/reconstructionController.js`
- Modify: `backend/models/ReconstructionDecision.js`
- Modify: `backend/models/ReconstructionProfile.js`
- Modify: `backend/models/VoucherReconstructionRun.js`
- Modify: `backend/routes/reconstructions.js`
- Modify: `backend/services/reconstructionProfileService.js`
- Modify: `backend/services/reconstructionRunService.js`
- Modify: `converter/app/ai_reconstruction_client.py`
- Modify: `converter/app/document_classification.py`
- Modify: `converter/app/document_grouping.py`
- Modify: `converter/app/document_structure.py`
- Modify: `converter/app/document_totals.py`
- Modify: `converter/app/reconstruction_profile_client.py`
- Modify: `converter/app/reconstruction_store.py`
- Modify: `converter/app/reconstruction_workflow.py`
- Modify: `converter/app/voucher_models.py`
- Modify: `converter/app/voucher_reconstruction.py`
- Modify: `frontend/src/components/reconstruction/FieldProvenanceBadge.jsx`
- Modify: `frontend/src/components/reconstruction/ReconstructionSummary.jsx`
- Modify: `frontend/src/components/reconstruction/SmartReconstructionPanel.jsx`
- Modify: `frontend/src/components/reconstruction/VoucherList.jsx`
- Modify: `frontend/src/components/reconstruction/VoucherReviewWorkspace.jsx`
- Modify: `frontend/src/hooks/useVoucherReconstruction.js`
- Modify: `frontend/src/utils/reconstruction.js`
- Test: existing reconstruction tests in all three services.

**Interfaces:**
- Consumes: main Phase 3 API and source final fixes.
- Produces: one canonical reconstruction contract, no duplicate route/model implementation.

- [ ] **Step 1: Compare public contracts, not whole files**

Build a contract table for route, method, request keys, response keys, feature flag and ownership. Keep the main signature when both versions are behaviorally equivalent; port source fixes only when covered by a source test absent on main.

- [ ] **Step 2: Enforce one implementation per symbol**

The manifest verifier must fail if two route modules mount the same reconstruction path or two models register the same Mongoose model name.

- [ ] **Step 3: Run reconstruction gates**

```powershell
cd backend
node --test tests/reconstructionController.test.js tests/reconstructionProfiles.test.js tests/reconstructionRuns.test.js
cd ..\converter
python -m pytest -q tests/test_ai_reconstruction.py tests/test_reconstruction_api.py tests/test_reconstruction_profile_client.py tests/test_reconstruction_store.py tests/test_voucher_reconstruction.py
cd ..\frontend
node --test src/utils/reconstruction.test.mjs
```

- [ ] **Step 4: Commit**

```powershell
git add backend converter frontend
git commit -m "feat: reconcile smart voucher reconstruction"
```

---

### Task 7: Port Accounting Operations And Mapping Profile V2

**Files:**
- Modify: `backend/controllers/mappingProfileV2Controller.js`
- Modify: `backend/models/MappingProfileV2.js`
- Modify: `backend/routes/mappingProfilesV2.js`
- Modify: `backend/services/mappingProfileMigrationService.js`
- Modify: `backend/services/mappingProfileV2MigrationService.js`
- Modify: `backend/services/mappingProfileV2Service.js`
- Modify: `backend/services/runtimeCapabilitiesService.js`
- Modify: `converter/app/accounting_assistant.py`
- Modify: `converter/app/anomaly_rules.py`
- Modify: `converter/app/anomaly_workflow.py`
- Modify: `converter/app/correction_workflow.py`
- Modify: `converter/app/evidence_packets.py`
- Modify: `converter/app/field_provenance.py`
- Modify: `converter/app/mapping_profile_v2.py`
- Modify: `converter/app/mapping_semantics.py`
- Modify: `converter/app/reconciliation_workflow_v2.py`
- Modify: `frontend/src/components/converter/AccountingAssistantDrawer.jsx`
- Modify: `frontend/src/components/converter/AnomalyWorkspace.jsx`
- Modify: `frontend/src/components/converter/BulkCorrectionDialog.jsx`
- Modify: `frontend/src/components/converter/MappingProfileV2Card.jsx`
- Modify: `frontend/src/components/converter/ReconciliationWorkspace.jsx`
- Modify: `frontend/src/utils/converterOperations.js`
- Test: related Mapping Profile V2, anomaly, correction, reconciliation and accounting assistant suites.

**Interfaces:**
- Consumes: signed owner scope, versioned conversion session, runtime capabilities.
- Produces: optional accounting assistance surfaces with deterministic backend authority.

- [ ] **Step 1: Port backend capability and profile boundary**

Preserve immutable profile version/hash, owner scope, quarantine and high-risk review. Migrations remain `off` by default.

- [ ] **Step 2: Port converter operations**

Preserve these invariants:

```text
AI only explains
deterministic rules own blocker/warning severity
correction patches are backend-issued IDs
evidence citations resolve only inside sealed evidence packets
reconciliation never labels insufficient data as success
```

- [ ] **Step 3: Port frontend surfaces behind backend capabilities**

Frontend must render only capabilities returned by Node/FastAPI intersection; Vite flags may hide a feature but cannot force-enable it.

- [ ] **Step 4: Run focused tests and commit**

```powershell
cd backend
node --test tests/mappingProfileV2.test.js tests/mappingProfileV2Contract.test.js tests/mappingProfileV2Migration.test.js tests/runtimeCapabilities.test.js
cd ..\converter
python -m pytest -q tests/test_accounting_assistant.py tests/test_anomaly_workflow.py tests/test_correction_workflow.py tests/test_mapping_profile_v2.py tests/test_mapping_semantics.py tests/test_reconciliation_workflow_v2.py
cd ..\frontend
npm test
git add ..\backend ..\converter .
git commit -m "feat: integrate accounting operations assistance"
```

---

### Task 8: Port MISA Import Repair Phase 1 Final State

**Files:**
- Modify: `backend/constants/misaImportRepair.js`
- Modify: `backend/controllers/misaImportRepairController.js`
- Modify: `backend/models/MisaImportIssue.js`
- Modify: `backend/models/MisaImportRepairSession.js`
- Modify: `backend/models/MisaRetryBatch.js`
- Modify: `backend/services/misaImportRepairService.js`
- Modify: `backend/services/misaImportRepairSweeper.js`
- Modify: `backend/routes/converterGateway.js`
- Modify: `converter/app/export_manifest.py`
- Modify: `converter/app/import_repair_export.py`
- Modify: `converter/app/import_result_matching.py`
- Modify: `converter/app/import_result_parser.py`
- Modify: `converter/app/import_result_workflow.py`
- Modify: `frontend/src/components/import-repair/ImportIssueWorkspace.jsx`
- Modify: `frontend/src/components/import-repair/ImportResultUploadStep.jsx`
- Modify: `frontend/src/components/import-repair/ImportSchemaMappingStep.jsx`
- Modify: `frontend/src/components/import-repair/MisaImportRepairPanel.jsx`
- Modify: `frontend/src/components/import-repair/MisaNewUserGuide.jsx`
- Modify: `frontend/src/components/import-repair/RetryBatchReview.jsx`
- Modify: `frontend/src/hooks/useConverterApi.js`
- Modify: `frontend/src/utils/importRepairUx.js`
- Test: `backend/tests/misaImportRepair*.test.js`
- Test: `backend/tests/misaImportRetry.test.js`
- Test: `converter/tests/test_import_*.py`
- Test: `converter/tests/test_excel_security.py`
- Test: `frontend/src/utils/importRepairUx.test.mjs`
- Test: `frontend/tests/misa-import-repair.integration.spec.mjs`

**Interfaces:**
- Consumes: immutable export manifest, artifact service, converter gateway and versioned repair session.
- Produces: upload failed-row workbook -> manual matching -> correction -> readiness -> whole-document retry -> downloadable real MISA template.

- [ ] **Step 1: Copy exact final-reviewed isolated files from `1a1d0e6`**

Do not copy shared `main.py`, `server.js`, `ConvertPage.jsx` or API files wholesale. Compose their route registrations in Task 9.

- [ ] **Step 2: Preserve binding constraints**

Tests must explicitly prove:

```text
manual_excel_v1 only
verified=false always
auto-match disabled
every match requires explicit confirmation
ambiguous/unknown blocks retry
retry expands to whole document_group
retry consumes zero additional credit
AI cannot mutate accounting/master/profile decisions
raw workbook absent from Mongo/log/JSON
real MISA template exporter retained
readiness hash/version handshake rejects stale state
issue and document-group pagination is complete
```

- [ ] **Step 3: Run focused suites**

```powershell
cd backend
node --test tests/misaImportRepairGateway.test.js tests/misaImportRepairModels.test.js tests/misaImportRepairSecurity.test.js tests/misaImportRetry.test.js
cd ..\converter
python -m pytest -q tests/test_excel_security.py tests/test_export_manifest.py tests/test_import_repair_export.py tests/test_import_result_api.py tests/test_import_result_matching.py tests/test_import_result_parser.py
cd ..\frontend
node --test src/utils/importRepairUx.test.mjs src/utils/converterGatewayContract.test.mjs
npx playwright test tests/misa-import-repair.integration.spec.mjs --workers=1 --reporter=line
```

Expected: zero failures; Playwright passes purchase, sales, multiline, warning, ambiguous, unknown, expiry/auth and mobile/keyboard journeys.

- [ ] **Step 4: Commit**

```powershell
git add backend converter frontend
git commit -m "feat: integrate final-reviewed MISA import repair"
```

---

### Task 9: Compose Shared Hotspots And Remove Conflict Debris

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/.env.example`
- Modify: `converter/app/main.py`
- Modify: `converter/.env.example`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/pages/ConvertPage.jsx`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/.env.example`
- Modify: `.env.example`
- Modify: `.gitignore`
- Delete from tracking: `frontend/.env.local`
- Delete from tracking: `frontend/test-results/.last-run.json`
- Do not import: `.superpowers/sdd/*-before/**`

**Interfaces:**
- Consumes: all vertical slices.
- Produces: one route graph, one dependency graph, one env contract and zero merge markers.

- [ ] **Step 1: Write route uniqueness tests**

Tests must fail on duplicate Express route mount, duplicate FastAPI path+method, duplicate React route or duplicate Mongoose model registration.

- [ ] **Step 2: Compose instead of choosing either side**

Required shared outcomes:

```text
App.jsx keeps main coupon/admin routes and adds lazy feature-gated Student route
server.js keeps main auth/payment/admin/coupon and adds guarded converter/student/reconstruction routes
main.py keeps one FastAPI app and one registration per endpoint
ConvertPage keeps main pricing/quota behavior and adds source operations/repair panels
api.js uses VITE_API_URL first and never exposes converter URL
```

- [ ] **Step 3: Clean tracked local/generated files**

Add:

```gitignore
.env.local
.env.*.local
frontend/.env.local
frontend/test-results/
.fastembed_cache/
.superpowers/brainstorm/
```

Remove tracked local/generated files from the integration index only; do not delete user-owned untracked files in the original workspace.

- [ ] **Step 4: Validate dependency manifests**

Run clean installs using existing locks:

```powershell
cd backend
npm ci
cd ..\frontend
npm ci
cd ..\converter
python -m pip install -r requirements.txt
```

Expected: no manual package-lock conflict editing; lock is regenerated only by npm.

- [ ] **Step 5: Scan for merge/config errors**

```powershell
rg -n "^(<<<<<<<|=======|>>>>>>>)" .
rg -n "VITE_PYTHON_API_URL|http://localhost:8000|http://localhost:5000" frontend/src frontend/.env.example
git diff --check
pwsh -File scripts/verify-transplant-manifest.ps1
```

Expected: no merge markers; no browser FastAPI/localhost production path; checks exit `0`.

- [ ] **Step 6: Commit**

```powershell
git add .env.example .gitignore backend converter frontend docs/integration
git commit -m "refactor: compose main and accounting feature surfaces"
```

---

### Task 10: Make Mongo Migrations Explicit And Reversible

**Files:**
- Modify: `backend/services/mappingProfileMigrationService.js`
- Modify: `backend/services/mappingProfileV2MigrationService.js`
- Modify: `backend/server.js`
- Create: `backend/scripts/preflight-production-migrations.js`
- Create: `docs/deployment/main-integration-migrations.md`
- Test: `backend/tests/mappingProfileMigration.test.js`
- Test: `backend/tests/mappingProfileV2Migration.test.js`

**Interfaces:**
- Consumes: existing Mongo models/indexes.
- Produces: dry-run report, explicit apply mode and documented rollback boundary.

- [ ] **Step 1: Prevent implicit destructive migration**

Startup default remains:

```env
MAPPING_PROFILE_V2_MIGRATION_MODE=off
```

No startup path may drop/backfill indexes unless mode is explicitly `apply`. Index compatibility checks may report blockers without mutation.

- [ ] **Step 2: Add preflight command**

`backend/scripts/preflight-production-migrations.js` must print counts/index plans only; it must not write when mode is `off` or `dry-run`.

- [ ] **Step 3: Test dry-run/apply/idempotency**

```powershell
cd backend
node --test tests/mappingProfileMigration.test.js tests/mappingProfileV2Migration.test.js
```

Expected: dry-run zero writes; apply idempotent; non-IndexNotFound failures fail closed.

- [ ] **Step 4: Commit**

```powershell
git add backend docs/deployment/main-integration-migrations.md
git commit -m "chore: make production migrations explicit"
```

---

### Task 11: Extreme Local QA/QC Release Gate

**Files:**
- Modify: `scripts/qa-main-integration.ps1`
- Create: `docs/qa/main-experimental-integration-final.md`
- Modify only generated summary after successful run: `docs/qa-last-run.json`, `docs/qa-log.md`

**Interfaces:**
- Consumes: completed integration branch.
- Produces: evidence-backed release candidate.

- [ ] **Step 1: Verify main has not moved**

```powershell
git fetch origin
git rev-parse origin/main
```

Expected: `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`. If different, stop; run `git merge-tree --write-tree origin/main HEAD`, resolve only the new delta, then restart Task 11.

- [ ] **Step 2: Run full backend suite**

```powershell
cd backend
node --test
```

Expected: zero failures; skips documented with exact environment reason.

- [ ] **Step 3: Run full converter suite**

```powershell
cd converter
python -m pytest -q --tb=short
```

Expected: zero failures; skips documented.

- [ ] **Step 4: Run frontend test/lint/build**

```powershell
cd frontend
npm test
npm run lint
npm run build
```

Expected: all exit `0`; existing chunk warning documented, not hidden.

- [ ] **Step 5: Run browser suites**

```powershell
cd frontend
npx playwright test tests/converter-gateway.integration.spec.mjs --workers=1 --reporter=line
npx playwright test tests/converter-gateway.api.integration.spec.mjs --workers=1 --reporter=line
npx playwright test tests/misa-import-repair.integration.spec.mjs --workers=1 --reporter=line
```

Expected: all journeys pass at desktop and 375/390px coverage already encoded by suites.

- [ ] **Step 6: Run workspace QA and security scans**

```powershell
cd ..
npm run qa:fast
npm run qa:main-integration
git diff --check
rg -n "^(<<<<<<<|=======|>>>>>>>)" .
```

Expected: all gates pass; no conflict markers.

- [ ] **Step 7: Independent final review**

Generate review package from `8d1a934..HEAD`. Reviewer must check main non-regression, security/privacy, accounting invariants, artifact-storage safeguards, migration safety and deploy docs. Critical/Important findings must be fixed and re-reviewed.

- [ ] **Step 8: Commit QA receipt**

```powershell
git add docs/qa/main-experimental-integration-final.md docs/qa-last-run.json docs/qa-log.md scripts/qa-main-integration.ps1
git commit -m "test: certify main-first production integration"
```

---

### Task 12: Staging Deploy With Feature Flags Off

**Files:**
- Create: `docs/deployment/main-experimental-release-runbook.md`
- Create: `docs/deployment/main-experimental-rollback-runbook.md`

**Interfaces:**
- Consumes: release candidate and Render/Vercel environments.
- Produces: live staging evidence and reversible production rollout.

- [ ] **Step 1: Backup MongoDB before first integrated backend start**

Record backup timestamp, cluster, database and restore command in the private deployment record. Do not store credentials in Git.

- [ ] **Step 2: Configure flags off**

Initial production/staging deployment:

```env
CONVERTER_PUBLIC_PROXY_ENABLED=false
CONVERTER_GATEWAY_USAGE_READY=false
STUDENT_ASSISTANT_ENABLED=false
VOUCHER_RECONSTRUCTION_ENABLED=false
FEATURE_MAPPING_PROFILE_V2=false
FEATURE_ANOMALY_DETECTION=false
FEATURE_BULK_CORRECTION=false
FEATURE_RECONCILIATION=false
FEATURE_ACCOUNTING_ASSISTANT=false
FEATURE_AI_EXPLANATION=false
```

- [ ] **Step 3: Deploy converter first**

```text
Render root: converter
Build: pip install -r requirements.txt
Start: uvicorn app.main:app --host 0.0.0.0 --port $PORT
Health: /healthz
```

Expected: health `200`; production security config passes.

- [ ] **Step 4: Deploy Node backend**

```text
Render root: backend
Build: npm ci
Start: npm start
Health: /api/health
```

Expected with flags off: health `200` even if converter is temporarily unavailable.

- [ ] **Step 5: Deploy Vercel frontend**

```text
Root: frontend
Build: npm run build
Output: dist
Env: VITE_API_URL=https://<node-render>.onrender.com
```

Expected: build passes; no `VITE_PYTHON_API_URL`.

- [ ] **Step 6: Smoke existing main product**

Verify login, Google login, ban handling, admin users/plans/revenue/files, pricing, coupon, PayOS callback status and normal navigation before enabling any new feature.

---

### Task 13: Progressive Feature Enablement And Production Promotion

**Files:**
- Modify: `docs/deployment/main-experimental-release-runbook.md`
- Create: `docs/qa/main-experimental-live-staging.md`

**Interfaces:**
- Consumes: healthy staging with flags off.
- Produces: all integrated functionality enabled only after its live gate passes.

- [ ] **Step 1: Enable converter gateway**

Set backend:

```env
CONVERTER_PUBLIC_PROXY_ENABLED=true
CONVERTER_GATEWAY_USAGE_READY=true
CONVERTER_ARTIFACT_STORAGE_DRIVER=mongodb
CONVERTER_MONGODB_GRIDFS_BUCKET=ezformatArtifacts
CONVERTER_OBJECT_STORAGE_REQUIRED=false
```

Test live raw upload -> mapping -> validation -> preview -> real MISA export. Restart backend during a disposable in-flight session and verify the UI reports expiry/unavailable truthfully rather than corrupt success.

- [ ] **Step 2: Enable Smart Voucher**

Enable Node, converter and Vite flags together. Test goods, service and mixed document fixtures; keep AI offline once to prove deterministic fallback.

- [ ] **Step 3: Enable Student Assistant**

Set dedicated anonymization secret and matching flags. Test explanation, questions, accounting map, reconciliation and internship support; confirm no grading UI/state.

- [ ] **Step 4: Enable accounting operations one capability at a time**

Order:

```text
Mapping Profile V2
Anomaly Detection
Bulk Correction
Reconciliation
Accounting Assistant
AI Explanation
```

Do not enable the next capability until owner isolation, stale-version rejection and AI-offline behavior pass for the current capability.

- [ ] **Step 5: Enable MISA import repair**

Test purchase, sales, multiline, warnings, ambiguous/unknown blockers, explicit whole-document acknowledgement and zero retry credit against live staging APIs.

- [ ] **Step 6: Production promotion**

Create release tag only after live staging evidence is complete. Merge integration branch into `main`, rerun `npm run qa:main-integration` on the merged result, then deploy the exact tested SHA.

- [ ] **Step 7: Rollback drill**

If startup, auth/payment regression, conversion corruption or error thresholds fail:

```text
disable new feature flags first
redeploy rollback/main-pre-experimental-integration-20260730-055323 if core product remains unhealthy
restore Mongo backup only when a confirmed migration caused data/index damage
retain failed release logs and artifact metadata; never retain raw customer workbook in logs
```

- [ ] **Step 8: Final feature inventory**

Update the full feature inventory with `implemented`, `partial`, `removed`, `uncertain` and live-deployment evidence. Distinguish code-complete from live-verified.

---

## Conflict Resolution Appendix

### Keep main or compose manually

```text
.env.example
backend/.env.example
backend/controllers/accountingWorkspaceController.js
backend/controllers/conversionRunController.js
backend/routes/internal.js
backend/server.js
backend/services/conversionContextService.js
backend/services/conversionCreditService.js
backend/services/mappingProfileService.js
converter/.env.example
converter/app/ai_gateway.py
converter/app/excel_io.py
converter/app/main.py
converter/app/mapping_profile_client.py
converter/app/master_data_client.py
converter/app/misa_profiles.py
converter/app/misa_readiness.py
converter/app/misa_workflow.py
converter/tests/test_master_data_workflow.py
converter/tests/test_misa_profile_api.py
converter/tests/test_misa_readiness.py
frontend/.env.example
frontend/package.json
frontend/src/components/admin/AdminLayout.jsx
frontend/src/pages/ConvertPage.jsx
frontend/src/services/api.js
```

### Source-owned isolated modules, then verify contracts

```text
backend/controllers/studentSessionController.js
backend/routes/reconstructions.js
backend/routes/student.js
converter/app/ai_reconstruction_client.py
converter/app/reconstruction_workflow.py
converter/app/student_anonymization.py
converter/app/student_context.py
converter/app/student_models.py
converter/app/student_queries.py
converter/app/student_session_client.py
converter/app/student_workflow.py
frontend/src/components/student/*
frontend/src/hooks/useStudentAssistantApi.js
frontend/src/hooks/useVoucherReconstruction.js
frontend/src/pages/StudentAssistantPage.jsx
frontend/src/utils/studentAssistant.js
```

### Regenerate or exclude

```text
.superpowers/sdd/progress.md
docs/qa-last-run.json
docs/qa-log.md
frontend/test-results/.last-run.json
frontend/.env.local
.superpowers/sdd/*-before/**
```

## Acceptance Criteria

Release is acceptable only when all are true:

- `main` auth, payment, PayOS, admin, pricing, plan and coupon tests pass unchanged.
- No unresolved Git conflict or merge marker exists.
- Frontend never calls FastAPI directly and never embeds localhost production URLs.
- Backend starts with feature flags off and missing optional converter config.
- Backend starts with gateway on only when secrets and exact local-storage acknowledgement are valid.
- No S3 variables are required.
- Converter production startup uses Node operation store and HTTPS internal URLs.
- Full backend, converter, frontend, lint, build and Playwright suites pass.
- MISA mapping/export still uses real templates for purchase and sales.
- MISA repair final-review invariants remain intact.
- AI offline leaves deterministic conversion/validation/export usable.
- Mongo migrations are off by default, dry-runnable and idempotent when applied.
- Staging live journey covers Vercel -> Node -> converter, not intercepted APIs only.
- Rollback branch resolves to the exact pre-integration main SHA.
- Final production deploy uses the same SHA certified in staging.

## Explicit Non-Goals

- Khong them single-instance artifact-storage limitation; MongoDB/GridFS la storage contract duy nhat khi artifact mode bat.
- Khong them S3, R2, MinIO hoac provider object storage moi.
- Khong fine-tune AI.
- Khong sua nghiep vu PayOS/coupon/plan neu khong co regression test fail.
- Khong xoa Experimental hoac phase branch sau integration.
- Khong claim production-grade truoc live staging gate.
