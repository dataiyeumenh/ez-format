# Converter Internal Gateway Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` hoặc `superpowers:executing-plans` để implement task-by-task. Steps dùng checkbox (`- [ ]`) để tracking.

**Goal:** Chuyển toàn bộ luồng convert công khai sang Node backend làm gateway; khóa Converter FastAPI thành internal service; sửa các lỗi integrity/security P0/P1 đã phát hiện trong extreme user-journey QA.

**Architecture:** Frontend chỉ gọi Node API với JWT. Node kiểm tra user, account status, plan, credit, workspace, conversion run và proxy request tới Converter bằng `CONVERTER_SERVICE_TOKEN` + signed context token. Converter chỉ xử lý file, mapping, readiness, AI suggestion và export; không tự quyết định quyền user. MongoDB là source of truth cho user, conversion run, mapping profile V2 và session metadata; object storage S3-compatible giữ file tạm có TTL.

**Tech Stack:** Node.js/Express, MongoDB/Mongoose transaction, `multer`, Python FastAPI, Pydantic, `Decimal`, existing MISA template exporter, React/Vite, Vitest/Node test runner, `pytest`, Playwright smoke journey.

## Global Constraints

- Production không expose `VITE_PYTHON_API_URL` hoặc public FastAPI URL cho browser.
- Production bắt buộc `ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS=false`.
- Converter internal routes bắt buộc `x-converter-service-token`; thiếu/sai token trả `401`.
- Mọi conversion operation phải có signed context token gắn với user, workspace, target template, upload và conversion run.
- Frontend không được gửi `rows` làm source of truth cho export; backend/Converter đọc lại upload/session đã lưu.
- Export chỉ trả file sau khi backend đã kiểm tra readiness và charge usage idempotent thành công.
- AI chỉ đề xuất mapping/giải thích; không đổi severity, không bypass blocker, không tự sửa dữ liệu.
- Mapping profile phải qua semantic validator; confidence không thay thế validation.
- Không claim file “đúng luật 100%” hoặc nghiệp vụ “chắc chắn đúng” trong API/UI.
- Mọi rule kế toán/thuế mới phải có `source_url`, `checked_at`, `effective_from`/`effective_to` khi áp dụng được.
- Output tiếp tục copy/fill template MISA thật; không dựng workbook mới.
- Không log nội dung file, token, password, full raw rows hoặc full AI payload.
- Default feature flags mở rộng giữ `false` cho tới khi release gate đạt.

---

## Task 0: Freeze Baseline And Runtime Contract

**Files:**
- Modify: `E:\0. EXE2\ez-format\backend\.env.example`
- Modify: `E:\0. EXE2\ez-format\converter\.env.example`
- Modify: `E:\0. EXE2\ez-format\frontend\.env.example`
- Create: `E:\0. EXE2\ez-format\docs\qa\converter-gateway-baseline.md`
- Test: `E:\0. EXE2\ez-format\backend\tests\converterGatewayContract.test.js`

**Interfaces:**
- Produces the environment contract consumed by Node gateway and FastAPI internal auth.
- Does not change runtime behavior until Task 1 is enabled.

- [ ] **Step 1: Record current failures as regression cases.**

  Add a baseline document listing the reproducible cases:

  ```text
  mapping_profile_wrong_domain
  direct_converter_without_context
  upload_over_limit
  multiline_invoice_double_count
  v2_confirm_saved_as_v1
  vat_discount_ambiguous_basis
  ai_badge_docs_only
  session_lost_after_restart
  anonymization_metadata_leak
  ```

- [ ] **Step 2: Define exact environment names and safe defaults.**

  Add:

  ```env
  # backend
  CONVERTER_INTERNAL_URL=http://127.0.0.1:8000
  CONVERTER_SERVICE_TOKEN=replace-with-a-long-random-secret
  CONVERTER_PUBLIC_PROXY_ENABLED=true
  CONVERTER_MAX_FILE_BYTES=20971520
  CONVERTER_TIMEOUT_MS=120000
  CONVERTER_ANALYZE_LIMIT_PER_10_MINUTES=10
  CONVERTER_OPERATION_LIMIT_PER_MINUTE=120
  CONVERTER_EXPORT_LIMIT_PER_10_MINUTES=10
  CONVERSION_USAGE_MODE=charge_on_export
  CONVERTER_ARTIFACT_TTL_SECONDS=3600
  CONVERTER_OBJECT_STORAGE_REQUIRED=false

  # converter
  INTERNAL_SERVICE_TOKEN_REQUIRED=true
  MAX_UPLOAD_BYTES=20971520
  ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS=false
  CORS_ORIGINS=http://127.0.0.1:5173

  # frontend
  VITE_API_URL=http://127.0.0.1:5000/api
  # VITE_PYTHON_API_URL is local migration-only; never set in production.
  ```

- [ ] **Step 3: Add contract assertions.**

  Test production config rejects:

  ```js
  assert.equal(process.env.CONVERTER_PUBLIC_PROXY_ENABLED, "true");
  assert.notEqual(process.env.CONVERTER_SERVICE_TOKEN, "");
  assert.equal(process.env.ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS, "false");
  ```

- [ ] **Step 4: Run baseline checks.**

  ```powershell
  cd "E:\0. EXE2\ez-format"
  npm run qa:fast
  ```

  Expected: existing baseline passes; no production flags enabled.

