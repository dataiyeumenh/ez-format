# Independent Security Review — Experimental branch

Scope: current source only. No live production proof. No source edits.

## Verdict

Pass. No open P0/P1/P2 issues found in current source for the reviewed claims.

## Counts

- P0: 0
- P1: 0
- P2: 0

## Re-verified findings

### 1) No legacy `/api/convert` mount

Evidence:
- `E:\0. EXE2\ez-format\backend\server.js:107-163` mounts `/api/converter` only when usage-ready, then public routes follow; no `/api/convert` mount exists there.
- `E:\0. EXE2\ez-format\backend\tests\runtimeCapabilities.test.js:74-100` asserts the server does not mount legacy `/api/convert` and does mount `/api/converter`.

### 2) Usage-ready production startup fails closed before DB/listen

Evidence:
- `E:\0. EXE2\ez-format\backend\server.js:181-225` calls `assertConversionContextConfig()`, `assertConverterGatewayStartupConfig()`, then `assertArtifactStorageConfigured()`, then `connectDB()`, then `app.listen()`.
- `E:\0. EXE2\ez-format\backend\services\converterGatewayService.js:116-144` rejects missing `CONVERTER_INTERNAL_URL`, invalid URL, insecure non-loopback HTTP, missing `CONVERTER_SERVICE_TOKEN`, short production token, and the documented placeholder.
- `E:\0. EXE2\ez-format\backend\tests\converterGatewayStartup.test.js:18-105` covers missing URL, missing token, insecure URL, short token, placeholder token, and dev/test allowance.
- `E:\0. EXE2\ez-format\backend\tests\converterGatewayStartup.test.js:107-181` asserts `startServer()` rejects before `connectDB()` and before `listen()`.

### 3) FastAPI production startup rejects missing/short/placeholder service token

Evidence:
- `E:\0. EXE2\ez-format\converter\app\internal_auth.py:52-81` enforces production config: requires `CONVERTER_SERVICE_TOKEN`, minimum 32 chars, and rejects the documented placeholder.
- `E:\0. EXE2\ez-format\converter\app\main.py:194-200` wires `_assert_secure_production_config()` into startup.
- `E:\0. EXE2\ez-format\converter\tests\test_internal_auth.py:756-783` verifies production rejection for short/placeholder token.

### 4) Dev/test local behavior preserved

Evidence:
- `E:\0. EXE2\ez-format\backend\services\converterGatewayService.js:82-98` allows loopback HTTP only in development/test with explicit opt-in.
- `E:\0. EXE2\ez-format\backend\tests\converterGatewayStartup.test.js:93-105` accepts short local service token outside production.
- `E:\0. EXE2\ez-format\converter\app\context_secrets.py:9-25` still allows dev/test JWT fallback only with explicit flag.
- `E:\0. EXE2\ez-format\converter\tests\test_internal_auth.py:748-753` blocks unauthenticated local mode in production.

### 5) `VITE_NODE_API_URL` is Node fallback, not FastAPI escape

Evidence:
- `E:\0. EXE2\ez-format\frontend\src\services\api.js:3-15` uses `VITE_API_URL || VITE_NODE_API_URL`, then normalizes to `/api`.
- `E:\0. EXE2\ez-format\frontend\scripts\check-production-env.mjs:3-15` blocks `VITE_PYTHON_API_URL` in production builds; it does not treat `VITE_NODE_API_URL` as a FastAPI path.
- `E:\0. EXE2\ez-format\frontend\src\utils\converterGatewayContract.test.mjs:68-75` rejects direct FastAPI escape hatches (`VITE_PYTHON_API_URL`, `/python-api`) in browser source and Vite config.

### 6) No token/context leakage seen in current source

Evidence:
- `E:\0. EXE2\ez-format\backend\services\converterGatewayService.js:1-30, 226-299` redacts sensitive upstream keys/values and protects internal headers.
- `E:\0. EXE2\ez-format\backend\controllers\converterGatewayController.js:69-75, 455-468, 997-1081, 1207-1217, 1254-1262, 1336-1347` strips client-supplied unsafe keys, forwards only trusted context tokens, and re-signs internal context.
- `E:\0. EXE2\ez-format\backend\tests\converterGateway.test.js:360-419, 429-470, 486-504, 549-565, 1139-1172, 1328-1445` verifies JSON/body/header redaction, safe error propagation, non-JSON body handling, and no forwarding of raw client context fields.

## Focused test evidence

Passed:
- `backend`: `node --test tests/converterGatewayStartup.test.js tests/runtimeCapabilities.test.js tests/converterGatewayContract.test.js`
  - 9 tests passed, 0 failed
- `frontend`: `node --test src/utils/converterGatewayContract.test.mjs src/services/api.test.mjs`
  - 6 tests passed, 0 failed
- `frontend`: `node scripts/check-production-env.mjs`
  - exit 0

## Residual deployment-only gaps

- No live production deployment verification was run here.
- Final safety still depends on live env wiring:
  - `CONVERTER_INTERNAL_URL`
  - `CONVERTER_SERVICE_TOKEN`
  - `CONVERSION_CONTEXT_SECRET`
  - frontend `VITE_API_URL` / `VITE_NODE_API_URL`

No source-level blocker remains from this review.
