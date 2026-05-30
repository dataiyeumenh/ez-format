# Python + Node Backend Integration (Hybrid B)

## Architecture

- **Node** (`backend/`): JWT auth, admin, MongoDB — port 5000
- **Converter** (`converter/`): FastAPI Excel → MISA — port 8000
- **Frontend**: Vite proxies `/api` → Node, `/python-api` → Converter

## User flow

1. Select `conversion_type` (6 MISA forms)
2. Upload Excel → `POST /api/v1/conversions/validate`
3. Preview → `POST /api/v1/conversions/preview` → `{ headers, rows, report }`
4. Edit table in UI
5. Export → `POST /api/v1/conversions/export` with `{ conversion_type, rows }`

## Phase 2 (not implemented)

- Node BFF proxy for `/api/v1/*`
- Persist conversion history in MongoDB