- [ ] **Step 5: Commit.**

  ```powershell
  git add backend/.env.example converter/.env.example frontend/.env.example docs/qa/converter-gateway-baseline.md backend/tests/converterGatewayContract.test.js
  git commit -m "chore: define converter gateway contract"
  ```

## Task 1: Build Authenticated Node Converter Gateway

**Files:**
- Create: `E:\0. EXE2\ez-format\backend\controllers\converterGatewayController.js`
- Create: `E:\0. EXE2\ez-format\backend\routes\converterGateway.js`
- Create: `E:\0. EXE2\ez-format\backend\services\converterGatewayService.js`
- Create: `E:\0. EXE2\ez-format\backend\models\ConverterRateLimitBucket.js`
- Create: `E:\0. EXE2\ez-format\backend\middleware\converterRateLimit.js`
- Modify: `E:\0. EXE2\ez-format\backend\server.js`
- Modify: `E:\0. EXE2\ez-format\backend\services\converterClient.js`
- Test: `E:\0. EXE2\ez-format\backend\tests\converterGateway.test.js`

**Interfaces:**

Public Node routes, all protected by `requireDb` + `protect`:

```text
GET  /api/converter/capabilities
GET  /api/converter/templates
POST /api/converter/uploads/analyze             multipart file + target_template_id
POST /api/converter/mappings/preview            JSON
POST /api/converter/mappings/readiness          JSON
POST /api/converter/mappings/confirm            JSON
POST /api/converter/conversions/export          JSON, binary response
POST /api/converter/sessions                     JSON operation mutation
GET  /api/converter/sessions/:id                 JSON operation state
POST /api/student/sessions/:id/analyze          existing protected route, proxy with student context
POST /api/student/sessions/:id/operations/*     existing protected route, proxy with student context
POST /api/reconstructions/:id/operations/*      existing protected route, proxy with reconstruction context
```

Internal Converter request contract:

```js
{
  headers: {
    "x-converter-service-token": process.env.CONVERTER_SERVICE_TOKEN,
    "x-request-id": req.requestId,
    "x-conversion-context": contextToken
  }
}
```

- [ ] **Step 1: Write gateway route tests.**

  Cover:

  ```js
  test("unauthenticated analyze returns 401");
  test("inactive user returns 403");
  test("gateway forwards service token and request id");
  test("converter 422 is returned without losing readiness payload");
  test("converter binary export preserves Content-Disposition");
  test("client cannot supply arbitrary user id or owner scope");
  test("client rows are removed before export proxying");
  test("analyze rate limit returns 429 across gateway instances");
  ```

- [ ] **Step 2: Add bounded multipart parser.**

  Configure `multer.memoryStorage()` with `limits.fileSize` from `CONVERTER_MAX_FILE_BYTES`, allow only `.xls`/`.xlsx`, and reject with `413` before the controller calls Converter.

- [ ] **Step 3: Implement one gateway forwarding primitive.**

  `converterGatewayService.js` must expose:

  ```js
  async function forwardJson({ path, method, body, contextToken, requestId })
  async function forwardMultipart({ path, file, fields, contextToken, requestId })
  async function forwardBinary({ path, body, contextToken, requestId })
  ```

  Each primitive sets the internal service token, timeout, request ID, context header and preserves upstream status/error JSON. Never log request body.

- [ ] **Step 4: Add authenticated routes before legacy public converter access.**

  Mount:

  ```js
  app.use("/api/converter", require("./routes/converterGateway"));
  ```

  The public route must create/verify context itself; browser input cannot override `userId`, `ownerScope`, `workspaceId` or plan.

- [ ] **Step 5: Add MongoDB-backed rate-limit buckets.**

  Use atomic `$inc` on a unique `{ userId, operation, bucketStart }` record and a TTL index. Enforce `10 analyze/10 minutes`, `120 JSON operations/minute`, and `10 export attempts/10 minutes` by default. Return `429` with `Retry-After`; never rely on a process-local `Map` in production.

- [ ] **Step 6: Test gateway end-to-end with a mocked Converter.**

  ```powershell
  cd "E:\0. EXE2\ez-format\backend"
  node --test tests/converterGateway.test.js
  ```

  Expected: all gateway auth, forwarding, error and binary tests pass.

  Extend the existing protected `student` and `reconstructions` routers rather than
  creating a second public URL family. The frontend migration in Task 10 must use
  those Node routes for every Student Assistant and reconstruction operation.

- [ ] **Step 7: Commit.**

  ```powershell
  git add backend/controllers/converterGatewayController.js backend/routes/converterGateway.js backend/services/converterGatewayService.js backend/models/ConverterRateLimitBucket.js backend/middleware/converterRateLimit.js backend/server.js backend/services/converterClient.js backend/tests/converterGateway.test.js
  git commit -m "feat: add authenticated converter gateway"
  ```

## Task 2: Bind Conversion Run, Credit And Export Idempotency

**Files:**
- Modify: `E:\0. EXE2\ez-format\backend\models\ConversionRun.js`
- Create: `E:\0. EXE2\ez-format\backend\services\conversionEntitlementService.js`
- Modify: `E:\0. EXE2\ez-format\backend\services\conversionCreditService.js`
- Modify: `E:\0. EXE2\ez-format\backend\controllers\conversionRunController.js`
- Modify: `E:\0. EXE2\ez-format\backend\services\conversionContextService.js`
- Modify: `E:\0. EXE2\ez-format\backend\controllers\converterGatewayController.js`
- Test: `E:\0. EXE2\ez-format\backend\tests\conversionEntitlement.test.js`

