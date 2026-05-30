# EzFormat Converter (Python)

FastAPI service for Excel → MISA import conversion.

## Setup

```powershell
python -m pip install -r requirements.txt
```

Templates live in `fixtures/templates/`. Test samples in `fixtures/samples/`.

## Run

```powershell
npm run dev
# or: python -m uvicorn app.main:app --reload --port 8000
```

## API

- `GET /healthz`
- `GET /api/v1/conversion-types`
- `POST /api/v1/conversions/validate`
- `POST /api/v1/conversions/preview` → JSON `{ headers, rows, report }`
- `POST /api/v1/conversions/export` → `.xls` download
- `POST /api/v1/conversions` → direct `.xls` (no preview)

## Tests

```powershell
python -m pytest -q
```
