# Task 3 Report: Preserve Main Product Contracts

## Status

Complete. Added focused main-product contract test wiring only. No runtime main-owned files changed.

## Files committed

- `package.json`: adds `qa:main-contracts`.
- `scripts/qa-main-contracts.ps1`: runs explicit Node test paths from the backend and frontend directories; no shell globs.
- `backend/tests/authContracts.test.js`: active email/password and Google login success; inactive accounts remain blocked.
- `backend/tests/adminContracts.test.js`: self edit/ban guard; admin users, plans, revenue, files, coupon routes; server auth/admin/payment/revenue mounts.
- `backend/tests/paymentStatusSync.test.js`: PayOS status mapping and paid per-file credit synchronization.
- `frontend/src/pages/PaymentPage.contract.test.mjs`: coupon preview, applied-code checkout, and coupon input UI contract.

## Selected tests and rationale

- `backend/tests/authContracts.test.js`: locks local and Google login controller behavior without replacing either route handler.
- `backend/tests/adminContracts.test.js`: locks self-protection and mounted main admin route contracts.
- `backend/tests/plans.test.js`, `backend/tests/paymentPlans.test.js`, `backend/tests/dailyFileCredit.test.js`: protect plan dates, plan normalization, and `fileCredits` transitions.
- `backend/tests/paymentStatusSync.test.js`: protects PayOS status synchronization using the real sync service.
- `backend/tests/coupons.test.js`: protects coupon normalization, availability, serialization, and discount calculations.
- `frontend/src/pages/PaymentPage.contract.test.mjs`: protects frontend coupon preview/create payment wiring where no React component test runner exists.

## Test-first evidence

Baseline command before wiring:

```text
npm error Missing script: "qa:main-contracts"
```

## Verification

Command:

```powershell
npm run qa:main-contracts
```

Output summary:

```text
Backend: 38 passed, 0 failed, 0 skipped
Frontend: 1 passed, 0 failed, 0 skipped
```

`git diff --check` also completed without whitespace errors.

## Commit

`f52c96f test: lock production product contracts`

## Concerns

- Auth and PayOS tests exercise real controllers/services with isolated model/client seams; they do not call a live MongoDB or PayOS sandbox.
- The frontend coupon assertion is source-level because this repository has no installed React component-test runner. Browser-flow coverage remains a future QA concern.

## Reviewer Follow-up (2026-07-30)

### Status

Complete. Addressed all Task 3 reviewer findings. Runtime main-owned files remain unchanged.

### Changes

- `backend/tests/authContracts.test.js`: starts a real Express HTTP server with the real auth router mounted at `/api/auth`; mocks only the database guard/model seam and Google credential provider. Covers login validation, active login, inactive login, and active/inactive Google login.
- `backend/tests/paymentStatusSync.test.js`: invokes PayOS synchronization twice and verifies the paid per-file credit total remains exactly `3` with one payment save.
- `backend/tests/adminContracts.test.js`: replaces private Express `_router.stack` inspection with HTTP checks for users, plans, revenue, files, coupons, payments, and both revenue aliases.
- `frontend/src/pages/PaymentPage.contract.test.mjs`: renders `PaymentPage` in jsdom, types and applies a coupon, observes the rendered applied state, then verifies payment creation receives that coupon code.
- `frontend/package.json`, `frontend/package-lock.json`, `scripts/qa-main-contracts.ps1`: add the Vitest/jsdom/Testing Library harness and run the rendered frontend contract test from `qa:main-contracts`.

### Verification

Command:

```powershell
npm run qa:main-contracts
```

Output:

```text
Backend: 38 passed, 0 failed, 0 skipped
Frontend: 1 test file passed, 1 test passed
Exit code: 0
```

### Commit

`fec3a31 test: strengthen main contract coverage`

### Concerns

- Contract tests mock database and external-provider seams; they do not exercise live MongoDB, Google, or PayOS services.
- Installing the frontend test harness reported `8` dependency-audit findings (4 moderate, 3 high, 1 critical); remediation is outside this focused test-contract change.

## Payment Idempotency Fix (2026-07-30)

### Status

Complete. Paid PayOS settlement now reloads the persistent payment and performs the payment transition plus user-plan/credit grant inside one MongoDB transaction.

### Changes

- `backend/services/paymentStatusSync.js`: transactionally reloads the payment, short-circuits an already-paid record, applies the plan, then saves user and payment in one transaction. A failed payment save rolls back the user credit mutation.
- `backend/controllers/paymentController.js`: routes paid webhook delivery through the same transactional settlement path; removes the stale snapshot's second payment save after a successful sync.
- `backend/tests/paymentStatusSync.test.js`: adds independent-pending-snapshot, payment-save-rollback, concurrent-delivery, and duplicate-webhook regressions.

### Verification

```powershell
node --test tests/paymentStatusSync.test.js
npm run qa:main-contracts
```

Output: focused payment suite `6/6` passed. Main contracts: backend `42/42` passed; frontend `1/1` passed.

### Concern

- Atomic settlement relies on MongoDB transaction support. Production PayOS processing must use a replica set or sharded MongoDB deployment; a standalone MongoDB instance rejects transactions instead of risking a partial credit grant.
