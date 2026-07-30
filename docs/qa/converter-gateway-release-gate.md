# Converter Gateway Release Gate

## Purpose

This gate proves the converter boundary, ownership checks, idempotent export, accounting fixture integrity, and the real production-like journey. Mock journeys are supplemental only. A local run without live evidence is `incomplete`, never a release pass.

## Local diagnostic

```powershell
npm run qa:converter-gateway -- -AllowLocalHttp -AllowIncompleteDiagnostics
npm run qa:accounting-operations -- -Runs 1 -SkipBroadTests -SkipPerformance -AllowIncompleteDiagnostics
```

Diagnostic mode may exit `0` only to help local development. It must still write `summary.json` with `status=incomplete`. It cannot produce `release_eligible=true`.

## Release commands

Run the accounting gate first. It creates a release manifest that an independent reviewer uses to prepare the report.

```powershell
npm run qa:accounting-operations -- `
  -ReleaseId "20260728-qa01" `
  -SalesRawFixture "E:/0. EXE2/Chi tiet ban hang.xlsx" `
  -PurchaseRawFixture "C:/qa/MUA_VAO.xlsx" `
  -SalesMisaFixture "E:/0. EXE2/Import misa.xls" `
  -PurchaseMisaFixture "C:/qa/mua_hang_trong_nuoc_full.xls" `
  -ManifestOnly -AllowIncompleteDiagnostics
```

The reviewer returns a JSON report bound to `.artifacts/qa/20260728-qa01/release-manifest.json`, plus a separate JSON QA artifact. Then run all release checks:

```powershell
npm run qa:converter-gateway -- `
  -ReleaseId "20260728-qa01" `
  -RequireLive `
  -FrontendUrl "https://app.example.test" `
  -ConverterUrl "https://converter.example.test" `
  -GatewayUrl "https://api.example.test" `
  -LiveContractFile "C:/secure/converter-gateway-live-contract.json" `
  -ChargeAuditBeforeFile "C:/secure/charge-before.json" `
  -ChargeAuditAfterFile "C:/secure/charge-after.json" `
  -IntegrationFixture "C:/qa/raw_sales_sample.xlsx"

npm run qa:accounting-operations -- `
  -ReleaseId "20260728-qa01" `
  -AccountingQaReport "C:/secure/accounting-qa-20260728-qa01.json"
