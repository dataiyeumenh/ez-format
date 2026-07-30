# Task 4 Report

## Status

Implemented and committed on `codex/main-experimental-production-integration`.

Implementation commit: `f6bbcef` (`feat: add deploy-safe converter gateway foundation`)

## Files

- Backend: gated converter context/public/internal routes and startup readiness.
- Backend: MongoDB/GridFS adapter with bounded streaming, SHA-256 validation, generated object IDs, and delete compensation.
- Backend: `ConversionArtifact` metadata model, publish/read/delete service, tombstones, indexes, and bounded sweeper.
- Converter: internal service-token authentication, production config checks, signed context owner binding, Node operation-store client/provider, and operation models.
- Frontend: Node API-only boundary using `VITE_API_URL || VITE_NODE_API_URL`; removed direct FastAPI browser calls; added production env guard.
- Tests: startup matrix, GridFS adapter, artifact lifecycle, converter auth/store, and frontend API contract coverage.

## Verification

All commands passed:

```text
backend: node --test tests/converterGatewayStartup.test.js tests/conversionArtifacts.test.js
5 passed

backend: node --test tests/mongoGridFsArtifactStorage.test.js
2 passed

converter: python -m pytest -q tests/test_internal_auth.py tests/test_operation_store.py
3 passed

frontend: npm test
50 passed

backend main contracts: node --test tests/serverStartupReadiness.test.js tests/authContracts.test.js tests/adminContracts.test.js tests/paymentSettlementReadiness.test.js tests/coupons.test.js
24 passed

syntax: node --check gateway files; python -m py_compile gateway files
passed
```

Gateway-off and gateway-on module-load checks both passed. Gateway-on startup was not run against a live MongoDB/GridFS instance.

## Concerns

- No live MongoDB/GridFS or replica-set environment was available; reachability and real GridFS cleanup still need staging evidence.
- Converter operation-store tests cover provider/config contracts, not a live Node-to-converter HTTP round trip.
- `backend/routes/internalConverterSessions.js` now exposes the minimal state/artifact bridge required by the Node operation-store client; later operation features may extend this route surface.
- Existing `.superpowers/sdd/progress.md` was preserved unstaged.

---

## Reviewer Important/Minor Closure (2026-07-30)

### Status

PASS for the requested Task 4 focused scope. All reviewer findings were reproduced with failing regressions, fixed, and re-run.

Reviewer-fix commit: `86b8573` (`fix: close Task 4 gateway review findings`)

### Changes

- GridFS upload/delete compensation now creates durable redacted tombstones with `purgeAt`; pending tombstones remain outside terminal TTL deletion and are included in each bounded sweep.
- Sweeps mark metadata `deletion_pending` before touching bytes, continue after per-candidate storage/repository failures, and log/return only redacted failure code/status data.
- Legacy `purgeAt_1` TTL setup is removed before the new terminal-status-only TTL index is created.
- GridFS reads now return bounded readable streams. Service checksum/length verification stays streaming; internal artifact downloads use `pipeline`, while JSON state accumulation has a 2 MiB bound.
- `/api/converter/templates` remains user-authenticated at Node and service-authenticated at FastAPI, but no longer requires a conversion context unavailable during initial browser status loading.
- Removed the Vite `/python-api` proxy and direct FastAPI frontend env/docs examples. Deployment guidance now sends browser traffic only through Node.
- Runtime, tests, env example, and deployment docs now use only `CONVERTER_MONGODB_GRIDFS_BUCKET`.

### Verification

```text
backend: node --test tests/converterGatewayStartup.test.js tests/conversionArtifacts.test.js tests/mongoGridFsArtifactStorage.test.js tests/serverStartupReadiness.test.js
25 passed, 0 failed

converter: python -m pytest -q tests/test_internal_auth.py tests/test_operation_store.py
3 passed

frontend: npm test
51 passed, 0 failed

frontend: npm run lint
passed

backend syntax: node --check on changed gateway/artifact/model/route files
passed

frontend: npm run build
prebuild environment guard passed; Vite build then failed on the pre-existing missing `frontend/src/utils/converterOperations.js` import from `frontend/src/hooks/useStudentAssistantApi.js`.
```

### Remaining Evidence Gap

- No live MongoDB/GridFS service was configured locally; real bucket/index migration and cleanup remain staging checks.

---

## Stream Lifecycle Blocker Closure (2026-07-30)

### Changes

- GridFS download readers are composed with the bounded transform, forwarding source and size-limit errors through the returned stream.
- Conversion artifact verification is composed with the source stream, forwarding source, size-mismatch, and checksum errors into the HTTP `pipeline`.
- Added focused regressions for GridFS source failure, HTTP pipeline source failure, and streamed size mismatch termination.

### Verification

```text
backend: node --test tests/converterGatewayStartup.test.js tests/conversionArtifacts.test.js tests/mongoGridFsArtifactStorage.test.js tests/serverStartupReadiness.test.js
28 passed, 0 failed

syntax: node --check services/mongoGridFsArtifactStorage.js services/conversionArtifactService.js
passed
```
