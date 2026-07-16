# MISA Company Workspace + Master Data Implementation Plan

**Goal:** Add a MongoDB-backed company workspace and MISA master-data reconciliation layer so conversions can verify supplier/customer/item/account/warehouse/unit codes against the selected company's active catalog snapshot.

**Architecture:** The authenticated Node backend owns durable tenant data, snapshots, aliases, and short-lived conversion context tokens. FastAPI remains the Excel compute service: it parses catalog files, resolves mapped MISA rows against a signed workspace context, and adds deterministic readiness issues. The frontend keeps direct converter uploads for performance but obtains a signed context token from Node first.

**MVP scope:** Single-owner workspaces with a schema ready for members; catalogs for account, supplier, customer, item, warehouse, and unit; immutable snapshots; exact matching and confirmed aliases; grouped unresolved values; readiness/export gating. No direct MISA API, no automatic fuzzy acceptance, no automatic master-data creation.

---

## Task 1: Backend domain models and pure services

**Create:**
- `backend/models/AccountingWorkspace.js`
- `backend/models/MasterDataSnapshot.js`
- `backend/models/MasterDataEntry.js`
- `backend/models/MasterDataAlias.js`
- `backend/services/masterDataService.js`
- `backend/tests/masterData.test.js`

Steps:
1. Write model/service tests first for workspace ownership, snapshot status, supported catalog types, normalization, entry deduplication, strong matching, alias matching, conflicts, and grouped unresolved values.
2. Run `node --test backend/tests/masterData.test.js` and confirm RED because modules are missing.
3. Implement strict Mongoose schemas with compound indexes and pure service functions.
4. Run the test again and confirm GREEN.

## Task 2: Backend authenticated workspace APIs

**Create:**
- `backend/controllers/accountingWorkspaceController.js`
- `backend/routes/accountingWorkspaces.js`
- `backend/services/conversionContextService.js`
- `backend/tests/accountingWorkspaces.test.js`

**Modify:**
- `backend/server.js`
- `backend/models/ConversionRun.js`
- `backend/services/conversionRunService.js`

Endpoints:
- `GET /api/accounting-workspaces`
- `POST /api/accounting-workspaces`
- `GET /api/accounting-workspaces/:id`
- `PATCH /api/accounting-workspaces/:id`
- `DELETE /api/accounting-workspaces/:id`
- `POST /api/accounting-workspaces/:id/conversion-context`
- `GET /api/accounting-workspaces/:id/master-data`
- `POST /api/accounting-workspaces/:id/aliases`
- `GET /api/internal/master-data/context/:snapshotSetHash`

Steps:
1. Write controller/service tests first using injected model doubles; verify unauthorized workspace access, token claims, alias scoping, and serialization.
2. Run tests and confirm RED.
3. Implement APIs under `requireDb` and `protect`; internal endpoint requires `CONVERTER_SERVICE_TOKEN`.
4. Attach optional workspace/snapshot metadata to conversion runs.
5. Run backend tests and confirm GREEN.

## Task 3: Converter catalog parser

**Create:**
- `converter/app/master_data.py`
- `converter/tests/test_master_data.py`
- `converter/tests/test_master_data_api.py`

**Modify:**
- `converter/app/main.py`
- `converter/app/models.py`

Endpoint:
- `POST /api/v1/master-data/parse` with `file` and `catalog_type`.

Steps:
1. Write failing tests for `.xlsx` and `.xls`, header detection, leading-zero preservation, supported catalog types, duplicate codes, and normalized output.
2. Implement parser using existing Excel readers and deterministic header aliases.
3. Return entries and parse warnings; never persist the file.
4. Run converter tests and confirm GREEN.

## Task 4: Backend catalog import and snapshot activation

**Create:**
- `backend/services/converterClient.js`
- `backend/tests/masterDataImport.test.js`

**Modify:**
- `backend/controllers/accountingWorkspaceController.js`
- `backend/routes/accountingWorkspaces.js`

Endpoints:
- `POST /api/accounting-workspaces/:id/master-data/imports`
- `POST /api/accounting-workspaces/:id/master-data/snapshots/:snapshotId/activate`
- `DELETE /api/accounting-workspaces/:id/master-data/snapshots/:snapshotId`

