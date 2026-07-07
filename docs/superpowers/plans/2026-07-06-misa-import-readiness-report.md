# MISA Import Readiness Report - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plan path:** `E:\0. EXE2\ez-format\docs\superpowers\plans\2026-07-06-misa-import-readiness-report.md`

## 0. Goal

Thêm bước **MISA Import Readiness Report** vào luồng convert để kiểm tra dữ liệu đã map trước khi preview/export:

```text
Upload raw Excel
→ Auto mapping raw → MISA template thật
→ User sửa mapping/default/formula nếu cần
→ Kiểm tra readiness/import-risk
→ Preview
→ Export MISA .xls
```

Mục tiêu sản phẩm:

- Bắt lỗi kỹ thuật/import MISA có thể xác định trước khi tải file.
- Chặn tải file khi còn lỗi chắc chắn làm sai hoặc fail import.
- Cảnh báo nghiệp vụ/kế toán cần người dùng rà soát nhưng không tự kết luận thay kế toán.
- Không để AI quyết định severity hoặc bypass rule.
- Giữ nguyên cơ chế export đang copy/fill template `.xls` thật.

## 1. Verified basis / căn cứ thiết kế

### 1.1 MISA import behavior

Nguồn chính thức MISA ACT hướng dẫn nhập khẩu Excel có các bước chọn file, chọn sheet, chọn dòng tiêu đề, ghép cột và kiểm tra dữ liệu trước khi import:

- `https://helpact.misa.vn/kb/html_10050000/`
- `https://helpact.misa.vn/kb/lam-the-nao-khi-nhap-khau-danh-muc-so-du-chung-tu-tu-excel-vao-phan-mem-bao-loi/`

Cách dùng trong app:

- Cột trong template MISA có `(*)` là cột bắt buộc.
- Header/template thật là source of truth, không hardcode schema cũ.
- Readiness report mô phỏng tầng “kiểm tra dữ liệu” trước khi user tải file.

### 1.2 Product safety copy

App **được nói**:

```text
Dữ liệu chưa sẵn sàng để import MISA.
Cột bắt buộc đang thiếu giá trị.
Số tiền/thuế không khớp công thức tính toán.
Cần kế toán rà soát cảnh báo nghiệp vụ.
```

App **không được nói**:

```text
File đúng luật 100%.
Thuế suất này chắc chắn đúng/sai với mặt hàng.
Tài khoản này chắc chắn đúng/sai nghiệp vụ nếu chưa có danh mục kế toán của doanh nghiệp.
```

## 2. Architecture

```text
Frontend React
  - gọi analyze/preview/readiness/export
  - hiển thị readiness card + issue table
  - không tự quyết định đúng/sai

Converter FastAPI
  - source of truth
  - apply mapping ra output rows theo template MISA
  - chạy deterministic readiness rules
  - chặn export bằng backend gate

Template Engine
  - đọc template MISA thật
  - `(*)` headers => required fields
  - export vẫn copy/fill `.xls` template thật

AI Gateway/Ollama
  - chỉ hỗ trợ mapping/explanation
  - không được đổi severity, không được mở khóa export
```

## 3. Export policy

```text
blocker > 0
→ Disable download ở frontend
→ Backend export trả 422 nếu vẫn gọi API

warning > 0 và user chưa tick xác nhận
→ Disable download ở frontend
→ Backend export trả 422 nếu vẫn gọi API

warning > 0 và user đã tick xác nhận
→ Cho download

không có blocker/warning
→ Cho download ngay
```

Severity policy:

| Severity | Khi nào dùng | Export |
|---|---|---|
| `blocker` | Lỗi deterministic: thiếu required, sai số học, không parse được ngày/số, duplicate chứng từ mâu thuẫn | Không cho export |
| `warning` | Cần kế toán đánh giá: mã hàng fallback bằng tên hàng, tài khoản gợi ý, VAT eligibility, phương thức thanh toán lạ | Cho export sau khi user xác nhận |
| `info` | Normalize dữ liệu: trim text, bỏ dòng trắng, chuẩn hoá ngày/số | Không chặn |

## 4. Backend API contract

### 4.1 New endpoint

Add:

```http
POST /api/v1/mappings/readiness
```

Request:

```json
{
  "upload_id": "uuid",
  "target_template_id": "misa_purchase_domestic",
  "mapping": {},
  "defaults": {},
  "formulas": {},
  "rows": null
}
```

Notes:

