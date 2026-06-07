# EzFormat Converter (Python)

FastAPI service for Excel → MISA import conversion.

## Setup

```powershell
python -m pip install -r requirements.txt
```

Templates live in `fixtures/templates/`. Test samples in `fixtures/samples/`.

Optional production/local template override:

```powershell
$env:MISA_TEMPLATE_DIR='E:\0. EXE2\Misa File'
$env:MAPPING_DB_PATH='converter\data\mapping_profiles.sqlite'
```

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
- `POST /api/v1/conversions/export` → `.xls` download (legacy rows or confirmed profile)
- `POST /api/v1/conversions` → direct `.xls` (no preview)

## Tests

```powershell
python -m pytest -q
```
