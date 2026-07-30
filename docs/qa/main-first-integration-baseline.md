# Main-First Integration Baseline

Baseline commit: `8d1a9343dc98a8abb715fe7efc8df9adf65a10fa`

Captured before feature integration on 2026-07-30 from the unchanged main baseline.

## Gate

Command:

```powershell
npm run qa:main-integration
```

The gate runs, in order, backend `node --test`, converter `python -m pytest -q --tb=short`, frontend `npm test`, `npm run lint`, and `npm run build`. It stops at the first failure.

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
