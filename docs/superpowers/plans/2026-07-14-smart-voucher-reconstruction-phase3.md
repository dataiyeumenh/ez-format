# Giai đoạn 3 - Tái tạo chứng từ thông minh

**Ngày lập kế hoạch:** 2026-07-14  
**Phạm vi:** EzFormat frontend + Node/MongoDB backend + FastAPI converter + AI Gateway optional  
**Mục tiêu:** Biến dữ liệu Excel dạng dòng, không đồng nhất thành các chứng từ kế toán có cấu trúc, có thể kiểm tra, sửa, phê duyệt và xuất vào đúng template MISA thật.

## 1. Tóm tắt điều hành

Giai đoạn 3 thêm một lớp miền nghiệp vụ nằm giữa bước đọc file thô và bước tạo dòng import MISA:

```text
Raw workbook
-> Structural analysis
-> Canonical voucher reconstruction
-> Master-data resolution
-> Human review
-> MISA template adapter
-> Readiness validation
-> Export real MISA template
```

Điểm khác biệt quan trọng so với mapping cột hiện tại:

- Mapping hiện tại trả lời: "Cột raw nào đi vào cột MISA nào?"
- Tái tạo chứng từ trả lời thêm:
  - Những dòng nào thuộc cùng một chứng từ?
  - Dòng nào là header, dòng chi tiết, ghi chú hoặc dòng tổng?
  - Đây là mua hàng hóa, mua dịch vụ, bán hàng hóa hay bán dịch vụ?
  - Giá trị nào lấy trực tiếp, điền xuống, suy ra bằng công thức, lấy từ danh mục hay do AI gợi ý?
  - Có dòng nào bị mất, nhân đôi, gộp nhầm hoặc xung đột không?

Mọi giá trị trên chứng từ phải có nguồn gốc truy vết được. AI không được tự tạo số tiền, số hóa đơn, ngày, mã tài khoản, mã hàng hoặc thay đổi mức độ lỗi.

## 2. Nền tảng hiện có được tái sử dụng

Giai đoạn 3 không xây lại các phần đã có:

- `AccountingWorkspace` và tenant isolation trong MongoDB.
- Snapshot danh mục MISA theo workspace.
- Alias đã được user xác nhận.
- Mapping profile theo workspace/source signature.
- Signed conversion context và kiểm tra revision/hash.
- Readiness report và export gate.
- Cơ chế copy/fill template `.xls` thật.
- AI Gateway optional; hệ thống vẫn hoạt động khi AI offline.
- Conversion history chỉ lưu metadata, không lưu raw workbook.

Điều kiện trước khi bắt đầu code:

1. Chốt và commit baseline Giai đoạn 1 trên một branch riêng.
2. Không triển khai Giai đoạn 3 đồng thời trong cùng working tree với workspace khác.
3. Giữ nguyên compatibility cho luồng mapping truyền thống.

## 3. Phạm vi sản phẩm

### 3.1 MVP bắt buộc

Hỗ trợ tái tạo bốn nhóm chứng từ đang nằm trong phạm vi EzFormat:

```text
purchase_goods
purchase_services
sales_goods
sales_services
```

Hỗ trợ:

- File có một hoặc nhiều sheet.
- Một chứng từ có nhiều dòng chi tiết.
- Các ô header chỉ xuất hiện ở dòng đầu rồi để trống ở các dòng sau.
- Dữ liệu lặp header trên mọi dòng.
- File chứa đồng thời nhiều chứng từ.
- File chứa đồng thời nhiều nhóm hàng hóa/dịch vụ.
- Tách file xuất theo template khi một upload chứa nhiều loại chứng từ.
- User sửa loại chứng từ, field, nhóm dòng, merge/split trước khi export.
- Ghi nhớ correction ở cấp cấu trúc/source profile, không ghi nhớ số tiền giao dịch.
- Hiển thị nguồn gốc và trạng thái tin cậy của từng field.
- Đối soát số dòng, số chứng từ, tổng tiền, VAT và tổng thanh toán.

### 3.2 Trường hợp phải nhận diện nhưng chưa tự xử lý hoàn toàn

Các trường hợp sau phải được phát hiện và đưa về `needs_review` hoặc `blocked`, không được im lặng xử lý như chứng từ thông thường:

- Hàng trả lại, giảm giá, điều chỉnh, thay thế hóa đơn.
- Chứng từ có nhiều loại tiền hoặc tỷ giá không nhất quán.
- Một hóa đơn có cả hàng hóa và dịch vụ nhưng template đích không thể hiện rõ cách nhập.
- Dòng âm, dòng giá bằng 0, khuyến mại hoặc ghi chú không rõ ngữ cảnh.
- Thiếu khóa đủ mạnh để xác định ranh giới chứng từ.
- Cùng khóa hóa đơn nhưng thông tin header hoặc tổng tiền xung đột.

### 3.3 Ngoài phạm vi MVP

- OCR/PDF/image invoice extraction.
- Tự động hạch toán trực tiếp vào MISA qua API/RPA.
- Tự kết luận VAT hoặc tài khoản nghiệp vụ đúng luật.
- Tự sinh mã master data mới trong MISA.
- Tự sửa số tiền, ngày hoặc số hóa đơn khi user chưa xác nhận.
- Lưu raw workbook lâu dài.
- Bank reconciliation, inventory costing hoặc general-ledger posting engine đầy đủ.

