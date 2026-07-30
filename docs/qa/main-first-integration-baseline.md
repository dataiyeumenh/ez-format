# Main-First Integration Baseline

Baseline commit: `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`

Captured before feature integration on 2026-07-30 from the unchanged main baseline.

## Gate

Release-mode command (fail-closed; requires replica MongoDB, real GridFS, and live gateway evidence):

```powershell
npm run qa:main-integration
```

Local code-only/incomplete command (explicitly non-release):

```powershell
npm run qa:main-integration:local-incomplete
```

Both modes run, in order, backend `node --test`, converter `python -m pytest -q --tb=short`, frontend `npm test`, `npm run lint`, and `npm run build`. Release mode stops before the matrix with nonzero status when mandatory external evidence is absent. Local incomplete mode records exact skips and never certifies production readiness.

## Results

Results from the unchanged main baseline:

| Step | Result |
|---|---|
| Backend `node --test` | 134 tests, 134 passed, 0 failed, 0 skipped |
| Converter `python -m pytest -q --tb=short` | 329 passed in 146.92s, 0 failed, 0 skipped |
| Frontend `npm test` | 48 tests, 48 passed, 0 failed, 0 skipped |
| Frontend `npm run lint` | Passed, exit code 0 |
| Frontend `npm run build` | Passed, exit code 0; 2,463 modules transformed; built in 8.05s |

Pre-existing skips: none.

Pre-existing failures: none.

## Task 3 Payment Settlement Follow-up (2026-07-30)

- `node --test tests/paymentStatusSync.test.js tests/paymentSettlementReadiness.test.js tests/serverStartupReadiness.test.js tests/paymentReplicaSet.integration.test.js`: 14 passed, 0 failed; 3 real-Mongo tests skipped because `PAYMENT_REPLICA_SET_TEST_URI` is not set.
- `npm run qa:main-contracts`: 51 passed, 0 failed, including payment transaction readiness and startup preflight checks.
- The opt-in Mongo tests require a disposable replica-set URI ending in `-test` or `_test`; they exercise duplicate webhooks, transaction rollback, and a forced concurrent write-conflict retry.

## Task 3 P1 Coupon Webhook Settlement (2026-07-30)

- `CouponUsage.payment` now has a unique partial index for non-null payment IDs; duplicate PayOS settlement snapshots upsert one usage and increment the coupon once.
- Coupon usage runs inside the same PayOS payment transaction as the user credit and payment status update; non-coupon payments remain unchanged.
- `qa:main-contracts` includes the replica-set coupon settlement regression. Without `PAYMENT_REPLICA_SET_TEST_URI`, that real-Mongo coverage is explicitly skipped rather than reported as passed.
- Latest `npm run qa:main-contracts`: 52 passed, 0 failed, 4 replica-set tests skipped because `PAYMENT_REPLICA_SET_TEST_URI` is not set; the frontend payment contract passed (1 test).

## Task 3 Final Settlement Gate (2026-07-30)

- Zero-total checkout now calls the same idempotent transaction settlement service as a paid PayOS callback; payment status, entitlement, and coupon usage roll back together on payment or coupon persistence failure.
- Startup explicitly calls `CouponUsage.collection.createIndex` for the unique partial `{ payment: 1 }` index. A migration error leaves payment settlement not ready and causes configured PayOS startup to fail closed.
- Local `npm run qa:main-contracts`: backend 62 total, 57 passed, 0 failed, 5 skipped; frontend payment contract 1 passed. The five skipped tests are the explicit real-Mongo replica-set suite because `PAYMENT_REPLICA_SET_TEST_URI` is not set.
- Replica-set status is printed as `SKIPPED` or `EXECUTED` by `qa:main-contracts`. When all PayOS credentials are configured, a missing or non-test `PAYMENT_REPLICA_SET_TEST_URI` fails the gate before contracts run; the local non-PayOS baseline may skip with the reason shown above.

## Task 3 Remaining Findings Closure (2026-07-30)

- Non-paid and mismatched PayOS webhook paths now use `applyNonPaidPaymentStatus` inside the payment transaction. The stored payment is re-read and a `paid` row is never downgraded; a later paid retry cannot re-grant entitlement. Unit coverage: `paymentStatusSync.test.js` and `paymentWebhookTransition.test.js`.
- Coupon settlement now reserves `usageCount` with a conditional `$expr` update, checks `limitPerUser` in the same transaction, then creates the unique payment usage. Paid and zero-total settlements share this path; duplicate payment snapshots remain idempotent.
- Coupon coverage adds unit global/per-user limit regressions plus replica-set concurrent paid-global and zero-total-per-user tests. Local run: real replica-set URI unavailable, so 7 replica tests were explicitly skipped; no replica result is reported as passed.
- Payment UI coupon editing clears `appliedCoupon`; rendered contract coverage now has 2 passing tests.
- `REQUIRE_REPLICA_TESTS=1` is independent of PayOS secrets. Release `qa:main-integration` enforces replica, GridFS, and live gateway evidence; `qa:main-integration:local-incomplete` may report explicit skips. Local `qa:main-contracts` skips when the release flag is absent.
- Focused result: backend 20/20 pass; frontend payment contract 2/2 pass. Latest `npm run qa:main-contracts`: backend 64 pass, 0 fail, 9 explicit replica skips; frontend 2/2 pass.

## Task 8 Review Findings Closure (2026-07-30)

- Backend focused command (`misaImportRepairGateway`, models, security, retry, and conversion artifacts): 124 total, 121 passed, 0 failed, 3 explicit Mongo-dependent skips.
- Frontend utility/contract command (`importRepairUx` and `converterGatewayContract`): 14 passed, 0 failed, 0 skipped.
- Converter focused command: 76 total, 66 passed, 1 skipped, 9 expected integration failures. The failures are two missing internal repair exports plus seven import-result endpoint/parse-slot checks because `converter/app/main.py` composition is owned by Task 9 and is intentionally unchanged in Task 8.
- Task 8 converter unit coverage for manifest identity, import-result matching, and parser normalization: 46 passed, 1 Task 9 composition-dependent endpoint test skipped.
