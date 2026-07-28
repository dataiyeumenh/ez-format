# Task 0 Brief

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

## Task

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

## Workspace Safety

- Work directly in E:\0. EXE2\ez-format on branch Experimental.
- Existing index/worktree is dirty. Do not stage, commit, reset, revert, checkout, clean, or alter unrelated files.
- Edit only the five task files.
- Follow TDD: first run/add a failing contract test, capture RED; implement; capture GREEN.
- Report exact files changed and commands/results.