## 4. Nguyên tắc kế toán và MISA

Nguồn thiết kế nghiệp vụ:

- MISA AMIS Excel import: https://helpact.misa.vn/kb/html_10050000/
- MISA SME import Excel: https://helpsme.misa.vn/2026/kb/lam-the-nao-de-nhap-khau-cac-danh-muc-so-du-chung-tu-tu-file-excel-vao-phan-mem/
- Knowledge base nội bộ `ke-toan`, mục import/export và nhập liệu, được kiểm tra gần nhất ngày 2026-07-01.

Quy tắc an toàn:

1. Template MISA thật là source of truth cho field và cột bắt buộc `(*)`.
2. Chỉ dùng `blocker` cho lỗi xác định được bằng dữ liệu/template/công thức.
3. Phân loại nghiệp vụ, VAT eligibility và tài khoản bất thường là cảnh báo nếu chưa có rule xác định.
4. Mọi số tiền dùng `Decimal`, không dùng float.
5. Blank khác zero; không tự biến blank thành `0`.
6. Giữ leading zero của mã, MST, số chứng từ và số hóa đơn.
7. Không gộp dòng chỉ dựa trên tên đối tượng hoặc mô tả.
8. Không forward-fill cột số tiền, số lượng, đơn giá, VAT hoặc tổng tiền.
9. AI chỉ được gợi ý; AI không thay đổi severity, export gate hoặc số liệu.
10. UI không được tuyên bố "đúng chuẩn/đúng luật 100%".

## 5. Trải nghiệm người dùng

### 5.1 Luồng chính

```text
1. Chọn doanh nghiệp/workspace
2. Upload file raw
3. Hệ thống phân tích và tái tạo chứng từ
4. Xem tổng quan chứng từ đã tạo
5. Review chứng từ cần kiểm tra
6. Sửa/merge/split/phân loại nếu cần
7. Chạy readiness validation
8. Phê duyệt
9. Tải một file MISA hoặc gói ZIP nhiều template
```

### 5.2 Màn hình tổng quan tái tạo

Hiển thị:

```text
126 chứng từ được nhận diện
92 mua hàng hóa
28 mua dịch vụ
4 bán hàng hóa
2 cần xác định loại

118 sẵn sàng
6 cần kiểm tra
2 bị chặn
```

Bảng chứng từ:

| Cột | Nội dung |
|---|---|
| Trạng thái | Sẵn sàng / Cần kiểm tra / Bị chặn |
| Loại | Mua hàng hóa / Mua dịch vụ / Bán hàng hóa / Bán dịch vụ / Chưa xác định |
| Số hóa đơn | Giá trị tái tạo |
| Ngày | Ngày hóa đơn/chứng từ |
| Đối tượng | NCC/khách hàng |
| Số dòng | Số dòng chi tiết |
| Tiền hàng | Tổng trước VAT |
| VAT | Tổng VAT |
| Tổng thanh toán | Tổng chứng từ |
| Tin cậy | Verified / Supported / Suggested / Conflict |

### 5.3 Màn hình review chứng từ

Layout desktop:

```text
Danh sách chứng từ | Header + đối tượng + tổng tiền
                   | Dòng chi tiết
                   | Lỗi/cảnh báo
                   | Nguồn gốc từng field
```

User có thể:

- Sửa field header hoặc dòng chi tiết.
- Chọn mã từ danh mục MISA active.
- Đổi loại chứng từ.
- Tách một chứng từ thành hai nhóm dòng.
- Gộp hai draft nếu chúng thực sự là cùng chứng từ.
- Chọn dòng là ghi chú hoặc loại khỏi output.
- Áp dụng correction tương tự cho các chứng từ còn lại.
- Lưu cấu hình cho file/source tương tự.

### 5.4 Nguồn gốc field

Mỗi field có một badge:

```text
source_direct
source_fill_down
workspace_master_data
confirmed_alias
approved_profile
deterministic_derived
ai_suggestion
manual
```

Không dùng một con số confidence chung để tự động phê duyệt. Trạng thái chứng từ được quyết định bằng provenance + deterministic checks.

## 6. Kiến trúc kỹ thuật

### 6.1 Canonical voucher model

Không map trực tiếp raw row thành MISA row trong engine mới. Tạo mô hình trung gian độc lập template:

```text
Raw rows
-> CanonicalVoucherDraft
-> MisaTemplateAdapter
-> MISA output rows
```

Mô hình khái niệm:

```json
{
  "id": "stable-draft-id",
  "direction": "purchase",
  "nature": "goods",
  "document_kind": "invoice_purchase",
  "status": "needs_review",
  "header": {
    "invoice_number": { "value": "0000123", "provenance": {} },
    "invoice_symbol": { "value": "1C26TAA", "provenance": {} },
    "invoice_date": { "value": "2026-07-01", "provenance": {} },
    "posting_date": { "value": "2026-07-01", "provenance": {} },
    "counterparty_code": { "value": "NCC001", "provenance": {} },
    "counterparty_tax_code": { "value": "0317262773", "provenance": {} },
    "currency": { "value": "VND", "provenance": {} }
  },
  "lines": [],
  "totals": {
    "amount": "1000000",
    "vat": "80000",
    "payment": "1080000"
  },
  "source_rows": [12, 13, 14],
  "issues": [],
  "revision": 3
}
```