**Data contract:**

Add to `ConversionRun`:

```js
conversionContextId: { type: String, index: true, default: "" },
operationSessionId: { type: String, index: true, default: "" },
usageState: {
  type: String,
  enum: ["not_chargeable", "chargeable", "charged", "charge_failed"],
  default: "chargeable",
},
usageIdempotencyKey: { type: String, unique: true, sparse: true },
exportArtifactKey: { type: String, default: "" },
inputSha256: { type: String, maxlength: 64, default: "" },
outputSha256: { type: String, maxlength: 64, default: "" },
```

- [ ] **Step 1: Add failing credit tests.**

  ```js
  test("user with zero credits cannot create conversion run");
  test("completed export charges one credit only");
  test("retrying same idempotency key never charges twice");
  test("monthly/yearly usage records run without decrementing file credits");
  test("charge failure prevents binary response");
  test("run owner cannot export another user's upload");
  ```

- [ ] **Step 2: Create run inside the gateway.**

  On authenticated analyze:

  1. Validate file size/name/template.
  2. Load current user/plan.
  3. Validate workspace access.
  4. Create `ConversionRun` with `processing`, owner snapshots, hash and idempotency key.
  5. Create context token containing `conversionRunId`, `userId`, `ownerScope`, `workspaceId`, `targetTemplateId`, `maxFileBytes` and scopes.
  6. Forward file to Converter.
  7. Persist returned `converterUploadId`.

- [ ] **Step 3: Make charge atomic.**

  Implement:

  ```js
  async function chargeCompletedConversion({ runId, userId, idempotencyKey })
  ```

  Use a MongoDB transaction and conditional update. For `free`/`perfile`, decrement only when the current credit is positive; for `monthly`/`yearly`, record `charged` without decrement. A second request with the same run returns the original charge result.

- [ ] **Step 4: Gate export response.**

  The controller must:

  ```text
  verify JWT owner + run owner
  verify context/run/upload/template binding
  ask Converter to revalidate and export
  charge atomically
  persist artifact/hash/status=completed
  return binary
  ```

  If any step fails, return error and no file bytes.

- [ ] **Step 5: Add stale-run cleanup.**

  Existing stale processing cancellation must also set `usageState=charge_failed` only when no export artifact exists; it must never charge cancelled runs.

- [ ] **Step 6: Run backend tests.**

  ```powershell
  cd "E:\0. EXE2\ez-format\backend"
  node --test tests/conversionEntitlement.test.js tests/conversionRuns.test.js
  ```

- [ ] **Step 7: Commit.**

  ```powershell
  git add backend/models/ConversionRun.js backend/services/conversionEntitlementService.js backend/services/conversionCreditService.js backend/controllers/conversionRunController.js backend/services/conversionContextService.js backend/controllers/converterGatewayController.js backend/tests/conversionEntitlement.test.js
  git commit -m "feat: bind converter usage to owned runs"
  ```

## Task 3: Lock FastAPI Behind Internal Auth And Upload Limits

**Files:**
- Create: `E:\0. EXE2\ez-format\converter\app\internal_auth.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\main.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\operation_store.py`
- Modify: `E:\0. EXE2\ez-format\converter\.env.example`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_internal_auth.py`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_upload_limits.py`

- [ ] **Step 1: Write failing auth tests.**

  ```python
  def test_analyze_without_service_token_returns_401(client):
      response = client.post("/api/v1/uploads/analyze")
      assert response.status_code == 401

  def test_export_without_service_token_returns_401(client):
      response = client.post("/api/v1/conversions/export", json={"upload_id": "upload-1"})
      assert response.status_code == 401

  def test_context_required_when_unauthenticated_mode_is_false(client, service_headers):
      response = client.post("/api/v1/mappings/preview", headers=service_headers, json={"upload_id": "upload-1"})
      assert response.status_code == 401

  def test_local_mode_is_only_allowed_when_explicitly_enabled(monkeypatch):
      monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false")
      assert unauthenticated_local_operations_enabled() is False
  ```

- [ ] **Step 2: Implement constant-time service-token dependency.**

  `require_internal_service(request)` compares `x-converter-service-token` with `hmac.compare_digest`, rejects missing configuration in production, and returns request ID for logging.

- [ ] **Step 3: Apply dependency to every non-health route.**

  Protect analyze, templates/capabilities, mappings, sessions, export, AI, student and reconstruction routes. `/healthz` exposes only status/capability booleans; it never accepts file or returns secrets.

- [ ] **Step 4: Enforce context scope.**

  For conversion routes require `conversion_context_token`; for student/reconstruction require their existing context token. Verify token claims match upload/session/target template before reading data.

- [ ] **Step 5: Replace unbounded reads.**

  Add:

  ```python
  async def read_upload_with_limit(file: UploadFile, max_bytes: int) -> bytes:
      # read 1 MiB chunks; stop at max_bytes + 1; raise HTTP 413
  ```

  Use it in analyze, legacy conversion, AI mapping, and any route still calling `await file.read()` directly. Keep existing stricter student/reconstruction limits.

- [ ] **Step 6: Disable legacy public export in production.**

  `ALLOW_LEGACY_ROW_EXPORT=false` and `ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS=false` become startup assertions for `NODE_ENV=production`.