- `rows` optional: nếu frontend đã có edited preview rows thì gửi lên để backend validate đúng dữ liệu user đang xem.
- Nếu `rows = null`, backend tự đọc upload cache và apply mapping/default/formula.
- Backend không tin kết quả cũ; export vẫn revalidate.

Response:

```json
{
  "ok": false,
  "status": "blocked",
  "score": 72,
  "summary": {
    "blocker": 2,
    "warning": 4,
    "info": 1
  },
  "issues": [
    {
      "severity": "blocker",
      "category": "template",
      "code": "required_value_blank",
      "row": 25,
      "field": "Mã hàng (*)",
      "invoice": "HD000123",
      "message": "Cột bắt buộc Mã hàng (*) đang trống.",
      "expected": "Có giá trị",
      "actual": "",
      "delta": null,
      "fix_hint": "Kiểm tra mapping hoặc bổ sung mã hàng trước khi tải file MISA.",
      "source_url": "https://helpact.misa.vn/kb/html_10050000/"
    }
  ],
  "reconciliation": {
    "input_rows": 1930,
    "output_rows": 1930,
    "invoice_count": 420,
    "sum_amount": "123456789",
    "sum_vat": "9876543",
    "sum_total": "133333332",
    "unmapped_source_columns": ["Ghi chú nội bộ"]
  },
  "disclaimer": "EzFormat kiểm tra lỗi kỹ thuật/import có thể xác định; kế toán vẫn cần rà soát nghiệp vụ và quy định áp dụng."
}
```

### 4.2 Export request update

Existing endpoint remains:

```http
POST /api/v1/conversions/export
```

Extend accepted body:

```json
{
  "upload_id": "uuid",
  "profile_id": "uuid",
  "rows": [],
  "acknowledge_warnings": true
}
```

Backend behavior:

- Rebuild/read profile mapping.
- Re-run readiness using latest profile + optional edited rows.
- If blocker: return `422` with readiness report JSON.
- If warnings and not acknowledged: return `422` with readiness report JSON.
- Else export `.xls` as before.

## 5. File plan

### 5.1 Backend create

- `E:\0. EXE2\ez-format\converter\app\misa_readiness.py`
- `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness.py`
- `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness_api.py`

### 5.2 Backend modify

- `E:\0. EXE2\ez-format\converter\app\models.py`
- `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
- `E:\0. EXE2\ez-format\converter\app\main.py`

### 5.3 Frontend create

- `E:\0. EXE2\ez-format\frontend\src\components\ValidationReadinessCard.jsx`
- `E:\0. EXE2\ez-format\frontend\src\components\ValidationIssueTable.jsx`

### 5.4 Frontend modify

- `E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.js`
- `E:\0. EXE2\ez-format\frontend\src\pages\ConvertPage.jsx`

## 6. Data models

Modify `converter/app/models.py`.

Add:

```py
from typing import Any, Literal
from pydantic import BaseModel, Field

ReadinessSeverity = Literal["blocker", "warning", "info"]
ReadinessStatus = Literal["ready", "needs_review", "blocked"]

class MisaReadinessIssue(BaseModel):
    severity: ReadinessSeverity
    category: str
    code: str
    message: str
    row: int | None = None
    field: str | None = None
    invoice: str | None = None
    expected: Any = None
    actual: Any = None
    delta: Any = None
    fix_hint: str | None = None
    source_url: str | None = None

class MisaReadinessSummary(BaseModel):
    blocker: int = 0
    warning: int = 0
    info: int = 0

class MisaReconciliationReport(BaseModel):
    input_rows: int
    output_rows: int
    invoice_count: int | None = None
    sum_amount: str | None = None
    sum_vat: str | None = None
    sum_total: str | None = None
    unmapped_source_columns: list[str] = Field(default_factory=list)

class MisaReadinessReport(BaseModel):
    ok: bool
    status: ReadinessStatus
    score: int
    summary: MisaReadinessSummary
    issues: list[MisaReadinessIssue]
    reconciliation: MisaReconciliationReport
    disclaimer: str