### 6.2 Pipeline

```text
Workbook reader
-> Structure detector
-> Row normalizer
-> Document boundary detector
-> Header/detail extractor
-> Goods/service classifier
-> Workspace master-data resolver
-> Deterministic calculation/reconciliation
-> AI suggestion (only unresolved cases)
-> Draft review state
-> Template adapter
-> Existing readiness/export engine
```

### 6.3 Sở hữu dữ liệu

Node/MongoDB:

- User/workspace authorization.
- Durable reconstruction run metadata.
- Audit event và quyết định review.
- Approved reconstruction profiles.
- Feature flags, quota và retention policy.

FastAPI converter:

- Raw workbook bytes trong thời gian ngắn.
- Parsed table cache.
- Canonical draft state có TTL.
- Reconstruction algorithms.
- Template adaptation, readiness và export.

Frontend:

- Hiển thị state do backend trả về.
- Gửi explicit edit operations.
- Không tự group/classify hoặc quyết định export gate.

`reconstruction_store` phải có adapter rõ ràng:

```text
local development: filesystem TTL store
production: Redis-compatible TTL store over TLS
```

Production không được phụ thuộc vào filesystem tạm của Render để giữ một phiên review dài. Nếu Redis chưa cấu hình, feature phải chạy ở chế độ single-session/non-resumable có cảnh báo rõ hoặc giữ flag production ở trạng thái tắt.

## 7. Thuật toán tái tạo

### 7.1 Structural analysis

Phân tích từng sheet:

- Header row, data start/end.
- Title/metadata rows phía trên header.
- Hidden rows/columns.
- Merged cells.
- Formula cells và cached values.
- Blank separator rows.
- Dòng subtotal/grand total.
- Dòng ghi chú.

Kết quả phải giữ `source_sheet`, `source_row`, `source_column` cho mọi giá trị.

### 7.2 Fill-down an toàn

Chỉ fill-down các field được xác định là header/document-level, ví dụ:

- Số hóa đơn.
- Ký hiệu hóa đơn.
- Ngày hóa đơn/chứng từ.
- MST/tên nhà cung cấp hoặc khách hàng.
- Số chứng từ nội bộ nếu có.

Không fill-down:

- Mã hàng/tên hàng.
- Số lượng/đơn giá/thành tiền.
- Thuế suất/tiền VAT nếu dữ liệu có thể theo từng dòng.
- Chiết khấu và tổng thanh toán.

Mỗi fill-down phải lưu row nguồn và phạm vi áp dụng.

### 7.3 Document boundary detection

Ưu tiên khóa mạnh:

```text
counterparty_tax_code
+ invoice_symbol
+ invoice_number
+ invoice_date
```

Hoặc số chứng từ nội bộ rõ ràng nếu nguồn cung cấp.

Fallback chỉ tạo candidate group, không auto-ready:

```text
counterparty + date + stated_total
```

Các invariant:

- Mỗi source detail row thuộc tối đa một draft.
- Không source row nào biến mất nếu chưa được đánh dấu ignored với lý do.
- Thứ tự dòng trong chứng từ ổn định.
- Cùng input/profile/workspace revision phải tạo cùng draft IDs và thứ tự.
- Cùng strong key nhưng header/tổng xung đột là blocker, không tự merge.

### 7.4 Header/detail reconstruction

Header fields được lấy theo thứ tự:

```text
direct consistent value
-> safe fill-down
-> confirmed profile/default
-> workspace master data/alias
-> deterministic derivation
-> AI suggestion
-> missing
```

Nếu nhiều direct values khác nhau trong cùng draft:

- Trường quan trọng như số hóa đơn, ngày, MST, tiền tổng: blocker.
- Trường mô tả optional: warning và yêu cầu chọn một giá trị.

### 7.5 Goods/service classification

Tín hiệu mạnh:

- Cột raw thể hiện rõ loại hàng hóa/dịch vụ.
- Item code khớp active item catalog có thuộc tính loại.
- Approved source profile đã được user xác nhận.

Tín hiệu hỗ trợ:

- Có mã kho, số lượng, đơn vị tính, dòng nhập/xuất kho.
- Tên/mô tả hoặc category trong master data.
- Template/source system đã biết.

Chính sách:

- Tín hiệu mạnh nhất quán: có thể `verified`/`supported`.
- Chỉ có tín hiệu hỗ trợ: `suggested`, user review.
- Các line trong cùng chứng từ cho kết quả khác nhau: `mixed`, không ép theo majority.
- AI chỉ được giải thích và đề xuất `goods|service|mixed|unknown`.

### 7.6 Purchase/sales direction detection

Ưu tiên workspace tax code thay vì đoán từ tên cột:

```text
workspace tax code == buyer tax code  -> purchase candidate
workspace tax code == seller tax code -> sales candidate
```

Chính sách:

- Exact normalized tax-code match và vai trò seller/buyer rõ: `verified`.
- Source có cột direction/type rõ và approved profile khớp: `supported`.
- Không có workspace tax code hoặc thiếu buyer/seller tax code: `suggested`, cần review.
- Workspace tax code đồng thời khớp cả hai phía, hoặc direction signals xung đột: `conflict`.
- Không dùng tên công ty gần giống để auto-confirm direction.