Steps:
1. Write failing tests for file validation, idempotent file hash, converter parse failure, entry replacement, immutable active snapshots, and activation.
2. Use Multer memory storage, call converter parse API with native `fetch`, save normalized entries in Mongo, and discard raw bytes.
3. Activate a snapshot only after successful parse; archive the previous active snapshot of the same type.
4. Run backend tests and confirm GREEN.

## Task 5: Signed conversion context and converter resolver

**Create:**
- `converter/app/master_data_client.py`
- `converter/app/master_data_resolver.py`
- `converter/tests/test_master_data_resolver.py`

**Modify:**
- `converter/app/main.py`
- `converter/app/misa_workflow.py`
- `converter/app/misa_readiness.py`
- `converter/app/models.py`

Steps:
1. Write failing tests for token verification, context fetch authorization, exact code, exact tax code, confirmed alias, account exact-only policy, ambiguous name suggestions, required missing codes, and snapshot hash consistency.
2. Implement HMAC/JWT verification using `CONVERSION_CONTEXT_SECRET` and internal context fetch using `NODE_INTERNAL_API_URL` + `CONVERTER_SERVICE_TOKEN`.
3. Store workspace/snapshot claims in upload metadata and reject preview/readiness/export with a different context.
4. Add readiness statuses: verified, suggested, missing, conflict, and not_checked. Only missing required/conflict are blockers; suggestions/not_checked are warnings.
5. Run focused and full converter tests.

## Task 6: Frontend workspace and catalog management

**Create:**
- `frontend/src/hooks/useAccountingWorkspaces.js`
- `frontend/src/components/accounting/WorkspaceSelector.jsx`
- `frontend/src/components/accounting/WorkspaceSetupModal.jsx`
- `frontend/src/components/accounting/MasterDataManager.jsx`
- `frontend/src/components/accounting/MasterDataResolutionTable.jsx`
- `frontend/src/pages/AccountingWorkspacePage.jsx`

**Modify:**
- `frontend/src/App.jsx`
- `frontend/src/components/Navbar.jsx`
- `frontend/src/hooks/useConverterApi.js`
- `frontend/src/pages/ConvertPage.jsx`

Steps:
1. Add node tests for pure workspace/resolution helpers before component code.
2. Build single-company-first onboarding with name, tax code, and MISA product.
3. Allow progressive catalog upload; do not require all catalog types.
4. Obtain conversion context before analyze and pass it through analyze/preview/readiness/export.
5. Group unresolved values by unique raw value and let users select, confirm, and save aliases.
6. Display explicit “Chưa kiểm tra danh mục MISA” when no active snapshot exists.
7. Run frontend lint, format check, and build.

## Task 7: Integration, security, and QA

**Modify tests/docs as needed:**
- `backend/tests/*.test.js`
- `converter/tests/*.py`
- `docs/qa-log.md`

Steps:
1. Verify tenant isolation and internal API authentication.
2. Verify raw catalog bytes are not stored in Mongo or local disk.
3. Verify leading-zero codes, duplicate codes, tax-code conflicts, account exact-only matching, aliases, stale context, and converter restart persistence.
4. Run backend node tests, full converter pytest, frontend lint/build/format, and `npm run qa:fast`.
5. Run manual local flow: create workspace, upload catalog, convert sample, resolve unmatched values, export, repeat and confirm alias reuse.
6. Record evidence in QA docs.

## Acceptance criteria

- Authenticated users can create and select a company workspace.
- Workspace catalogs persist in MongoDB and are isolated by workspace.
- Catalog uploads create versioned snapshots and raw bytes are discarded after parsing.
- Converter uses a signed, short-lived workspace context and cannot switch context between analyze and export.
- Exact codes/tax codes and confirmed aliases resolve deterministically.
- Fuzzy/name matches never auto-confirm.
- Required unresolved/conflicting master data blocks export; missing context and suggestions require acknowledgement.
- Corrections are reusable on later conversions for the same workspace only.
- Existing conversion without a workspace remains available with an explicit not-checked warning.
- Backend, converter, frontend, and QA scripts pass.