```

Compatibility note:

- Do not rename existing public models.
- Add models at end of file unless symbols are already grouped by converter models.

## 7. Rule set MVP

### 7.1 Blockers

| Code | Category | Trigger | Source |
|---|---|---|---|
| `required_mapping_missing` | `template` | MISA header contains `(*)` but no mapping/default/formula | MISA import guide |
| `required_value_blank` | `template` | Active output row blank in required `(*)` column | MISA import guide |
| `date_unparseable` | `format` | Required/common date field cannot parse | deterministic |
| `number_unparseable` | `format` | Required/common money/quantity field cannot parse | deterministic |
| `line_amount_mismatch` | `calculation` | `quantity * unit_price - discount` not equal amount beyond tolerance | deterministic |
| `vat_amount_mismatch` | `tax` | VAT amount does not match taxable amount × VAT rate beyond tolerance | deterministic |
| `duplicate_document_key` | `document` | Same invoice/document key but conflicting supplier/date/amount/detail | deterministic |

### 7.2 Warnings

| Code | Category | Trigger | Reason |
|---|---|---|---|
| `master_data_review_required` | `master_data` | Mã hàng/Mã NCC/Mã kho is fallback/generated/not in known list | Needs MISA company master data |
| `account_review_required` | `accounting` | TK kho/TK chi phí/TK thuế generated by heuristic | Needs accountant review |
| `vat_policy_review_required` | `tax` | VAT 8%/5% classification exists but goods/service eligibility is unknown | Legal/business judgment |
| `payment_method_review_required` | `payment` | Payment method copied from raw file may not match MISA accepted value | MISA/company config judgment |
| `unused_source_columns` | `mapping` | Raw columns not used after mapping | May be fine, but user should notice |

### 7.3 Info

| Code | Trigger |
|---|---|
| `blank_row_ignored` | Blank raw row skipped |
| `text_normalized` | Trimmed whitespace/control chars |
| `number_normalized` | Parsed VN/EN number format |
| `date_normalized` | Parsed Excel serial/date text |

## 8. Core backend algorithm

Create `converter/app/misa_readiness.py`.

Public API:

```py
def build_readiness_report(
    table: InputTable,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    edited_rows: list[dict[str, Any]] | None = None,
) -> MisaReadinessReport:
    ...
```

Pseudo-flow:

```py
1. Load target template metadata by target_template_id.
2. Extract required headers from template headers containing (*).
3. If edited_rows provided:
      output_rows = edited_rows
   Else:
      output_rows = apply_mapping(table, mapping, defaults, formulas)
4. Run required mapping checks against mapping/default/formula.
5. Run required value checks against output_rows.
6. Run parse checks for date/number fields.
7. Run amount and VAT math checks.
8. Run duplicate document checks.
9. Add business review warnings.
10. Build reconciliation totals.
11. Compute status/score.
12. Return MisaReadinessReport.
```

Score:

```py
score = 100
score -= blocker_count * 25
score -= warning_count * 5
score -= min(info_count, 10) * 1
score = max(0, min(100, score))
```

Status:

```py
if summary.blocker > 0:
    status = "blocked"
elif summary.warning > 0:
    status = "needs_review"
else:
    status = "ready"
```

## 9. Implementation tasks

### Task 1 - Add backend models

**Files:**

- Modify: `E:\0. EXE2\ez-format\converter\app\models.py`
- Create/modify test: `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness.py`

Steps:

- [ ] Add `ReadinessSeverity`, `ReadinessStatus` type aliases.
- [ ] Add `MisaReadinessIssue`.
- [ ] Add `MisaReadinessSummary`.
- [ ] Add `MisaReconciliationReport`.
- [ ] Add `MisaReadinessReport`.
- [ ] Test JSON serialization preserves expected fields.

Test:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest tests/test_misa_readiness.py -q
```

Expected:

- Test should fail before models exist.
- Test should pass after models are added.

Commit suggestion:

```powershell
git add "E:\0. EXE2\ez-format\converter\app\models.py" "E:\0. EXE2\ez-format\converter\tests\test_misa_readiness.py"
git commit -m "feat(converter): add MISA readiness models"
```

### Task 2 - Add readiness rule engine

**Files:**

- Create: `E:\0. EXE2\ez-format\converter\app\misa_readiness.py`
- Modify test: `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness.py`

Steps:

- [ ] Implement `_required_headers(template_headers)`.
- [ ] Implement `_is_blank(value)`.
- [ ] Implement `_parse_decimal(value)` using `Decimal`, not float.
- [ ] Implement `_parse_vietnamese_date(value)`.
- [ ] Implement `_extract_invoice_key(row)` with safe fallback.
- [ ] Implement `_issue(...)` helper.
- [ ] Implement required mapping checks.
- [ ] Implement required value checks.
- [ ] Implement date/number parse checks.
- [ ] Implement amount math check.
- [ ] Implement VAT math check.
- [ ] Implement duplicate document conflict check.
- [ ] Implement warning generation for master data/account/payment review.
- [ ] Implement reconciliation summary.
- [ ] Implement status/score.