### 7.7 Amount reconstruction

Tính bằng `Decimal`:

```text
line_amount = quantity * unit_price - line_discount
document_subtotal = sum(line_amount)
document_vat = accepted line-level or invoice-level rounding
document_payment = subtotal + vat - document_discount + known_fees
```

Không tự sửa actual values. Engine chỉ trả:

- actual.
- expected.
- delta.
- source rows.
- cách xử lý.

### 7.8 Duplicate và row conservation

Kiểm tra:

- Strong duplicate key trong cùng upload.
- Cùng key nhưng khác amount/details.
- Cùng row fingerprint xuất hiện nhiều lần.
- Số row input = assigned rows + ignored rows + unresolved rows.
- Tổng tiền input và canonical totals có reconciliation rõ ràng.

## 8. Trust và export policy

### 8.1 Field trust

```text
verified   direct exact, confirmed alias hoặc master-data exact match
supported  approved profile hoặc deterministic derivation
suggested  fuzzy/name/AI/business inference
missing    chưa có giá trị
conflict   nhiều giá trị không nhất quán
```

### 8.2 Draft status

`ready` khi:

- Không blocker.
- Mọi required field là `verified` hoặc `supported`.
- Document boundary không mơ hồ.
- Type không phải `mixed|unknown`.
- Row conservation và amount reconciliation pass.

`needs_review` khi:

- Có warning/suggested field.
- Có fallback grouping.
- Classification cần nghiệp vụ user xác nhận.

`blocked` khi:

- Thiếu required value.
- Header conflict.
- Duplicate strong key conflict.
- Amount/VAT/total mismatch vượt tolerance.
- Source row bị gán vào nhiều draft.
- Template adapter không thể tạo output hợp lệ.

### 8.3 Export

- `blocked > 0`: không export.
- `needs_review > 0`: user phải review/acknowledge theo từng draft hoặc bulk rule rõ ràng.
- Một loại chứng từ: trả `.xls`.
- Nhiều template: trả `.zip` chứa từng `.xls` và `manifest.json`/`manifest.csv`.
- Backend revalidate toàn bộ ngay trước export.

## 9. AI optional

### 9.1 AI được phép làm

- Gợi ý header/detail role cho cột khó hiểu.
- Gợi ý khóa grouping khi heuristic không đủ.
- Gợi ý goods/service/mixed từ tên cột và sample đã giới hạn.
- Giải thích warning bằng tiếng Việt.
- Chọn profile/scenario gần nhất.

### 9.2 AI bị cấm

- Tạo hoặc sửa amount, VAT, date, invoice number.
- Tự chọn account code nếu không có exact master-data/profile rule.
- Tự phê duyệt draft.
- Đổi blocker thành warning.
- Bỏ qua stale workspace context.
- Nhận toàn bộ workbook nếu không cần thiết.

### 9.3 Payload và hiệu năng

- Gọi AI tối đa một lần cho một source signature trong analyze thông thường.
- Chỉ gửi header, type hints, redacted samples và nearby approved profiles.
- Không gửi toàn bộ file hoặc hàng nghìn dòng.
- JSON schema bắt buộc; reject response sai schema.
- Timeout/failure phải fallback về manual review.
- Cache theo `source_signature + profile_version + model_prompt_version`.

## 10. Data model MongoDB

### 10.1 `VoucherReconstructionRun`

```text
id
user
workspace
conversionRun
fileName
fileSizeBytes
sourceFileHash
sourceSignatureHash
status: created|analyzing|review_required|approved|exported|failed|expired
engineVersion
profileId/profileVersion
workspaceRevision
snapshotSetHash
inputSheetCount/inputRowCount
draftCount
readyCount/reviewCount/blockedCount
classificationSummary
reconciliationSummary
expiresAt
approvedBy/approvedAt
exportedAt
errorCode/errorMessage
createdAt/updatedAt
```

Không lưu raw workbook hoặc toàn bộ transaction rows trong model này.

### 10.2 `ReconstructionProfile`

```text
id
workspace
name
sourceSignatureHash
compatibleHeaderFingerprint
directionScope
status: draft|approved|active|deprecated
version
headerDetection
groupingKeys
fillDownFields
fieldRoles
mapping/defaults/formulas
classificationRules
templateRouting
createdBy/approvedBy
usageCount/successCount/reviewRate
createdAt/updatedAt
```

Chỉ profile `active` và đúng workspace mới được auto-apply. Similar profile chỉ là suggestion.

### 10.3 `ReconstructionDecision`

Lưu audit/correction ở dạng cấu trúc:

```text
run
draftStableId
draftRevision
operationType
fieldPath
beforeHash/afterHash
structuralRule
sourceRows
actor
createdAt
```

Không lưu số tiền hoặc nội dung nhạy cảm vào log text. Correction có thể chuyển thành profile rule chỉ sau khi user chọn "Lưu cho file tương tự".

## 11. API contract

### 11.1 Node backend

#### `POST /api/reconstructions`

Khởi tạo run, kiểm tra auth/quota/workspace và trả signed context:

```json
{
  "workspace_id": "...",
  "file_name": "MUA_VAO.xlsx",
  "file_size_bytes": 123456,
  "mode": "auto"
}
```

