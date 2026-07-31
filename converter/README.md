# EzFormat Converter (Python)

FastAPI service for Excel → MISA import conversion.

## Setup

```powershell
python -m pip install -r requirements.txt
```

Templates live in `fixtures/templates/`. Their reviewed SHA-256 and exact workbook
schema live in the tracked, versioned `config/misa-template-manifest.json`.
Test samples live in `fixtures/samples/`.

Production/local template configuration:

```powershell
$env:MISA_TEMPLATE_DIR='fixtures/templates'
$env:MISA_TEMPLATE_MANIFEST_PATH='config/misa-template-manifest.json'
$env:MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS='partner_sample_derived'
$env:MAPPING_DB_PATH='converter\data\mapping_profiles.sqlite'
```

Relative template and manifest paths resolve from this `converter` directory.
An external `MISA_TEMPLATE_DIR` must contain exact reviewed bytes under each
canonical filename recorded as `canonical_filename`; a same-header replacement
is rejected. Production imports verify every supported template and fail before
the API starts when the manifest, filename, SHA-256, sheet, header row, or ordered
header schema differs. Production also requires an explicitly configured accepted
trust level. The committed templates are scrubbed structural derivatives of
partner-provided samples. Post-header values and residual unreferenced BIFF shared
strings are removed from the current bundled files. Acquisition date, MISA product,
and MISA release remain unknown. No official MISA source is claimed. Historical
commits may contain predecessor bytes; history rewriting is a separate destructive
operation and is not performed by this template release.

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
one such BIFF feature. Therefore release preflight and production startup fail
closed until a writer that passes the committed byte-level record probes is
deployed. There is no Excel COM dependency or bypass setting.

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
