# EzFormat Converter (Python)

FastAPI service for Excel → MISA import conversion.

## Setup

```powershell
python -m pip install -r requirements.txt
```

## Distributed operation state

Production uses `OPERATION_STORE_PROVIDER=node`; MongoDB/GridFS is the only
durable source of operation state and workbook artifacts. Keep
`OPERATION_STORE_PROTOCOL=auto` during mixed-version rolling deploys: the
converter probes `raw-v2`, then falls back to `legacy-json-v1` only when the old
Node route returns `404` or `405`. Pin `raw-v2` only after every Node replica
supports it.

Legacy JSON carries one state representation per request. New Node advertises
canonical base64 and verifies its exact SHA-256; old Node fallback carries only
the canonical state object. The converter serializes the complete JSON body
before sending and rejects bodies above the old Node 50 MiB parser limit with
`OPERATION_PROTOCOL_SIZE_MISMATCH`. Deploy raw-v2 before retrying oversized
legacy operations. New Node bounds its authenticated JSON parser to one base64
payload plus fixed metadata allowance.

Set `CONVERTER_ARTIFACT_MAX_BYTES=67108864` identically on Node and the
converter. Only unsigned safe decimal integers are accepted; scientific notation,
hexadecimal, signs, whitespace, separators, zero, and invalid values use the
64 MiB default. Valid safe integers above 512 MiB are capped. Artifacts above the effective
bound are rejected before publication. Raw files materialized by FastAPI are
request-scoped and purged when the operation returns; do not configure local or
S3 production fallback.

Production Student deployments also require an explicit legacy-state gate.
Use `STUDENT_METADATA_V1_ROLLOUT_MODE=drain` with
`STUDENT_METADATA_V1_QUIESCE_ACKNOWLEDGED=true` while new analyses are blocked
and recoverable metadata-only sessions are CAS-migrated into Node. Set the mode
to `complete` only after the release drain inventory proves no metadata-only
`student_metadata_v1` session remains. Startup fails closed when this gate is
missing or unacknowledged.

Templates live in `fixtures/templates/`. Their reviewed SHA-256 and exact workbook
schema live in the tracked, versioned `config/misa-template-manifest.json`.
Test samples live in `fixtures/samples/`. They are deterministic synthetic files
with pinned hashes in `config/converter-fixture-manifest.json`; regenerate both
files together with:

```powershell
python scripts/generate_synthetic_sales_fixtures.py `
  --output-dir fixtures/samples `
  --manifest config/converter-fixture-manifest.json
```

Production/local template configuration:

```powershell
$env:MISA_TEMPLATE_DIR='fixtures/templates'
$env:MISA_TEMPLATE_MANIFEST_PATH='config/misa-template-manifest.json'
$env:MISA_TEMPLATE_CERTIFICATION_DIR='config/misa-template-certifications'
$env:MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS='partner_sample_derived'
$env:MAPPING_DB_PATH='converter\data\mapping_profiles.sqlite'
```

Relative template and manifest paths resolve from this `converter` directory.
An external `MISA_TEMPLATE_DIR` must contain exact reviewed bytes under each
canonical filename recorded as `canonical_filename`; a same-header replacement
is rejected. Production requires an explicitly configured accepted trust level.
The committed templates are scrubbed structural derivatives of
partner-provided samples. Post-header values, residual unreferenced BIFF shared
strings, OLE author properties, and BIFF write-access/file-sharing usernames are
removed from the current bundled files. Property streams must exactly equal their
canonical bytes, including padding. Every OLE stream is inventoried: unknown streams
fail closed, custom properties are scanned, and reviewed `CompObj`/`Ole` binary
stream hashes are allowlisted. BIFF scanning rejects pre/header formulas, unsafe
formula functions, external/DDE links, macro sheets, and active-content records.
Acquisition date, MISA product, and MISA release remain unknown. No official MISA
source is claimed.

Verify the active deployment assets:

```powershell
python -m app.misa_templates verify
```