```

Release mode requires `-RequireLive`, three HTTPS origins, all live inputs, at least 3 focused runs, broad tests, performance tests, separate live API-security checks, a real browser/UI Playwright journey, and a fresh independent accounting report. Missing prerequisites in diagnostic mode remain `incomplete`; missing release prerequisites or failed checks exit `1`.

## Live contract

The contract contains credentials and pre-created resource IDs only. It cannot choose a URL, HTTP method, route, expected status, request headers, or request body. Those security checks are hardcoded in `scripts/qa-converter-gateway.ps1`, preventing a contract from testing an arbitrary harmless endpoint and reporting a false pass.

Example shape; use short-lived values outside the repository:

```json
{
  "schema_version": 2,
  "release_id": "20260728-qa01",
  "credentials": {
    "owner_jwt": "REDACTED",
    "foreign_jwt": "REDACTED",
    "owner_email": "qa-owner@example.test",
    "owner_password": "REDACTED"
  },
  "resources": {
    "owner": {
      "run_id": "RUN_OWNER",
      "upload_id": "UPLOAD_OWNER",
      "target_template_id": "bsn_sales",
      "operation_session_id": "SESSION_OWNER",
      "profile_id": "PROFILE_OWNER",
      "session_revision": 2,
      "state_hash": "STATE_HASH_OWNER"
    },
    "foreign": {
      "run_id": "RUN_FOREIGN",
      "upload_id": "UPLOAD_FOREIGN",
      "target_template_id": "bsn_sales",
      "operation_session_id": "SESSION_FOREIGN"
    },
    "wrong_workspace": {
      "run_id": "RUN_OTHER_WORKSPACE",
      "upload_id": "UPLOAD_OTHER_WORKSPACE",
      "target_template_id": "bsn_sales",
      "operation_session_id": "SESSION_OTHER_WORKSPACE"
    },
    "duplicate_export": {
      "idempotency_key": "qa-20260728-qa01-duplicate"
    }
  }
}
```

The gate hardcodes these destinations and expected results:

- Direct FastAPI analyze/export without the internal service token: `401`.
- Direct FastAPI untrusted CORS preflight: denied, with no permissive CORS header.
- Node gateway analyze without JWT: `401`.
- Wrong workspace context: `409`.
- Foreign upload binding: `409`.
- Foreign profile: `400` (the current API's safe profile-resolution error).
- Foreign run context: `403`.
- Oversized multipart upload: exactly `413`.
- Duplicate export: both responses `200`, identical bytes and artifact ID, one charge and one artifact.

JWTs are sent only to the gateway origin. The direct converter checks intentionally send no user JWT.
The UI credentials are short-lived release-fixture credentials stored only in the external contract. Playwright enters them on `FrontendUrl/login`; the gate never writes them to QA artifacts or passes them to the direct converter checks.

## Duplicate-export evidence

The release operator supplies a read-only audit snapshot before the gate and a watcher-updated snapshot after the two export requests. Both files must bind:

```json
{
  "release_id": "20260728-qa01",
  "run_id": "RUN_OWNER",
  "idempotency_key": "qa-20260728-qa01-duplicate",
  "measured_at": "2026-07-28T05:00:00Z",
  "charge_count": 0,
  "artifact_count": 0,
  "artifact_ids": []
}
```

The after snapshot must be fresh after the second response, show `charge_count=1`, `artifact_count=1`, and contain the response `artifact_id`. Stale, unrelated, or count-only evidence fails. Response bytes alone never prove billing idempotency.

## Accounting fixture gate

`qa-accounting-operations.ps1` accepts fixture paths through parameters or these environment variables:

- `QA_SALES_RAW_FIXTURE`
- `QA_PURCHASE_RAW_FIXTURE`
- `QA_SALES_MISA_FIXTURE`
- `QA_PURCHASE_MISA_FIXTURE`

The deterministic project validators verify, not merely parse:

- Raw-domain detection and required MISA fields.
- Sales and purchase document counts, line counts, amount formulas, VAT rates/amounts, and payable totals.
- Repeated document totals are deduplicated; line-level purchase totals are not mistaken for invoice totals.
- Real template headers, merged cells, widths, row heights, and header styles.
- A deliberately wrong-domain profile is rejected as a deterministic blocker.
- Fixture SHA-256 values are recorded in the release manifest.

Missing required account mappings in the supplied raw samples are expected review findings; the gate confirms they are detected and never silently treated as ready.

## Independent accounting report

The report must be JSON, schema version `1`, and include the exact `release_id`, `commit_hash`, committed `tree_hash`, dirty `working_tree_hash`, `qa_input_hash`, all fixture hashes, reviewer identity, `reviewed_at`, `verdict=PASS`, `p0=0`, `p1=0`, three PASS attestations (`fixture_validation`, `accounting_logic`, `production_readiness`), and a separate `qa_artifact` path/hash. The reviewer must declare `independent=true`, `implementation_involvement=none`, and `accounting_domain=ke-toan`.

The gate rejects stale/future reports, hash mismatches, unresolved findings, open P0/P1 findings, a report used as its own artifact, and an artifact whose release/status does not match.

## Live API security checks

`frontend/tests/converter-gateway.api.integration.spec.mjs` uses Playwright's API request context only. It stays separate from UI evidence and asserts direct FastAPI denial, missing gateway JWT denial, the real analyze/preview/readiness/confirm contract, and backend export blocking. It can never satisfy the browser/UI gate.

Before live requests, Node and FastAPI startup checks must require high-entropy
values and reject every documented example, placeholder, default, or
low-entropy value. `JWT_SECRET`,
`CONVERSION_CONTEXT_SECRET`, and `CONVERTER_SERVICE_TOKEN` must each contain at
least 32 characters, have meaningful character diversity, and remain distinct.
The Node/FastAPI shared values must match only by variable role; never log them.

The live security contract must replay an owner's signed
`x-conversion-context` under the foreign JWT and prove cross-user replay is
denied by Node before any FastAPI request, mutation, charge, or artifact write.
Separate malformed and expired context cases must receive denial while the same
owner request and `Idempotency-Key` retain the existing idempotent result.

## Real browser journey

Release mode runs `frontend/tests/converter-gateway.integration.spec.mjs` in Chromium against `FrontendUrl`. It:

1. Logs in through the rendered login form using the short-lived QA account.
2. Verifies the browser's auth/analyze requests reach the configured Node `GatewayUrl`.
3. Uploads the real workbook with the file input and sees the mapping table.
4. Clears a required mapping, sees the blocker card, and proves the rendered download button is disabled.
5. Restores the mapping, sees preview plus warning state, and proves download remains disabled until warning acknowledgement.
6. Acknowledges warnings, observes a real browser `download` event, and verifies a non-empty `.xls` result.
7. Renders deterministic AI-online and fault-injected AI-offline copy, then checks the Convert page at a 390px viewport without page-level horizontal overflow.

The integration fixture must auto-map `Số chứng từ (*)` and produce warning-only readiness after that mapping is restored. A fixture with residual blockers or no warning coverage fails the release journey instead of silently weakening assertions.

`frontend/tests/converter-gateway.journey.spec.mjs` remains a fast supplemental ownership/UI-state model. `npm test` runs it, but neither it nor the API-only integration test counts as browser/UI release proof. Missing `FrontendUrl`, browser binaries, fixture, or UI credentials cannot produce `release_eligible=true`.

## Numeric SLOs

The accounting performance test must meet all of these limits in every release run:

- 10,000 rows: `<= 20 seconds`.
- 50,000 rows: `<= 75 seconds`.
- No row-count growth, duplicate billing, or artifact corruption while meeting the latency limits.

## Decision

Only `.artifacts/qa/<release-id>/summary.json` with `status=pass`, `release_eligible=true`, zero failed checks, and zero skipped checks qualifies for deployment. Any `incomplete`, `fail`, absent live stack, absent audit watcher, or absent independent report blocks release.
