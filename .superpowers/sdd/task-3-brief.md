# Task 3 Brief

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


## Workspace Safety

- Work directly in E:\0. EXE2\ez-format; preserve dirty index/worktree.
- No stage/commit/reset/revert/checkout/clean.
- Edit only six task files unless a route cannot be secured without a focused test fixture update.
- Inspect all FastAPI routes and existing context-token verification; no schema guessing.
- TDD RED/GREEN required. Never weaken existing student/reconstruction limits.
- Health endpoint must not reveal secrets or file/session data.