Important implementation notes:

- Use current mapping/apply functions from `misa_workflow.py`; do not duplicate mapping engine.
- Use template metadata from current template engine; do not hardcode column lists.
- Do not treat all empty optional columns as errors.
- Do not block `Mã hàng` fallback when raw file has no product code; use warning.
- Tolerance for money mismatch: default `1 VND`.
- VAT check must accept line-level rounding and invoice-level rounding where possible.

Tests:

- [ ] `test_readiness_blocks_missing_required_mapping`
- [ ] `test_readiness_blocks_blank_required_value_after_mapping`
- [ ] `test_readiness_blocks_unparseable_date_and_number`
- [ ] `test_readiness_blocks_amount_mismatch`
- [ ] `test_readiness_blocks_vat_mismatch`
- [ ] `test_readiness_blocks_conflicting_duplicate_document_key`
- [ ] `test_readiness_warns_master_data_review_only`

Run:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest tests/test_misa_readiness.py -q
```

Commit suggestion:

```powershell
git add "E:\0. EXE2\ez-format\converter\app\misa_readiness.py" "E:\0. EXE2\ez-format\converter\tests\test_misa_readiness.py"
git commit -m "feat(converter): add MISA readiness rules"
```

### Task 3 - Add readiness workflow + API endpoint

**Files:**

- Modify: `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\main.py`
- Create: `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness_api.py`

Workflow helper in `misa_workflow.py`:

```py
def readiness_mapping(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    edited_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    table = _read_upload_table(upload_id)
    report = build_readiness_report(
        table,
        target_template_id,
        mapping,
        defaults or {},
        formulas or {},
        edited_rows=edited_rows,
    )
    return report.model_dump(mode="json")
```

API endpoint in `main.py`:

```py
@app.post("/api/v1/mappings/readiness")
async def readiness_misa_mapping(body: dict) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            readiness_mapping,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            edited_rows=body.get("rows") if isinstance(body.get("rows"), list) else None,
        )
        return JSONResponse(jsonable_encoder(payload))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
```

Tests:

- [ ] API returns `ready` for a valid small dataset.
- [ ] API returns `blocked` for blank required value.
- [ ] API returns source_url on template blocker.
- [ ] Unknown upload_id returns 404/400 consistently with existing API style.

Run:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest tests/test_misa_readiness_api.py tests/test_misa_readiness.py -q
```

Commit suggestion:

```powershell
git add "E:\0. EXE2\ez-format\converter\app\misa_workflow.py" "E:\0. EXE2\ez-format\converter\app\main.py" "E:\0. EXE2\ez-format\converter\tests\test_misa_readiness_api.py"
git commit -m "feat(converter): expose MISA readiness API"
```

### Task 4 - Backend export gate

**Files:**

- Modify: `E:\0. EXE2\ez-format\converter\app\misa_workflow.py`
- Modify: `E:\0. EXE2\ez-format\converter\app\main.py`
- Modify existing export tests or create new tests in `E:\0. EXE2\ez-format\converter\tests\test_misa_readiness_api.py`

Steps:

- [ ] Extend `export_confirmed_profile(...)` to accept `edited_rows=None`, `acknowledge_warnings=False`.
- [ ] Re-run readiness inside export before writing workbook.
- [ ] If blocker exists: raise/return structured 422.
- [ ] If warning exists and not acknowledged: raise/return structured 422.
- [ ] If warnings acknowledged: continue export.
- [ ] Preserve existing generated filename behavior.
- [ ] Preserve existing `.xls` template-copy export path.

Suggested internal error convention:

```py
class ReadinessGateError(ValueError):
    def __init__(self, report: MisaReadinessReport):
        self.report = report
        super().__init__("MISA readiness gate failed")
```

If adding class is too invasive, use prefixed `ValueError`, but class is cleaner.

API behavior:

```py
except ReadinessGateError as exc:
    return JSONResponse(
        status_code=422,
        content=jsonable_encoder(exc.report.model_dump(mode="json")),
    )
```

Tests:

- [ ] `test_export_blocks_when_readiness_has_blocker`
- [ ] `test_export_blocks_warning_without_acknowledgement`
- [ ] `test_export_allows_warning_when_acknowledged`