The normal verifier checks hashes, schema, scrubbed content, and protected BIFF
record fingerprints. Release preflight is stricter:

```powershell
python -m app.misa_templates verify --require-export-safe
```

The current `xlutils.copy` writer preserves the tested cell styles, merges,
column widths, and row heights, but drops formulas, defined names,
drawings/objects, and data validations. Six committed templates contain at least
one such BIFF feature. The service remains healthy with `status=degraded` while
one or more templates are unavailable; `/healthz` and `/api/v1/templates` report
the same per-template capability used by export. Every user-facing MISA export,
in every environment, checks the selected template certification. No application
environment bypass exists; tests isolate writer behavior by monkeypatching the
private capability boundary inside pytest fixtures only. Release preflight remains
blocked until every required template is certified. There is no Excel COM dependency.

Certification is evidence-bound, portable, immutable, and synthetic-only. Before
issuance, the converter scans workbook metadata/cells and the result receipt for
obvious customer/PII markers. A fixture attestation must bind the exact input/output
hashes, identify the deterministic synthetic fixture, classify it as
`synthetic_no_customer_data`, and record an independent reviewer plus `approved`
status. A schema-v2 fixture manifest must independently approve both exact hashes;
every manifest entry must be deterministic synthetic, customer-free, independently
reviewed, and approved. Missing, mismatched, placeholder, unapproved, or customer
fixtures fail closed. Print the current writer build hash with the exact candidate environment.
The hash binds writer source,
`requirements.txt` bytes, resolved `xlrd`/`xlwt`/`xlutils`/`olefile` versions, and
the Python major/minor version:

```powershell
python -c "from app.misa_certification import current_writer_build_sha256; print(current_writer_build_sha256())"
```

The fixture attestation must contain exactly:

```json
{
  "schema_version": 1,
  "synthetic_fixture_id": "synthetic-<stable-id>",
  "fixture_kind": "synthetic",
  "privacy_classification": "synthetic_no_customer_data",
  "contains_customer_data": false,
  "generator": "<deterministic generator>",
  "reviewer": "<independent reviewer>",
  "approval_status": "approved",
  "approved_at_utc": "<timezone-aware ISO-8601>",
  "input_sha256": "<64 lowercase hex>",
  "output_sha256": "<64 lowercase hex>"
}
```

The bounded result artifact must be a redacted JSON receipt, never a screenshot
or raw log. It contains exactly schema/version, receipt type, success status,
`redacted=true`, synthetic fixture ID, imported-row count, and warning count.
The import-result JSON schema is version `3` and must contain exactly:

```json
{
  "schema_version": 3,
  "evidence_origin": "misa_sandbox_import",
  "result_artifact_kind": "redacted_json_receipt",
  "status": "misa_import_passed",
  "template_sha256": "<64 lowercase hex>",
  "input_sha256": "<64 lowercase hex>",
  "output_sha256": "<64 lowercase hex>",
  "result_artifact_sha256": "<64 lowercase hex>",
  "fixture_attestation_sha256": "<64 lowercase hex>",
  "synthetic_fixture_id": "synthetic-<stable-id>",
  "privacy_classification": "synthetic_no_customer_data",
  "misa_product": "<explicit product>",
  "misa_release": "<explicit release>",
  "completed_at_utc": "<timezone-aware ISO-8601>",
  "reviewer": "<reviewer identity>",
  "approver": "<different approver identity>",
  "writer_build_sha256": "<current writer hash>",
  "template_provenance": {
    "source_kind": "partner_sample_derived",
    "trust_level": "partner_sample_derived",
    "official_status": "not_claimed_official"
  }
}
```

Provision each template with the exact command path:

