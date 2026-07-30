# Task 6 Report

## Status

Implemented Smart Voucher Phase 3 reconciliation against exact source
`1a1d0e6971ccf5bd1140e676c63a5210a1111cbe`. Intended commit message:
`feat: reconcile smart voucher reconstruction`.

## Contract Reconciliation

| Surface | Canonical contract | Feature gate | Ownership |
| --- | --- | --- | --- |
| Run creation | `POST /api/reconstructions`; `fileName`, `fileSizeBytes`, `workspaceId`, `mode`, `targetTemplateId`; returns `run` and `contextToken` | `VOUCHER_RECONSTRUCTION_ENABLED=true` | authenticated user; workspace resolved by the main controller |
| Run/profile metadata | `GET /api/reconstructions`, `GET /api/reconstructions/:id`, `POST /api/reconstructions/:id/profiles`, `POST /api/reconstructions/profiles/:profileId/activate` | voucher gate | existing main user/workspace queries unchanged |
| Analyze | `POST /api/reconstructions/:id/operations/analyze`; multipart `file`, `context_token`, `mode`, `target_template_id`; returns the existing reconstruction report keys | voucher gate plus both converter gateway readiness flags | run/user/scope token match; unexpired run query; workspace context derived from the persisted run |
| Draft edit | `PATCH /api/reconstructions/:id/operations/drafts/:draftId`; `expected_revision`, `operations` | same | reconstruction `review` scope |
| Split/merge | `POST .../split` with `draft_id`, `expected_revision`, `source_rows`; `POST .../merge` with `draft_ids`, `expected_revisions` | same | reconstruction `review` scope |
| Validate/approve | `POST .../validate` with no request keys; `POST .../approve` with `acknowledge_warnings` | same | `review` and `approve` scopes respectively |
| Export | `POST .../export`; `acknowledge_warnings`; `Idempotency-Key`; binary XLS/ZIP response and existing download headers | same | reconstruction `export` scope |

The router uses seven explicit operation routes. Unknown operation paths are not
forwarded. Browser traffic remains on the authenticated Node gateway. The
converter receives a short-lived main conversion context, service token, request
ID, and the verified reconstruction context. Caller-supplied ownership fields and
`context_token` are not forwarded in JSON operation bodies.

## Source-Tested Fixes

- Restored client-side AI payload redaction even when a caller supplies raw rows.
- Restored HTTPS enforcement for public AI endpoints plus explicit local/private
  host allowlisting.
- Removed implicit AI reconstruction from analysis. Accounting reconstruction is
  deterministic; the existing `ai` response object remains present with
  `used=false`.
- Restored `document_totals` aggregation: repeated invoice totals count once,
  line totals count each detail row, missing document keys require review, and
  conflicting repeated totals block.
- Restored `group_output_rows`, required by the canonical export manifest path.
- Adapted source gateway ownership behavior to the current GridFS/service-token
  gateway rather than copying the retired source gateway controller.

Of 35 reviewed reconstruction paths, 27 match the exact source blob. Eight are
intentional compositions: protected Node routes/tests, the main workflow
signature, Task 4 internal service authentication in API tests, formatting-only
AI/totals differences, and the buildable main voucher hook.

The source hook's shared `converterOperations.js` import was not ported because
that utility is absent on current main and the local normalizer is behaviorally
equivalent. A production build reproduced the missing-module failure; retaining
the main hook restored the build.

No tax, VAT, legal, or MISA product-version rule was added. The totals behavior is
deterministic repository logic backed by the exact source tests.

## Canonical Invariants

- One Express mount: `/api/reconstructions`.
- One reconstruction route module: `backend/routes/reconstructions.js`.
- One registration each for `VoucherReconstructionRun`,
  `ReconstructionProfile`, and `ReconstructionDecision`.
- The transplant verifier now scans reconstruction route mounts/modules and all
  Mongoose model names before ownership evaluation.
- `scripts/tests/verify-transplant-manifest.test.ps1` proves duplicate route mounts
  and duplicate model registrations fail.

## TDD Evidence

Observed RED before production changes:

- Backend route tests failed because all seven operation routes were absent; the
  ownership-forwarding test could not resolve the approve route.
- AI tests reached a plaintext remote endpoint and forwarded raw invoice/tax/total
  values.
- Document totals tests failed because `app.document_totals` did not exist.
- After Task 4 service authentication was represented in the test client, the
  uncertain-workbook regression returned `ai.used=true` without opt-in.
- The verifier fixture failed because canonical-only checking and duplicate
  detection did not exist.

## Verification

```text
backend reconstruction suites: 14 passed, 0 failed
converter requested reconstruction suites plus document totals: 43 passed, 0 failed
frontend reconstruction utility suite: 4 passed, 0 failed
backend converter gateway startup: 4 passed, 0 failed
converter document structure plus totals: 8 passed, 0 failed
frontend production build: passed
canonical verifier regression: passed
git diff --check: passed
```

Pytest reports one existing FastAPI `on_event` deprecation warning.

The full ownership verifier reports canonical invariants as passing
(`1` reconstruction mount, `1` route module, no duplicate among `19` Mongoose
registrations). It still exits nonzero for the same 48 pre-existing Task 3/4
unowned paths documented by Task 5. Every Task 6 touched/new path has exactly one
ownership rule.

## Preservation

- Payment, coupon, settlement, and replica-set files were not changed.
- GridFS artifact storage and converter service-auth contracts were retained.
- Existing Student Assistant/privacy working-tree changes were not staged or
  modified by Task 6.
- No duplicate reconstruction route/model file was added.

## Concerns

- Full manifest ownership remains blocked by 48 pre-existing Task 3/4 paths;
  Task 6 did not guess unrelated ownership decisions.
- Focused tests use mocked Mongo models; no live MongoDB/GridFS environment was
  required for this reconstruction slice.