- [ ] **Step 7: Run converter tests.**

  ```powershell
  cd "E:\0. EXE2\ez-format\converter"
  python -m pytest -q tests/test_internal_auth.py tests/test_upload_limits.py tests/test_api.py
  ```

- [ ] **Step 8: Commit.**

  ```powershell
  git add converter/app/internal_auth.py converter/app/main.py converter/app/operation_store.py converter/.env.example converter/tests/test_internal_auth.py converter/tests/test_upload_limits.py
  git commit -m "feat: lock converter behind internal auth"
  ```

## Task 4: Add Semantic MISA Mapping Validation

**Files:**
- Create: `E:\0. EXE2\ez-format\converter\app\mapping_semantics.py`
- Create: `E:\0. EXE2\ez-format\converter\app\misa_field_semantics.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\misa_readiness.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\mapping_profile_v2.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\mapping_profile_client.py`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_mapping_semantics.py`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness.py`

**Interfaces:**

```python
def validate_mapping_semantics(
    *,
    target_template_id: str,
    template_headers: list[str],
    source_headers: list[str],
    mapping: dict[str, object],
    defaults: dict[str, object],
    sample_rows: list[dict[str, object]],
    coa_codes: set[str] | None = None,
) -> list[MisaValidationIssue]:
    """Return deterministic semantic issues without changing mapping values."""
```

- [ ] **Step 1: Define deterministic target field metadata.**

  For every supported template, define target field kind: `enum`, `date`, `number`, `account`, `code`, `text`, `tax_rate`, `money`, `required`. Read target headers from the actual MISA template; never invent output columns.

- [ ] **Step 2: Add wrong-domain regression test.**

  ```python
  def test_commune_column_cannot_map_to_sales_form_enum():
      issues = validate_mapping_semantics(
          target_template_id="bsn_sales",
          template_headers=["Hình thức bán hàng", "Mã hàng (*)"],
          source_headers=["Phường/Xã (Khách hàng)"],
          mapping={"Phường/Xã (Khách hàng)": "Hình thức bán hàng"},
          defaults={}, formulas={},
          sample_rows=[{"Phường/Xã (Khách hàng)": "Phường 1"}],
      )
      assert any(issue.code == "mapping_domain_mismatch" and issue.severity == "blocker" for issue in issues)
  ```

- [ ] **Step 3: Validate candidate profiles before suggestion.**

  V1 SQLite and V2 Mongo candidates both pass the same semantic validator. Invalid candidate behavior:

  ```text
  reject candidate
  emit profile_rejected warning with stable profile id
  run heuristic/AI fallback
  never assign confidence=1.0 to rejected data
  ```

  Add a non-destructive quarantine status/reason for V2; for SQLite preserve the row and add `quarantined_at`/`quarantine_reason` migration fields.

- [ ] **Step 4: Validate AI output with the same function.**

  AI response cannot change severity or bypass required-field, enum, date, number and ownership checks.

- [ ] **Step 5: Add profile poisoning tests.**

  ```python
  def test_invalid_saved_profile_falls_back_to_heuristic():
      assert analyze_with_invalid_profile().mapping_source == "heuristic"

  def test_profile_confidence_does_not_override_semantic_blocker():
      assert issue_for_wrong_domain_profile().severity == "blocker"

  def test_ai_wrong_domain_mapping_is_rejected():
      assert validate_ai_mapping().accepted is False

  def test_unknown_account_is_warning_without_loaded_coa():
      assert account_issue(coa_codes=None).severity == "warning"

  def test_unknown_account_is_blocker_only_when_loaded_coa_proves_invalid():
      assert account_issue(coa_codes={"131"}, value="999").severity == "blocker"
  ```

- [ ] **Step 6: Run readiness tests.**

  ```powershell
  cd "E:\0. EXE2\ez-format\converter"
  python -m pytest -q tests/test_mapping_semantics.py tests/test_misa_readiness.py tests/test_misa_profile_api.py
  ```

- [ ] **Step 7: Commit.**

  ```powershell
  git add converter/app/mapping_semantics.py converter/app/misa_field_semantics.py converter/app/misa_workflow.py converter/app/misa_readiness.py converter/app/mapping_profile_v2.py converter/app/mapping_profile_client.py converter/tests/test_mapping_semantics.py converter/tests/test_misa_readiness.py
  git commit -m "feat: reject semantically unsafe MISA mappings"
  ```

## Task 5: Complete Mapping Profile V2 Lifecycle

**Files:**
- Modify: `E:\0. EXE2\ez-format\backend\controllers\mappingProfileV2Controller.js`
- Modify: `E:\0. EXE2\ez-format\backend\routes\mappingProfilesV2.js`
- Modify: `E:\0. EXE2\ez-format\backend\services\mappingProfileV2Service.js`
- Modify: `E:\0. EXE2\ez-format\backend\controllers\converterGatewayController.js`
- Modify: `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
- Modify: `E:\0. EXE2\ez-format\frontend\src\pages\ConvertPage.jsx`
- Modify: `E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.js`
- Test: `E:\0. EXE2\ez-format\backend\tests\mappingProfileV2Contract.test.js`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_mapping_profile_v2.py`
- Test: `E:\0. EXE2\ez-format\frontend\src\utils\converterOperations.test.mjs`