```powershell
python -m app.misa_certification create `
  --conversion-type sales_goods `
  --template fixtures/templates/sales_goods.xls `
  --input ../.artifacts/certification/sales_goods-input.csv `
  --output ../.artifacts/certification/sales_goods-output.xls `
  --import-result ../.artifacts/certification/sales_goods-import-result.json `
  --result-artifact ../.artifacts/certification/sales_goods-misa-receipt.json `
  --fixture-attestation ../.artifacts/certification/sales_goods-fixture-attestation.json `
  --fixture-manifest ../.artifacts/certification/approved-synthetic-fixtures.json `
  --artifact-dir config/misa-template-certifications `
  --expires-at 2027-01-31T00:00:00+00:00
```

The command copies only the manifest-approved synthetic output, fixture manifest,
fixture attestation, import-result JSON, and redacted receipt under
`config/misa-template-certifications/evidence/sha256/` and writes only relative
paths. Template and input workbooks are hash-bound but are not copied into the
bundle; customer workbooks must never be supplied or bundled. It rejects
absolute/escaping paths, future/expired/revoked records,
template-equals-output, placeholders, same-person approval, unbound hashes, stale
writer bytes, and later bundle tampering. Package this directory read-only with the
converter; do not put certification evidence or customer files in S3. Do not set
`production_ready` manually. Current repository state has no complete certification
set and is not production-ready.

Template rotation is never learned automatically. Replace reviewed template
files intentionally, generate a candidate without overwriting the active
manifest, review it, then commit the template and manifest together:

```powershell
python -m app.misa_templates regenerate-manifest `
  --template-dir fixtures/templates `
  --output ../.artifacts/misa-template-manifest.candidate.json `
  --manifest-version 2026-08-01.1 `
  --source-kind partner_sample_derived `
  --source-reference "Sanitized derivative of reviewed partner sample; no customer values in derivative" `
  --acquisition-date 2026-08-01 `
  --misa-product unknown `
  --misa-release unknown `
  --reviewer reviewer-name `
  --review-status accepted_for_project_use `
  --trust-level partner_sample_derived `
  --official-status not_claimed_official
python -m app.misa_templates review-manifest `
  --template-dir fixtures/templates `
  --candidate ../.artifacts/misa-template-manifest.candidate.json
git diff --no-index config/misa-template-manifest.json `
  ../.artifacts/misa-template-manifest.candidate.json
```

The regenerate command requires explicit provenance and review metadata. The
commands preserve filename, sheet, header-row, column-count, and ordered header
invariants. Schema changes require separate manual manifest review. The
manifest covers all export targets, including the six canonical purchase/sales
forms and the supported `misa_purchase_domestic` compatibility target. Keep the
BSN sales template at its reviewed 59-column schema.

## Run

```powershell
npm run dev
# or: python -m uvicorn app.main:app --reload --port 8000
```

Optional AI Gateway on the machine that runs Ollama:

```powershell
$env:AI_GATEWAY_TOKEN='<secret>'
$env:OLLAMA_BASE_URL='http://127.0.0.1:11434'
$env:OLLAMA_MODEL='qwen2.5:7b'
python -m uvicorn app.ai_gateway:app --host 0.0.0.0 --port 8010
```

VPS/remote converter can call that gateway through ZeroTier:

```powershell
$env:AI_PROVIDER='remote_http'
$env:AI_BASE_URL='http://<ZEROTIER_IP>:8010/v1/misa/suggest-mapping'
$env:AI_TOKEN='<secret>'
$env:AI_REQUIRED='false'
```

## API

- `GET /healthz`
- `GET /api/v1/templates`
- `POST /api/v1/uploads/analyze` → upload raw Excel, returns mapping suggestion
- `POST /api/v1/mappings/preview` → preview mapped MISA rows
- `POST /api/v1/mappings/confirm` → save mapping profile/correction
- `GET /api/v1/conversion-types`
- `POST /api/v1/conversions/validate`
- `POST /api/v1/conversions/preview` → JSON `{ headers, rows, report }`
- `POST /api/v1/conversions/export` → bound confirmed-profile/template `.xls`;
  client rows are rejected
- `POST /api/v1/conversions` → direct `.xls` (no preview)

## Tests

```powershell
python -m pytest -q
```
