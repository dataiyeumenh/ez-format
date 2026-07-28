# Task 2 Brief

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

## Workspace Safety

- Work directly in E:\0. EXE2\ez-format on branch Experimental.
- Preserve existing staged/unstaged/untracked changes; no stage/commit/reset/revert/checkout/clean.
- Edit only the seven task files.
- Inspect current User/Plan/ConversionRun/credit service schemas; do not guess.
- Use TDD: failing entitlement/idempotency tests first, then implementation.
- Mongo transactions/conditional updates must fail closed if unavailable; no charge before export artifact/readiness success.
- Report exact RED/GREEN/full backend results.