- [x] **Step 1: Add internal V2 confirm endpoint.**

  Add `POST /api/internal/mapping-profiles/v2/confirm` with service token + signed context. It accepts:

  ```json
  {
    "candidate_profile_id": "profile-123",
    "source_signature_hash": "hash-abc",
    "target_template_id": "bsn_sales",
    "mapping": {},
    "defaults": {},
    "formulas": {},
    "expected_version": 1,
    "user_correction": true
  }
  ```

  It creates a new immutable V2 version, validates ownership and semantic rules, and returns `profile_id`, `version`, `state_hash`, `status`.

- [x] **Step 2: Change `confirm_mapping()` to preserve V2.**

  If the analyze metadata contains a V2 candidate/context, call the internal V2 confirm endpoint and write:

  ```json
  {
    "mapping_profile_kind": "v2",
    "mapping_profile_version": 2,
    "profile_id": "profile-123",
    "profile_state_hash": "state-xyz"
  }
  ```

  Do not call V1 `save_mapping_profile()` in this branch.

- [x] **Step 3: Bind export to immutable V2 state.**

  Export must require the same profile ID/version/state hash observed at confirm. Stale version returns `409`; no output bytes are returned.

- [x] **Step 4: Update UI response state.**

  Show `Thiết lập V2 đã lưu` only after backend confirms activation. If V2 is unavailable, show explicit legacy fallback; never label V1 fallback as V2.

- [x] **Step 5: Add regression tests.**

  ```js
  test("UI confirm uses V2 endpoint when V2 candidate is active");
  test("confirm response stores v2 kind and state hash");
  test("stale V2 export returns 409");
  test("V1 fallback remains explicit and does not overwrite V2");
  ```

- [x] **Step 6: Run focused tests.**

  ```powershell
  cd "E:\0. EXE2\ez-format\backend"
  node --test tests/mappingProfileV2Contract.test.js
  cd "E:\0. EXE2\ez-format\converter"
  python -m pytest -q tests/test_mapping_profile_v2.py
  cd "E:\0. EXE2\ez-format\frontend"
  node --test --test-name-pattern="V2|profile" src/utils/converterOperations.test.mjs
  ```

  Staging and commit intentionally omitted per the current task instruction.

## Task 6: Fix Multi-Line Invoice Totals And VAT Basis

**Files:**
- Create: `E:\0. EXE2\ez-format\converter\app\document_totals.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\student_queries.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\accounting_assistant.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\misa_readiness.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\calculation_rules.py`
- Create: `E:\0. EXE2\ez-format\converter\app\vat_basis.py`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_document_totals.py`
- Modify: `E:\0. EXE2\ez-format\converter\tests\test_student_queries.py`
- Modify: `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness.py`

- [x] **Step 1: Update accounting references before changing tax rules.**

  Run the `update-ke-toan` workflow for current MISA import and VAT sources. Compare official law/MOF/MISA references with:

  ```text
  $HOME\.agents\skills\ke-toan\references\vietnam-tax-rules.md
  $HOME\.agents\skills\ke-toan\references\misa-import-export-guide.md
  $HOME\.agents\skills\ke-toan\references\misa-coding-rules.md
  ```

  Record changed/deprecated rules before coding; no rule is removed without a replacement source and impact check.

- [x] **Step 2: Define document-total aggregation contract.**

  Add this result model before the function implementation:

  ```python
  @dataclass(frozen=True)
  class DocumentTotalsReport:
      document_count: int
      sum_total: str | None
      status: Literal["complete", "needs_review", "blocked"]
      issues: list[str]
  ```

  Implement:

  ```python
  def aggregate_document_totals(
      rows: list[dict[str, object]],
      *,
      document_key_fields: list[str],
      line_amount_field: str | None,
      document_total_field: str | None,
) -> DocumentTotalsReport:
    """Aggregate line totals once and repeated document totals once per key."""
  ```

  Rules:

  ```text
  line amount: sum every detail row once
  repeated document total: count once per document key
  missing/ambiguous key: return needs_review, never fabricate a total
  duplicate document key with conflicting totals: blocker for validation, warning for assistant explanation
  ```

- [x] **Step 3: Add double-count regression test.**

  ```python
  def test_two_detail_rows_with_same_invoice_total_count_once():
      rows = [
          {"SOCT": "HD001", "TTVND": "108000"},
          {"SOCT": "HD001", "TTVND": "108000"},
      ]
      report = aggregate_document_totals(
          rows,
          document_key_fields=["SOCT"],
          line_amount_field=None,
          document_total_field="TTVND",
      )
      assert report.sum_total == "108000"
      assert report.document_count == 1
  ```

- [x] **Step 4: Make opaque source column resolution mapping-aware.**

  Resolve document key through source-to-target mapping and known aliases (`SOCT`, `Số chứng từ`, `Số hóa đơn`) before calculating counts/totals.

- [x] **Step 5: Define VAT basis explicitly.**

  `vat_basis.py` must return one of `line_after_discount`, `line_before_discount`, `invoice_taxable_base`, `unknown`. If source/template cannot disambiguate, produce a warning requiring user acknowledgement and a review explanation for assistant output. Produce a blocker only when an explicitly selected/source-backed basis yields a deterministic mismatch, or the actual VAT matches none of the supported calculations. Do not accept both bases as silently equivalent in one run.

- [x] **Step 6: Add VAT/discount tests.**

  ```python
  def test_vat_matches_selected_discount_basis():
      assert validate_vat_basis("line_after_discount").ok is True

  def test_vat_mismatch_is_blocker():
      assert validate_vat_basis("line_after_discount", vat="10000").severity == "blocker"

  def test_vat_basis_ambiguity_requires_acknowledgement():
      assert validate_vat_basis("unknown").severity == "warning"

  def test_vat_8_eligibility_remains_review_warning():
      assert validate_vat_rate("8%", eligibility="unknown").severity == "warning"
  ```

- [x] **Step 7: Run focused accounting tests and commit.**

  ```powershell
  cd "E:\0. EXE2\ez-format\converter"
  python -m pytest -q tests/test_document_totals.py tests/test_student_queries.py tests/test_misa_readiness.py tests/test_calculation_rules.py
  git add converter/app/document_totals.py converter/app/student_queries.py converter/app/accounting_assistant.py converter/app/misa_readiness.py converter/app/calculation_rules.py converter/app/vat_basis.py converter/tests/test_document_totals.py converter/tests/test_student_queries.py converter/tests/test_misa_readiness.py converter/tests/test_calculation_rules.py
  git commit -m "fix: prevent accounting total and VAT ambiguity"
  ```

## Task 7: Make AI Status And Fallback Truthful

**Files:**
- Modify: `E:\0. EXE2\ez-format\converter\app\ai_mapping_client.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\main.py`
- Modify: `E:\0. EXE2\ez-format\backend\controllers\converterGatewayController.js`
- Modify: `E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.js`
- Modify: `E:\0. EXE2\ez-format\frontend\src\pages\ConvertPage.jsx`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_ai_mapping_boundary.py`
- Test: `E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.status.test.mjs`