Run:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest tests/test_misa_readiness_api.py tests/test_api.py -q
```

Commit suggestion:

```powershell
git add "E:\0. EXE2\ez-format\converter\app\misa_workflow.py" "E:\0. EXE2\ez-format\converter\app\main.py" "E:\0. EXE2\ez-format\converter\tests\test_misa_readiness_api.py"
git commit -m "feat(converter): gate MISA export by readiness"
```

### Task 5 - Frontend API hook + components

**Files:**

- Modify: `E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.js`
- Create: `E:\0. EXE2\ez-format\frontend\src\components\ValidationReadinessCard.jsx`
- Create: `E:\0. EXE2\ez-format\frontend\src\components\ValidationIssueTable.jsx`

Steps:

- [ ] Add `checkReadiness(payload)` function in API hook.
- [ ] Extend export call to send `acknowledge_warnings`.
- [ ] Create readiness card component.
- [ ] Create issue table component.
- [ ] Include source links when `source_url` exists.
- [ ] Use accessible buttons/checkbox labels.
- [ ] Ensure mobile layout does not overflow.

`checkReadiness` shape:

```js
const checkReadiness = useCallback(async (payload) => {
  const response = await fetch(`${pythonBaseURL}/api/v1/mappings/readiness`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response, "Không kiểm tra được trạng thái sẵn sàng import MISA.");
}, [pythonBaseURL]);
```

Readiness card UX:

```text
Sẵn sàng import MISA: 92/100
0 lỗi cần sửa
3 cảnh báo cần rà soát
[ ] Tôi đã kiểm tra các cảnh báo này
```

Issue table columns:

```text
Mức độ | Dòng | Cột | Nội dung | Giá trị hiện tại | Kỳ vọng | Cách sửa | Nguồn
```

Run:

```powershell
cd "E:\0. EXE2\ez-format\frontend"
npm run build
```

Commit suggestion:

```powershell
git add "E:\0. EXE2\ez-format\frontend\src\hooks\useConverterApi.js" "E:\0. EXE2\ez-format\frontend\src\components\ValidationReadinessCard.jsx" "E:\0. EXE2\ez-format\frontend\src\components\ValidationIssueTable.jsx"
git commit -m "feat(frontend): add MISA readiness UI components"
```

### Task 6 - Wire readiness into Convert page

**Files:**

- Modify: `E:\0. EXE2\ez-format\frontend\src\pages\ConvertPage.jsx`

Steps:

- [ ] Import `ValidationReadinessCard` and `ValidationIssueTable`.
- [ ] Add states:
  - `readinessReport`
  - `readinessLoading`
  - `acknowledgeWarnings`
- [ ] Reset readiness state when file/template/mapping changes.
- [ ] Add `buildReadinessPayload(rows = null)`.
- [ ] Add `runReadinessCheck(rows = null)`.
- [ ] Run readiness after successful preview.
- [ ] Add button “Kiểm tra lỗi” near Preview/Download.
- [ ] Disable download when blocker exists.
- [ ] Disable download when warnings exist and checkbox not ticked.
- [ ] Re-check readiness immediately before export.
- [ ] Send `acknowledgeWarnings` to export API.
- [ ] Display backend 422 readiness report if export catches it.

Suggested gating code:

```js
const hasReadinessBlockers = (readinessReport?.summary?.blocker || 0) > 0;
const hasUnacknowledgedWarnings =
  (readinessReport?.summary?.warning || 0) > 0 && !acknowledgeWarnings;
const downloadDisabledByReadiness =
  readinessLoading || hasReadinessBlockers || hasUnacknowledgedWarnings;
```

Suggested copy:

```text
Còn lỗi cần sửa trước khi tải file MISA.
Có cảnh báo nghiệp vụ, vui lòng rà soát và xác nhận trước khi tải.
```

Run:

```powershell
cd "E:\0. EXE2\ez-format\frontend"
npm run build
```

Commit suggestion:

```powershell
git add "E:\0. EXE2\ez-format\frontend\src\pages\ConvertPage.jsx"
git commit -m "feat(frontend): gate convert downloads by readiness"
```

### Task 7 - End-to-end QA with real files

**Files:**

- Optional artifact: `E:\0. EXE2\ez-format\.artifacts\misa-readiness-qa\qa-summary.json`

Steps:

- [ ] Run focused converter tests:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest tests/test_misa_readiness.py tests/test_misa_readiness_api.py -q
```