Response:

```json
{
  "run_id": "...",
  "context_token": "...",
  "expires_at": "..."
}
```

Token phải chứa `purpose=misa_reconstruction`, `run_id`, `user_id`, workspace/snapshot claims và allowed scopes.

#### `GET /api/reconstructions/:id`

Trả durable metadata/summary, tenant isolated.

#### `GET /api/reconstructions`

Lịch sử run của user/workspace; admin endpoint hiện tại có thể dùng metadata từ `ConversionRun`.

#### `POST /api/reconstructions/:id/profiles`

Tạo profile draft từ correction đã được user chọn lưu.

#### Internal event endpoint

```text
POST /api/internal/reconstructions/:id/events
Authorization: Bearer CONVERTER_SERVICE_TOKEN
```

Converter cập nhật lifecycle/audit summary; frontend không được tự khai báo run đã approved/exported.

### 11.2 FastAPI converter

#### `POST /api/v1/reconstructions/analyze`

Multipart:

```text
file
context_token
mode=auto|purchase|sales
target_template_id optional
```

Response gồm:

- `reconstruction_id`.
- workbook/source analysis.
- draft summaries.
- classification summary.
- row conservation.
- issues.
- applied profile/AI state.

#### `GET /api/v1/reconstructions/{id}`

Trả report/drafts theo pagination; không trả toàn bộ rows nếu file lớn.

#### `GET /api/v1/reconstructions/{id}/drafts/{draft_id}`

Trả chi tiết một canonical draft cùng provenance.

#### `PATCH /api/v1/reconstructions/{id}/drafts/{draft_id}`

Body là operation list:

```json
{
  "expected_revision": 4,
  "operations": [
    { "op": "set_field", "path": "header.invoice_date", "value": "2026-07-01" },
    { "op": "set_type", "value": "purchase_services" }
  ]
}
```

Stale revision trả `409`, không silently overwrite.

#### `POST /api/v1/reconstructions/{id}/split`

Tách selected source rows thành draft mới.

#### `POST /api/v1/reconstructions/{id}/merge`

Merge draft chỉ sau khi backend kiểm tra header/duplicate conflicts.

#### `POST /api/v1/reconstructions/{id}/validate`

Chạy reconstruction invariants + existing MISA readiness.

#### `POST /api/v1/reconstructions/{id}/approve`

Yêu cầu latest revision, không blocker và acknowledgement hợp lệ.

#### `POST /api/v1/reconstructions/{id}/export`

Revalidate rồi stream `.xls` hoặc `.zip`. Dùng idempotency key để chống double export.

## 12. File plan

### 12.1 Node backend - create

- `backend/models/VoucherReconstructionRun.js`
- `backend/models/ReconstructionProfile.js`
- `backend/models/ReconstructionDecision.js`
- `backend/controllers/reconstructionController.js`
- `backend/routes/reconstructions.js`
- `backend/services/reconstructionRunService.js`
- `backend/services/reconstructionProfileService.js`
- `backend/tests/reconstructionRuns.test.js`
- `backend/tests/reconstructionProfiles.test.js`
- `backend/tests/reconstructionInternalEvents.test.js`

### 12.2 Node backend - modify

- `backend/server.js`
- `backend/models/ConversionRun.js`
- `backend/services/conversionContextService.js`
- `backend/routes/internal.js`
- `backend/controllers/conversionRunController.js`
- `backend/.env.example`

### 12.3 Converter - create

- `converter/app/voucher_models.py`
- `converter/app/voucher_reconstruction.py`
- `converter/app/document_structure.py`
- `converter/app/document_grouping.py`
- `converter/app/document_classification.py`
- `converter/app/field_provenance.py`
- `converter/app/reconstruction_profiles.py`
- `converter/app/reconstruction_store.py`
- `converter/app/misa_voucher_adapters.py`
- `converter/tests/test_document_structure.py`
- `converter/tests/test_document_grouping.py`
- `converter/tests/test_document_classification.py`
- `converter/tests/test_voucher_reconstruction.py`
- `converter/tests/test_reconstruction_api.py`
- `converter/tests/test_reconstruction_profiles.py`
- `converter/tests/test_reconstruction_export.py`

### 12.4 Converter - modify

- `converter/app/main.py`
- `converter/app/models.py`
- `converter/app/misa_workflow.py`
- `converter/app/misa_readiness.py`
- `converter/app/master_data_resolver.py`
- `converter/app/ai_gateway.py`
- `converter/.env.example`

### 12.5 Frontend - create

- `frontend/src/hooks/useVoucherReconstruction.js`
- `frontend/src/components/reconstruction/ReconstructionSummary.jsx`
- `frontend/src/components/reconstruction/VoucherList.jsx`
- `frontend/src/components/reconstruction/VoucherReviewWorkspace.jsx`
- `frontend/src/components/reconstruction/VoucherHeaderEditor.jsx`
- `frontend/src/components/reconstruction/VoucherLineEditor.jsx`
- `frontend/src/components/reconstruction/FieldProvenanceBadge.jsx`
- `frontend/src/components/reconstruction/SplitVoucherDialog.jsx`
- `frontend/src/components/reconstruction/MergeVoucherDialog.jsx`
- `frontend/src/components/reconstruction/ReconstructionIssuePanel.jsx`
- `frontend/src/components/reconstruction/ExportPackagePanel.jsx`
- `frontend/src/utils/reconstruction.js`
- `frontend/src/utils/reconstruction.test.mjs`