- [ ] **Step 1: Separate health states.**

  Return:

  ```json
  {
    "gateway": "online|offline",
    "model": "available|unknown|offline",
    "mapping": "not_run|heuristic|ai|mixed|failed"
  }
  ```

  `/docs` alone may set `gateway=online`, never `mapping=ai`.

- [ ] **Step 2: Wire opt-in AI mapping through internal gateway.**

  If `AI_PROVIDER=remote_http` and user/runtime enables AI, `analyze_upload` calls the existing `ai_mapping_client` with bounded headers/sample rows/profile summaries. The result is passed through semantic validation. On timeout/invalid JSON, return heuristic mapping with `source=heuristic` and warning `ai_unavailable`.

- [ ] **Step 3: Add privacy and boundary tests.**

  ```python
  def test_ai_payload_excludes_full_file_and_secrets():
      assert "raw_file_bytes" not in build_ai_payload()

  def test_ai_invalid_json_falls_back_to_heuristic():
      assert analyze_with_invalid_ai_json().mapping_source == "heuristic"

  def test_ai_cannot_change_blocker_to_warning():
      assert apply_ai_explanation(blocker_issue()).severity == "blocker"

  def test_gateway_online_does_not_claim_ai_mapping_used():
      assert capability_payload(gateway="online", mapping="not_run").mapping == "not_run"
  ```

- [ ] **Step 4: Update UI copy.**

  Display:

  ```text
  Converter online
  AI Gateway online — chưa chạy AI mapping
  AI mapping đã dùng
  AI offline — đang dùng heuristic an toàn
  ```

- [ ] **Step 5: Run tests and commit.**

  ```powershell
  cd "E:\0. EXE2\ez-format\converter"
  python -m pytest -q tests/test_ai_mapping_boundary.py tests/test_ai_gateway_security.py
  cd "E:\0. EXE2\ez-format\frontend"
  npm test -- --test-name-pattern="AI|converter status"
  git add converter frontend backend
  git commit -m "fix: report AI mapping state truthfully"
  ```

## Task 8: Move Session And Artifact State Off Local Disk