- [ ] Run regression converter tests around current conversion types:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest tests/test_misa_profile_api.py tests/test_bae_purchase_import.py tests/test_misa_purchase_domestic.py tests/test_api.py tests/test_sheet_name_export.py -q
```

- [ ] Run all converter tests if focused suite passes:

```powershell
cd "E:\0. EXE2\ez-format\converter"
python -m pytest -q
```

- [ ] Run frontend build:

```powershell
cd "E:\0. EXE2\ez-format\frontend"
npm run build
```

- [ ] Run workspace fast QA if available:

```powershell
cd "E:\0. EXE2\ez-format"
npm run qa:fast
```

Manual QA:

- [ ] Start local stack.
- [ ] Open `http://localhost:5173/convert`.
- [ ] Confirm template dropdown shows all available templates before upload.
- [ ] Upload sales sample:
  - `E:\0. EXE2\Chi tiết bán hàng 05.12 - 25.12.xlsx`
- [ ] Analyze → Preview → Readiness report visible.
- [ ] Confirm no false blocker on known-good sales mapping.
- [ ] Download → output `.xls` still uses real MISA template.
- [ ] Upload purchase sample if available:
  - `C:\Users\Admin\Downloads\MUA_VAO_0317262773 (7).xlsx`
- [ ] Select `Mua hàng trong nước - MISA`.
- [ ] Analyze → Preview → Readiness report visible.
- [ ] Confirm purchase-specific warnings are review-only unless deterministic blocker.
- [ ] Create one test case with blank required field and verify download blocked.
- [ ] Create one test case with warning only and verify checkbox unlocks download.

QA artifact example:

```json
{
  "tested_at": "2026-07-06",
  "sales_sample": "passed",
  "purchase_sample": "passed",
  "blocker_gate": "passed",
  "warning_ack_gate": "passed",
  "frontend_build": "passed",
  "converter_tests": "passed",
  "notes": []
}
```

Commit suggestion:

```powershell
git add "E:\0. EXE2\ez-format\.artifacts\misa-readiness-qa\qa-summary.json"
git commit -m "test: verify MISA readiness flow"
```

## 10. Acceptance criteria

MVP passes when:

- [ ] `POST /api/v1/mappings/readiness` returns structured readiness report.
- [ ] Missing mapping/default/formula for MISA `(*)` fields is blocker.
- [ ] Blank value in MISA `(*)` field is blocker.
- [ ] Unparseable required date/number is blocker.
- [ ] Amount/VAT mismatch beyond tolerance is blocker.
- [ ] Duplicate conflicting document/invoice key is blocker.
- [ ] Master data/account/payment/VAT eligibility uncertainties are warnings, not blockers.
- [ ] Frontend displays readiness score, summary, issue table, and source links.
- [ ] Download disabled if blockers exist.
- [ ] Download disabled if warnings exist and user has not acknowledged.
- [ ] Backend export revalidates and returns 422 if frontend tries to bypass.
- [ ] Export file still preserves real MISA `.xls` template formatting.
- [ ] AI offline does not break readiness checks.
- [ ] Focused backend tests pass.
- [ ] Frontend build passes.

## 11. Explicit non-goals for this MVP

- [ ] No legal compliance certification.
- [ ] No automatic conclusion that VAT 8%/5% applies to a product.
- [ ] No full company master-data sync yet.
- [ ] No long-term storage of uploaded raw files.
- [ ] No AI-generated severity.
- [ ] No bulk job queue/progress worker.
- [ ] No Excel error report export yet.
- [ ] No changes to payment/admin plan flow.

## 12. Risks and mitigation

| Risk | Mitigation |
|---|---|
| False blockers block a valid import | Only blockers for deterministic errors; ambiguous items become warnings |
| Frontend bypass | Backend export revalidates |
| AI timeout | Readiness is deterministic and independent of AI |
| Performance regression on large files | Validate preview rows in-memory; avoid re-reading workbook unless needed; cap issue count per code if necessary |
| Confusing accounting claims | Use cautious copy and disclaimer |
| Template drift | Required fields always read from actual template headers |

## 13. Suggested implementation order

Recommended sequence:

```text
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7
```

Do not start frontend wiring before backend endpoint contract is stable.

## 14. Self-review notes before implementation

Before coding, agent should inspect exact current symbols:

- `converter/app/models.py`
- `converter/app/misa_workflow.py`
- `converter/app/main.py`
- `frontend/src/hooks/useConverterApi.js`
- `frontend/src/pages/ConvertPage.jsx`

Do not guess function signatures. Use current signatures and make the smallest compatible diff.

---

**Implementation readiness:** Plan is ready for coding. Preferred execution mode: `superpowers:subagent-driven-development`, because backend rules/API and frontend UI can be developed in controlled slices with review checkpoints.