### 12.6 Frontend - modify

- `frontend/src/pages/ConvertPage.jsx`
- `frontend/src/hooks/useConverterApi.js`
- `frontend/src/components/PreviewTable.jsx`
- `frontend/.env.example`

## 13. Implementation tasks

### Task 0 - Baseline và feature flags

- [ ] Commit/checkpoint Giai đoạn 1 trước khi code Phase 3.
- [ ] Tạo branch/worktree riêng cho Phase 3.
- [ ] Thêm flags:
  - `VOUCHER_RECONSTRUCTION_ENABLED=false`
  - `VITE_VOUCHER_RECONSTRUCTION_ENABLED=false`
  - `RECONSTRUCTION_AI_ENABLED=false`
  - `RECONSTRUCTION_STORE_TTL_HOURS=24`
  - `RECONSTRUCTION_STORE_PROVIDER=filesystem`
- [ ] Khi flag tắt, luồng mapping hiện tại không thay đổi.

### Task 1 - Canonical models và invariants

- [ ] Viết test RED cho Pydantic models và stable IDs.
- [ ] Implement `CanonicalVoucherDraft`, field provenance, source refs và issues.
- [ ] Implement row conservation invariant.
- [ ] Implement deterministic serialization/hash.
- [ ] Test blank/zero, leading zero, Decimal và date normalization.
- [ ] Nếu hỗ trợ formula/default rule, chỉ dùng safe DSL allowlist; không dùng `eval` hoặc arbitrary Python/JavaScript.

### Task 2 - Structural analyzer

- [ ] Test title/header/data detection cho `.xls/.xlsx`.
- [ ] Test merged cells, hidden rows, formula cells, blank separator và total rows.
- [ ] Implement safe fill-down policy.
- [ ] Không forward-fill line/amount fields.
- [ ] Trả source references cho mọi normalized cell.

### Task 3 - Grouping engine

- [ ] Test strong invoice/document keys.
- [ ] Test repeated headers và blank headers.
- [ ] Test same key/header conflict.
- [ ] Test fallback grouping luôn cần review.
- [ ] Test no row loss/no duplicate assignment.
- [ ] Implement stable draft ordering và stable IDs.

### Task 4 - Direction và goods/service classifier

- [ ] Test purchase/sales direction bằng exact workspace tax-code role match.
- [ ] Test thiếu hoặc xung đột buyer/seller tax code phải review/block phù hợp.
- [ ] Test direct type columns.
- [ ] Test item master-data attributes.
- [ ] Test approved profile signals.
- [ ] Test support signals không được auto-approve.
- [ ] Test mixed invoice không bị ép theo majority.
- [ ] Integrate AI suggestion only for unresolved classification.

### Task 5 - Reconstruction engine và reconciliation

- [ ] Build header/detail extraction.
- [ ] Resolve customer/supplier/item/account/warehouse/unit từ Phase 1.
- [ ] Reuse alias precedence và stale context protection.
- [ ] Implement amount/VAT/payment reconciliation bằng Decimal.
- [ ] Add duplicate and conflict issues.
- [ ] Produce draft-level và run-level readiness summary.

### Task 6 - MongoDB run/profile/audit

- [ ] TDD Mongoose schemas/indexes/TTL.
- [ ] Implement tenant isolation và owner/editor/reviewer permissions.
- [ ] Extend context token với purpose/scope/run ID.
- [ ] Implement internal converter event endpoint.
- [ ] Không nhận lifecycle state trực tiếp từ frontend.
- [ ] Add optimistic concurrency và idempotency.
- [ ] Tích hợp quota/file credits theo nguyên tắc charge đúng một lần khi export đầu tiên thành công.
- [ ] Analyze/review thất bại và re-download cùng run không được trừ thêm lượt.

### Task 7 - Converter reconstruction API

- [ ] Implement analyze/get/patch/split/merge/validate/approve/export endpoints.
- [ ] Verify context scope ở mọi endpoint.
- [ ] Reject stale workspace revision/snapshot/profile revision.
- [ ] Paginate large draft lists.
- [ ] Implement store interface với filesystem adapter cho local và Redis-compatible adapter cho production.
- [ ] Store ephemeral draft state với TTL cleanup; không log payload.
- [ ] Ensure restart/expiry trả lỗi rõ, không trả generic 500.

### Task 8 - MISA template adapters

- [ ] Adapter từ canonical voucher sang bốn template MVP.
- [ ] Mỗi adapter đọc required fields từ template thật.
- [ ] Không tạo workbook mới.
- [ ] Preserve merged cells, styles, widths, row heights và number formats.
- [ ] Split mixed upload thành output files theo template.
- [ ] Generate manifest với count/totals/issues đã acknowledged.

### Task 9 - Review UI

- [ ] Thêm mode "Tái tạo chứng từ" cạnh luồng mapping truyền thống.
- [ ] Build summary/list/detail layout responsive.
- [ ] Add keyboard navigation và accessible labels.
- [ ] Add provenance badges và source row links.
- [ ] Add field editing, catalog search, split, merge và reclassify.
- [ ] Add unsaved/stale revision handling.
- [ ] Disable approve/export đúng theo backend report.

