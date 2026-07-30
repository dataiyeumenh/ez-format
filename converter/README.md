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
$env:MAPPING_DB_PATH='converter\data\mapping_profiles.sqlite'
```

Relative template and manifest paths resolve from this `converter` directory.
An external `MISA_TEMPLATE_DIR` must contain exact reviewed bytes under each
official filename recorded as `canonical_filename`; a same-header replacement
is rejected. Production imports verify every supported template and fail before
the API starts when the manifest, filename, SHA-256, sheet, header row, or ordered
header schema differs.

Verify the active deployment assets:

```powershell
python -m app.misa_templates verify
```

Template rotation is never learned automatically. Replace reviewed template
files intentionally, generate a candidate without overwriting the active
manifest, review it, then commit the template and manifest together:

```powershell
python -m app.misa_templates regenerate-manifest `
  --template-dir fixtures/templates `
  --output ../.artifacts/misa-template-manifest.candidate.json `
  --manifest-version 2026-08-01.1
python -m app.misa_templates review-manifest `
  --template-dir fixtures/templates `
  --candidate ../.artifacts/misa-template-manifest.candidate.json
git diff --no-index config/misa-template-manifest.json `
  ../.artifacts/misa-template-manifest.candidate.json
```

The commands preserve filename, sheet, header-row, column-count, and ordered
header invariants. Schema changes require separate manual manifest review. The
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
