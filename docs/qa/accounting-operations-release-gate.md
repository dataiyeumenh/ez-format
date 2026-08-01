# Accounting Operations Release Gate

## Status

`HOLD` until every mandatory check below passes three consecutive runs and the
independent accounting reviewer reports zero P0/P1 findings.

Feature flags remain disabled by default:

```text
FEATURE_MAPPING_PROFILE_V2=false
FEATURE_ANOMALY_DETECTION=false
FEATURE_BULK_CORRECTION=false
FEATURE_RECONCILIATION=false
FEATURE_ACCOUNTING_ASSISTANT=false
FEATURE_AI_EXPLANATION=false
```

## Mandatory Evidence

- Backend full suite.
- Converter full suite.
- Frontend unit tests, lint and production build.
- `npm run qa:fast`.
- 10k/50k performance benchmark.
- Desktop and mobile browser journeys with all operation flags enabled.
- Local AI online, offline, timeout, invalid JSON and privacy-canary checks.
- Real MISA template fidelity checks.
- Independent `ke-toan` review with no implementation involvement.
- Three consecutive clean accounting-operation gate runs.
- Four explicit repository-contained synthetic fixtures whose hashes and privacy
  approval are bound by one repository-contained schema-v2 fixture manifest.

## Independent Report Contract

The report must contain these exact attestations before the automated gate will
accept it:

```text
verdict: PASS
p0: 0
p1: 0
implementation_involvement: none
accounting_domain: ke-toan
```

The remainder records reviewed files, scenarios, source basis, test evidence,
residual P2 risks and reviewer identity. Any missing attestation fails closed.

## Gate Command

```powershell
npm run qa:accounting-operations -- -AccountingQaReport <absolute-report-path>
```

Run with a unique release ID when preserving multiple evidence bundles:

```powershell
pwsh -File scripts/qa-accounting-operations.ps1 `
  -ReleaseId <release-id> `
  -SyntheticFixtureManifest converter/config/<approved-manifest>.json `
  -SalesRawFixture converter/fixtures/<approved-sales-raw> `
  -SalesMisaFixture converter/fixtures/<approved-sales-misa> `
  -PurchaseRawFixture converter/fixtures/<approved-purchase-raw> `
  -PurchaseMisaFixture converter/fixtures/<approved-purchase-misa> `
  -AccountingQaReport <absolute-report-path>
```

No Downloads, external-drive, or customer-workbook fallback exists. Missing
local fixtures are reported as skipped only with `-AllowIncompleteDiagnostics`;
release eligibility remains false. Otherwise missing or invalid approval fails
closed. Evidence under `.artifacts/qa/<release-id>/` contains hashes, statuses,
sanitized command logs, a redacted independent-review receipt, and `summary.json`.
It excludes fixture paths, customer identifiers, accounting totals, and raw
review files.

## Rollout

1. Enable one server-side feature flag for internal users.
2. Monitor 409/410 rates, operation latency, failed exports and support reports.
3. Keep AI explanation disabled until deterministic features remain stable.
4. Expand gradually; disable the affected flag immediately on integrity drift.
5. Never bypass backend revision, owner, readiness or export gates from the UI.