### Task 10 - Correction learning

- [ ] Cho user chọn "Lưu cách xử lý cho file tương tự".
- [ ] Tạo profile draft từ structural correction, không từ transaction values.
- [ ] Owner/reviewer phê duyệt profile trước khi active.
- [ ] Version profile; không mutate active version tại chỗ.
- [ ] Re-analyze cùng source schema và chứng minh profile được reuse.

### Task 11 - AI Gateway integration

- [ ] Define strict reconstruction JSON schema.
- [ ] Build redacted, bounded payload.
- [ ] Add one-call-per-signature policy và cache.
- [ ] Reject invalid schema/unknown fields.
- [ ] Test timeout, unauthorized, malformed JSON và offline fallback.
- [ ] Log request ID/model latency, không log transaction payload.

### Task 12 - Security, performance và observability

- [ ] Validate file magic, extension, size, sheet/row/cell limits.
- [ ] Reject macro/external-link behavior không hỗ trợ.
- [ ] Sanitize formula-like text khi field không cho phép formula.
- [ ] Rate-limit run creation/analyze/export.
- [ ] Add metrics: analyze latency, AI latency, review rate, blocker rate, profile reuse, export success.
- [ ] Add structured error codes và correlation ID qua Node/converter/AI.
- [ ] Verify raw bytes và draft state được cleanup theo TTL.
- [ ] Verify Redis transport dùng TLS/auth ở production và key namespace theo environment.

### Task 13 - Rollout

- [ ] Shadow mode: chạy reconstruction nhưng vẫn dùng output mapping cũ.
- [ ] So sánh voucher count, row conservation và totals.
- [ ] Beta cho workspace được allowlist.
- [ ] Chỉ bật export mới sau khi golden files pass.
- [ ] Có kill switch độc lập cho reconstruction và AI.
- [ ] Document rollback không xóa profile/run data.

## 14. Test strategy

### 14.1 Unit tests

Bao phủ tối thiểu:

- 100 purchase scenarios đã có, chuyển thành reconstruction fixtures.
- 40 sales variants bổ sung.
- Repeated/blank header values.
- Multi-sheet and mixed-type files.
- One invoice/many lines.
- Same invoice key/conflicting totals.
- Goods/service/mixed/unknown classification.
- Leading zeros, VN/EN numbers, Excel dates.
- Discount/VAT/rounding variants.
- Negative/zero/promotion rows.
- Hidden/formula/merged rows.
- Stable IDs và deterministic output.

### 14.2 Property/invariant tests

```text
assigned_rows + ignored_rows + unresolved_rows == source_data_rows
one_source_row belongs to at most one draft
same input/profile/context -> same grouping/order/hash
sum(canonical line amounts) reconciles to documented totals or creates issue
no blocker can be removed by AI response
export always revalidates latest draft revision
```

### 14.3 API/integration tests

- User A không đọc/sửa/export run của user B.
- Viewer không edit; reviewer có thể approve; owner/editor có thể sửa.
- Stale context/profile/draft revision trả `409`/`422` rõ ràng.
- Duplicate approve/export request idempotent.
- Credit được trừ đúng một lần khi first export thành công; retry/re-download không trừ thêm.
- Converter event endpoint yêu cầu service token.
- AI offline không làm analyze crash.
- Converter restart/TTL expiry có UX lỗi rõ.
- Mongo profile được reuse sau converter restart.

### 14.4 Golden-file tests

Mỗi template MVP có:

- Raw fixture.
- Expected canonical JSON.
- Expected MISA `.xls`.
- Header, merged range, widths, styles và number format assertions.
- 20 dòng đầu và aggregate totals comparison.

Bao gồm file thật đã dùng trong dự án và file mua vào của đối tác, nhưng fixture commit phải được ẩn danh trước.

### 14.5 Browser QA

- Desktop 1366x768 và 1920x1080.
- Mobile 390x844.
- Keyboard-only review.
- Screen reader labels cơ bản.
- Large list virtualization/pagination.
- Edit -> stale conflict -> reload/resolve.
- Split/merge/reclassify/approve/export.
- AI online/offline.
- One template download và multi-template ZIP.

### 14.6 Performance targets

Mục tiêu ban đầu, đo lại bằng benchmark thực tế:

- 10.000 rows, không AI: analyze p95 <= 15 giây trên converter production target.
- UI mở summary đầu tiên <= 2 giây sau khi analyze hoàn thành.
- Mở một draft <= 500 ms sau khi đã cache.
- AI chỉ thêm một remote round-trip cho source signature chưa biết.
- Export không parse lại raw workbook từ đầu nếu draft cache còn hợp lệ.

Nếu không đạt, ưu tiên:

1. Parse workbook một lần.
2. Batch master-data resolution.
3. Pagination/virtualization.
4. Cache source/profile analysis.
5. Chỉ gọi AI cho unresolved schema, không gọi per row/per voucher.

## 15. Deployment configuration

Node/Render:

```env
VOUCHER_RECONSTRUCTION_ENABLED=false
RECONSTRUCTION_CONTEXT_SECRET=<secret>
RECONSTRUCTION_RUN_RETENTION_DAYS=90
CONVERTER_SERVICE_TOKEN=<shared-secret>
CONVERTER_INTERNAL_URL=<converter-url>
```