**Files:**
- Create: `E:\0. EXE2\ez-format\backend\models\ConversionArtifact.js`
- Create: `E:\0. EXE2\ez-format\backend\models\ConversionSessionState.js`
- Create: `E:\0. EXE2\ez-format\backend\services\conversionArtifactService.js`
- Create: `E:\0. EXE2\ez-format\backend\services\conversionSessionStateService.js`
- Create: `E:\0. EXE2\ez-format\backend\controllers\internalConversionSessionController.js`
- Create: `E:\0. EXE2\ez-format\backend\routes\internalConversionSessions.js`
- Modify: `E:\0. EXE2\ez-format\backend\models\ConversionRun.js`
- Modify: `E:\0. EXE2\ez-format\backend\controllers\converterGatewayController.js`
- Modify: `E:\0. EXE2\ez-format\backend\services\converterGatewayService.js`
- Modify: `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\operation_store.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\student_store.py`
- Create: `E:\0. EXE2\ez-format\converter\app\operation_store_client.py`
- Test: `E:\0. EXE2\ez-format\backend\tests\conversionArtifacts.test.js`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_session_restart_contract.py`

- [ ] **Step 1: Define storage adapter interface.**

  ```js
  async function putArtifact({ key, content, contentType, expiresAt })
  async function getArtifact({ key })
  async function deleteArtifact({ key })
  ```

  Implement local adapter for development and S3-compatible adapter for production. Production fails startup when `CONVERTER_OBJECT_STORAGE_REQUIRED=true` and storage config is missing.

- [ ] **Step 2: Persist only metadata in MongoDB.**

  Store upload/output/state artifact keys, hashes, owner, run ID, revision, TTL and status; never store raw file contents or row payloads in MongoDB documents. `ConversionSessionState` stores only ownership/version metadata and the current state artifact key.

- [ ] **Step 3: Add authenticated internal session-state API.**

  Expose Node-only endpoints under `/api/internal/converter-sessions`, protected by `x-converter-service-token` plus signed context. Python uses `operation_store_client.py`; Python does not connect directly to MongoDB or receive object-storage credentials.

- [ ] **Step 4: Bind Converter session to artifact key.**

  Context token includes artifact key hash, not raw storage credentials. Converter receives file via internal gateway and returns upload/session ID; Node can retrieve/replay after Converter restart.

- [ ] **Step 5: Add restart/multi-instance tests.**

  ```python
  def test_preview_export_resumes_after_converter_process_restart():
      assert resume_after_restart().status == "ready"

  def test_foreign_owner_cannot_read_artifact():
      assert read_artifact(owner="user-b", artifact_owner="user-a").status_code == 403

  def test_expired_artifact_returns_410_and_is_deleted():
      result = read_expired_artifact()
      assert result.status_code == 410
      assert result.deleted is True
  ```

- [ ] **Step 6: Commit.**

  ```powershell
  git add backend/models/ConversionArtifact.js backend/models/ConversionSessionState.js backend/services/conversionArtifactService.js backend/services/conversionSessionStateService.js backend/controllers/internalConversionSessionController.js backend/routes/internalConversionSessions.js backend/models/ConversionRun.js backend/controllers/converterGatewayController.js backend/services/converterGatewayService.js converter/app/misa_workflow.py converter/app/operation_store.py converter/app/student_store.py converter/app/operation_store_client.py backend/tests/conversionArtifacts.test.js converter/tests/test_session_restart_contract.py
  git commit -m "feat: persist converter artifacts across restarts"
  ```

## Task 9: Harden Student Anonymized Export

**Files:**
- Modify: `E:\0. EXE2\ez-format\converter\app\student_anonymization.py`
- Test: `E:\0. EXE2\ez-format\converter\tests\test_student_anonymization.py`

- [ ] **Step 1: Add leak regression fixtures.**

  Build an in-memory workbook containing PII in cell values, comments, hyperlinks, workbook properties, defined names, hidden sheets and external links.

- [ ] **Step 2: Sanitize all supported metadata.**

  Preserve workbook structure required for learning, but remove/replace PII from all scanned layers. Report each removed layer in the anonymization evidence packet.

- [ ] **Step 3: Fail closed on unsupported workbook features.**

  If a layer cannot be scanned safely, return `needs_review` and disable anonymized export; do not report scanner passed.

- [ ] **Step 4: Run tests and commit.**

  ```powershell
  cd "E:\0. EXE2\ez-format\converter"
  python -m pytest -q tests/test_student_anonymization.py
  git add converter/app/student_anonymization.py converter/tests/test_student_anonymization.py
  git commit -m "fix: close student anonymization metadata leaks"
  ```

## Task 10: Replace Frontend Direct FastAPI Calls

**Files:**
- Modify: `E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.js`
- Modify: `E:\0. EXE2\ez-format\frontend\src\hooks\useStudentAssistantApi.js`
- Modify: `E:\0. EXE2\ez-format\frontend\src\hooks\useVoucherReconstruction.js`
- Modify: `E:\0. EXE2\ez-format\frontend\src\utils\converterOperations.js`
- Modify: `E:\0. EXE2\ez-format\frontend\src\pages\ConvertPage.jsx`
- Modify: `E:\0. EXE2\ez-format\frontend\src\pages\StudentAssistantPage.jsx`
- Modify: `E:\0. EXE2\ez-format\frontend\src\services\api.js`
- Test: `E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.status.test.mjs`
- Test: `E:\0. EXE2\ez-format\frontend\src\utils\converterGatewayContract.test.mjs`

- [ ] **Step 1: Replace URL construction.**

  Remove production use of `pythonBaseURL`. Use the existing Axios `api` client so JWT and `VITE_API_URL` are used for every converter operation.

- [ ] **Step 2: Remove client-row export.**

  Export request contains only:

  ```json
  {
    "runId": "run-123",
    "uploadId": "upload-123",
    "profileId": "profile-123",
    "sessionId": "session-123",
    "revision": 2,
    "stateHash": "state-xyz",
    "acknowledgeWarnings": true,
    "idempotencyKey": "uuid"
  }
  ```

- [ ] **Step 3: Make conversion log mandatory.**

  Do not continue when `POST /api/conversion-runs` fails. Show a persistent error with retry; do not send the file to Converter.

- [ ] **Step 4: Handle 401/402/403/409/413/422/429/500 explicitly.**

  UI messages:

  ```text
  401: Phiên đăng nhập hết hạn
  402: Không còn lượt chuyển đổi
  403: Không có quyền dùng hồ sơ này
  409: Dữ liệu đã thay đổi; tải lại phiên
  413: File vượt 20 MB
  422: Còn lỗi MISA cần xử lý
  429: Quá nhiều yêu cầu; thử lại sau
  500: Dịch vụ tạm thời lỗi; file chưa bị trừ lượt
  ```

- [ ] **Step 5: Remove production `VITE_PYTHON_API_URL`.**

  Keep it only in local migration documentation. Add a build check that fails if the production environment exposes it.

- [ ] **Step 6: Run frontend tests/build and commit.**

  ```powershell
  cd "E:\0. EXE2\ez-format\frontend"
  npm test
  npm run lint
  npm run build
  git add src/hooks/useConverterApi.js src/hooks/useStudentAssistantApi.js src/hooks/useVoucherReconstruction.js src/utils/converterOperations.js src/pages/ConvertPage.jsx src/pages/StudentAssistantPage.jsx src/services/api.js src/utils/converterGatewayContract.test.mjs
  git commit -m "refactor: route browser conversion through Node gateway"
  ```

## Task 11: Full Regression, Security And User-Journey Gate

**Files:**
- Create: `E:\0. EXE2\ez-format\scripts\qa-converter-gateway.ps1`
- Create: `E:\0. EXE2\ez-format\docs\qa\converter-gateway-release-gate.md`
- Create: `E:\0. EXE2\ez-format\frontend\tests\converter-gateway.journey.spec.mjs`
- Modify: `E:\0. EXE2\ez-format\scripts\qa-accounting-operations.ps1`

- [ ] **Step 1: Add direct API security gate.**

  Run against a production-like stack:

  ```text
  direct FastAPI analyze without service token -> 401
  direct FastAPI export without service token -> 401
  direct Converter CORS browser request -> denied
  Node gateway without JWT -> 401
  wrong workspace context -> 403/409
  other user's upload/profile/run -> 403/404
  over-limit upload -> 413
  duplicate export -> one charge, one artifact
  ```

- [ ] **Step 2: Add accounting integrity gate.**

  Test real fixtures:

  ```text
  E:\0. EXE2\Chi tiết bán hàng 05.12 - 25.12.xlsx
  $env:USERPROFILE\Downloads\MUA_VAO_0317262773 (7).xlsx
  E:\0. EXE2\Import misa 05.12 - 25.12.xls
  $env:USERPROFILE\Downloads\mua_hang_trong_nuoc_full.xls
  ```

  Verify template headers/styles, required fields, document counts, line totals, VAT basis, no duplicate invoice total, and no wrong-domain profile reuse.

- [ ] **Step 3: Add user journeys.**

  Cover authenticated user, no credit, upload too large, analyze, edit mapping, readiness blocker, warning acknowledgement, preview, export, retry after network failure, duplicate click, AI online/offline, admin history, Student Assistant and mobile 390px.

- [ ] **Step 4: Run all tests.**

  ```powershell
  cd "E:\0. EXE2\ez-format\backend"
  node --test
  cd "E:\0. EXE2\ez-format\converter"
  python -m pytest -q
  cd "E:\0. EXE2\ez-format\frontend"
  npm test
  npm run lint
  npm run build
  cd "E:\0. EXE2\ez-format"
  npm run qa:fast
  npm run qa:accounting-operations -- -Runs 3 -AccountingQaReport "E:\\0. EXE2\\ez-format\\docs\\qa\\independent-ke-toan-review.md"
  ```

  Expected:

  ```text
  zero P0/P1 findings
  three consecutive accounting-operation gate passes
  performance 10k <= 20s, 50k <= 75s
  independent ke-toan report: verdict PASS, p0 0, p1 0
  ```

- [ ] **Step 5: Add rollback and rollout controls.**

  Release sequence:

  ```text
  deploy Node gateway disabled for public traffic
  run synthetic gateway checks
  enable one internal test user
  monitor 401/402/409/413/422/429, latency, charge failures, export failures
  enable public traffic gradually
  keep old direct URL disabled
  rollback by disabling gateway feature flag and restoring previous frontend build
  ```

- [ ] **Step 6: Commit release evidence only after gate passes.**

  ```powershell
  git add scripts/qa-converter-gateway.ps1 docs/qa/converter-gateway-release-gate.md frontend/tests/converter-gateway.journey.spec.mjs scripts/qa-accounting-operations.ps1
  git commit -m "test: add converter gateway release gate"
  ```

---

## Acceptance Criteria

- Browser cannot call Converter directly in production.
- Every conversion run has an authenticated owner, plan/credit decision, context token and MongoDB run record.
- Export cannot return bytes when readiness blocks, user is unauthorized, usage charge fails or token/session is stale.
- A corrupted mapping profile cannot silently map a source field into an incompatible MISA target.
- V2 profile confirmation remains V2 through export; stale versions fail closed.
- Multi-line invoices do not double-count repeated document totals.
- VAT với basis chiết khấu mơ hồ tạo warning bắt buộc xác nhận; mismatch xác định vẫn chặn export.
- AI status distinguishes gateway availability from actual AI mapping use.
- AI offline does not break deterministic conversion.
- Restart/multi-instance operation resumes through persistent artifact/session metadata.
- Student anonymized export removes or blocks all unsupported PII layers.
- Real sales/purchase files still export with the real MISA template format.
- Full tests, browser journeys, performance benchmark and independent `ke-toan` gate pass.

## Explicit Non-Goals

- Không tự phân loại hàng hóa/dịch vụ để kết luận VAT đúng/sai nếu thiếu dữ liệu nguồn.
- Không tự sửa tiền, tài khoản, ngày hoặc mapping mơ hồ mà không có user confirmation.
- Không fine-tune model trong phase hardening này.
- Không thay payment/admin/plan product behavior ngoài phần charge authorization cần cho conversion.
- Không giữ public FastAPI compatibility trong production.
