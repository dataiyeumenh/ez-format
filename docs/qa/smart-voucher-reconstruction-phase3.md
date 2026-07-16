# Smart voucher reconstruction Phase 3 QA

Date: 2026-07-14

## Scope

QA covers the Phase 1 company/master-data workspace and the Phase 3 smart voucher
reconstruction flow across the React frontend, Node/MongoDB backend, FastAPI
converter, real MISA templates, Redis draft storage, and the optional AI boundary.

## Automated gates

- Backend Node tests: 76 passed.
- Converter Python tests: 201 passed.
- Focused reconstruction/security tests: 33 passed.
- Frontend reconstruction utility tests: 4 passed.
- Frontend ESLint: passed.
- Frontend Prettier check: passed.
- Frontend production build: passed.
- Python `compileall`: passed.
- Node syntax check for all changed JavaScript files: passed.
- Python dependency consistency (`pip check`): passed.
- Root, backend, and frontend production dependency audits: 0 known vulnerabilities.
- Workspace `npm run qa:fast`: 5/5 checks passed.
- Changed-file secret scan: no private key, service credential, API key, or MongoDB
  credential pattern found.

## Phase 1 + Phase 3 API integration

Executed against isolated services and MongoDB:

- Node backend: `127.0.0.1:5100`.
- FastAPI converter: `127.0.0.1:8100`.
- MongoDB replica set: `127.0.0.1:27018`.

Verified end to end:

1. Register owner and unrelated users.
2. Create a company workspace.
3. Import and activate supplier, item, and account catalogs.
4. Search active master data.
5. Reject cross-tenant workspace and reconstruction access.
6. Create a signed reconstruction context and analyze a mixed purchase workbook.
7. Group three source rows into two vouchers without losing or duplicating rows.
8. Classify one goods voucher and one service voucher.
9. Edit a draft and reject a stale revision.
10. Split and merge vouchers while conserving all source rows.
11. Validate the latest revision and require explicit review for inferred direction.
12. Save, activate, and reuse a versioned reconstruction profile.
13. Reject a context token from another run.
14. Approve warnings explicitly and export two real MISA templates in one ZIP.
15. Preserve merged cells and column widths in both exported `.xls` files.
16. Re-download the same run without charging another conversion credit.
17. Record the exported state, metrics, profile version, and charged timestamp in
    MongoDB.

Result: passed. Analyze time was about 0.68 seconds; profile reuse was about 0.64
seconds on the isolated local QA stack.

## Browser QA

Playwright/Chrome covered desktop and mobile (`390x844`) with 23 assertions:

- Login and conversion-mode navigation.
- Converter readiness and Phase 1 workspace/catalog display.
- Workbook upload and Phase 3 analysis.
- Goods/service voucher rendering.
- Field edit, reclassification, split, merge, and profile save from the UI.
- Validation with zero blockers and two explicit review warnings.
- Warning acknowledgement, approval, and ZIP download.
- No page-level horizontal overflow on mobile.
- All visible buttons and form controls have accessible names.
- No browser console errors, failed API responses, or actionable network failures.

Result: passed. Browser-observed analyze time was about 0.88 seconds.

## Security and durability

- Raw workbook bytes are held in temporary storage only during analyze and are
  cleaned after processing.
- MongoDB run/profile/audit collections contain metadata and structural decisions,
  not raw transaction rows.
- QA scans found none of the sample invoice number, supplier name, tax code, item
  code, or transaction amounts in MongoDB run/profile/audit documents or service
  logs.
- AI reconstruction payloads redact transaction values before remote HTTP calls.
- AI response schemas cannot change amounts, validation severity, or the export
  gate.
- Redis persistence smoke test passed across two independent store instances,
  including stale-revision CAS rejection.
- Production Redis configuration rejects non-TLS `redis://` URLs.
- Beta workspace allowlisting and shadow-mode export blocking have automated tests.

## Performance

The 10,000-row benchmark produced 5,000 vouchers with p95 analyze time of 2.588
seconds, below the 15-second Phase 3 target. Evidence is stored in
`.artifacts/qa-phase3/benchmark-result.json`.

## Rollout decision

The branch is ready for a controlled shadow/beta deployment with the documented
feature flags and Redis TLS store. Global production enablement still requires
post-deploy shadow comparison on representative customer files before disabling
`RECONSTRUCTION_SHADOW_MODE`; this is an operational launch gate, not a failing
local code or QA check.

Rollback and environment configuration are documented in
`docs/SMART_VOUCHER_RECONSTRUCTION_DEPLOYMENT.md`.