Converter/Render:

```env
VOUCHER_RECONSTRUCTION_ENABLED=false
RECONSTRUCTION_CONTEXT_SECRET=<same-secret>
RECONSTRUCTION_STORE_PROVIDER=redis
RECONSTRUCTION_REDIS_URL=<tls-redis-url>
RECONSTRUCTION_STORE_TTL_HOURS=24
RECONSTRUCTION_MAX_ROWS=50000
RECONSTRUCTION_MAX_DRAFTS=10000
RECONSTRUCTION_AI_ENABLED=false
NODE_INTERNAL_API_URL=<node-backend-url>
CONVERTER_SERVICE_TOKEN=<shared-secret>
```

Frontend/Vercel:

```env
VITE_VOUCHER_RECONSTRUCTION_ENABLED=false
```

Không đặt shared secrets trên Vercel/frontend.

## 16. Acceptance criteria

Giai đoạn 3 chỉ được xem là hoàn thành khi:

- [ ] File raw nhiều dòng được tái tạo thành đúng số chứng từ theo golden fixtures.
- [ ] Không mất hoặc nhân đôi source detail row.
- [ ] Phân loại bốn loại MVP có provenance và trạng thái review rõ.
- [ ] Mixed/unknown không bị auto-approve.
- [ ] User có thể sửa, split, merge, reclassify và lưu profile.
- [ ] Re-upload schema tương tự reuse approved profile.
- [ ] Master data/alias Phase 1 vẫn tenant isolated và stale-safe.
- [ ] AI offline vẫn review/export thủ công được.
- [ ] AI không thể đổi blocker, số tiền hoặc export gate.
- [ ] Export dùng template thật và giữ formatting.
- [ ] Một loại trả `.xls`; nhiều loại trả `.zip` hợp lệ.
- [ ] Backend revalidates latest revision trước export.
- [ ] Quota/file credits chỉ bị trừ một lần khi first export thành công.
- [ ] Không raw workbook hoặc transaction values nhạy cảm trong Mongo/log.
- [ ] Production draft store chịu được converter restart trong TTL đã cấu hình.
- [ ] Backend, converter, frontend, integration, security và E2E suites pass.
- [ ] Shadow/beta metrics đạt ngưỡng đã chốt trước khi bật production.

## 17. Definition of Done cho từng task

Một task chỉ được đóng khi:

1. Có test RED trước implementation đối với logic mới.
2. Test focused pass.
3. Test liên quan cũ không regression.
4. API/schema/error codes được document.
5. Không log secret/raw transaction data.
6. `git diff --check` pass.
7. Lint/format/build pass cho stack liên quan.
8. Có evidence path trong `docs/qa/`.

## 18. Thứ tự triển khai khuyến nghị

```text
Milestone 3A - Canonical engine
Tasks 0-5

Milestone 3B - Durable workflow/API
Tasks 6-7

Milestone 3C - Template export + review UI
Tasks 8-9

Milestone 3D - Learning + AI optional
Tasks 10-11

Milestone 3E - Hardening + rollout
Tasks 12-13
```

Không bắt đầu UI phức tạp trước khi canonical model, grouping invariants và API contract ổn định.

## 19. Rủi ro chính và biện pháp

| Rủi ro | Hậu quả | Biện pháp |
|---|---|---|
| Gộp nhầm dòng | Sai chứng từ nghiêm trọng | Strong keys, conflict blocker, row provenance, split/merge review |
| AI bịa dữ liệu | Sai kế toán | Bounded schema, field allowlist, no numeric mutation, backend validation |
| Profile cũ áp dụng sai schema | Mapping/grouping sai | Versioned profile, exact signature auto-use, compatible signature suggestion only |
| File lớn chậm | UX 5 phút như production cũ | Parse once, batch lookup, one AI call/signature, pagination, benchmarks |
| Converter restart mất draft | User mất phiên review | TTL store abstraction; production adapter có thể dùng Redis/object storage nếu Render filesystem không đủ ổn định |
| Lưu dữ liệu nhạy cảm | Rủi ro bảo mật | Raw file ephemeral, metadata-only Mongo, hashed audit, no payload logs |
| Hai workspace cùng sửa repo | Ghi đè code | Separate Git worktrees/branches và ports/databases riêng |
| Feature mới làm hỏng flow cũ | Production regression | Feature flag, shadow mode, adapter boundary, rollback switch |

## 20. Quyết định kiến trúc chốt

- Canonical voucher model là source of truth của Phase 3.
- MongoDB lưu run/profile/audit metadata; không lưu raw workbook.
- Redis-compatible TTL store giữ draft tạm ở production; filesystem chỉ dành cho local/non-resumable mode.
- FastAPI thực hiện reconstruction và export.
- Node backend sở hữu auth, tenant, quota và durable lifecycle.
- Frontend không tự quyết định grouping/classification/readiness.
- AI optional và chỉ xử lý unresolved structural/business hints.
- Auto-ready dựa trên evidence/invariants, không dựa trên một ngưỡng confidence AI như `0.85`.
- Luồng mapping hiện tại tiếp tục tồn tại làm fallback và rollback path.
