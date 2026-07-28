# Task 1 Brief

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


## Workspace Safety

- Work directly in E:\0. EXE2\ez-format on branch Experimental.
- Preserve existing staged/unstaged/untracked changes; no stage/commit/reset/revert/checkout/clean.
- Edit only the eight task files.
- Use TDD: add gateway tests first, capture RED; implement; capture GREEN.
- Do not log request bodies, tokens, full raw rows or AI payloads.
- Reuse existing auth middleware/context/converter client patterns after inspecting them; do not invent user/account schema.
- Report exact files, RED/GREEN/QA commands, pass counts, concerns.
