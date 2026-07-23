# Converter Usability Controls Design

**Date:** 2026-07-16  
**Scope:** Frontend converter UX only  
**Status:** Approved design, pending implementation

## Goal

Giảm tải thao tác sau preview, cung cấp tổng quan đầy đủ cho toàn bộ cột template và làm rõ hành vi của CTA trước khi người dùng tải file MISA.

Thiết kế phải giữ nguyên các nguyên tắc an toàn hiện tại:

- Backend vẫn là nơi quyết định blocker/warning và luôn revalidate khi export.
- Người dùng không thể tải khi còn blocker.
- Warning chỉ cho tải sau khi người dùng xác nhận.
- Frontend không diễn giải `confidence` thành đảm bảo đúng nghiệp vụ.

## Accounting And MISA Source Basis

Thiết kế UX này không tạo thêm rule pháp lý hoặc tự kết luận nghiệp vụ. Các nguyên tắc MISA được dùng làm nền tảng:

- Template import thật là source of truth; cột có `(*)` được xem là bắt buộc theo template đang chọn.
- Người dùng phải có khả năng rà soát/sửa mapping trước khi export.
- Lỗi deterministic phải chỉ rõ dòng, cột, giá trị hiện tại và cách sửa; cảnh báo nghiệp vụ không được tự nâng thành blocker.
- Preview phải dùng header MISA thật và export vẫn điền vào template thật.

Official references, checked reachable on 2026-07-16:

- MISA AMIS Excel import: https://helpact.misa.vn/kb/html_10050000/
- MISA AMIS invalid import troubleshooting: https://helpact.misa.vn/kb/lam-the-nao-khi-nhap-khau-danh-muc-so-du-chung-tu-tu-excel-vao-phan-mem-bao-loi/
- MISA AMIS column mapping visibility: https://helpact.misa.vn/kb/huong-dan-an-hien-thong-tin-khi-thuc-hien-ghep-cac-cot-tu-lieu-tu-file-excel-vao-phan-mem/
- MISA SME 2026 Excel import: https://helpsme.misa.vn/2026/kb/lam-the-nao-de-nhap-khau-cac-danh-muc-so-du-chung-tu-tu-file-excel-vao-phan-mem/

## Current Problems

### Unbounded master-data resolution list

`MasterDataResolutionTable` render toàn bộ `masterData.resolutions`. Với file thực tế, danh sách mã khách hàng, hàng hóa, tài khoản và kho làm trang sau preview cao khoảng 58.347 px.

### Incomplete mapping summary

Trang chỉ tóm tắt các trường nằm trong `KEY_PREVIEW_HEADERS`. Người dùng không biết trạng thái của toàn bộ 59 cột template và không phát hiện được field đồng thời có source/default/formula.

### Ambiguous download CTA

Khi readiness chưa chạy, nút vẫn mang nhãn `Tải file kết quả`. Thực tế click này có thể chạy preview và readiness trước, tạo khoảng chờ dài trước khi người dùng được yêu cầu xác nhận warning.

## Selected Approach

Triển khai giải pháp không thêm dependency:

1. Master-data resolution card có summary, collapse, filter, search và pagination.
2. Mapping summary tính toàn bộ target headers, phát hiện mode và conflict.
3. Mapping table có filter theo mode.
4. Validation issue table có filter/search/pagination để không render hàng trăm dòng cùng lúc.
5. CTA sử dụng state rõ ràng cho validation và export.

Virtualization bằng thư viện bên ngoài chưa cần thiết cho MVP vì pagination và vùng scroll giới hạn đã đủ để chặn page-height explosion.

## Architecture

### Pure converter UX helpers

Tạo module thuần JavaScript để giữ logic có thể test độc lập:

```text
frontend/src/utils/converterUx.js
```

Module cung cấp:

- `classifyMappingField(target, targetMapping, defaults, formulas)`
- `summarizeMappingFields(targetHeaders, targetMapping, defaults, formulas)`
- `filterMappingHeaders(targetHeaders, summaryByTarget, activeFilter)`
- `getDownloadCtaState(context)`

Các helper không phụ thuộc React hoặc DOM.

### Mapping mode rules

Mỗi target field được phân loại theo các giá trị hiện có:

```text
raw only       -> mapped
default only   -> default
formula only   -> formula
none           -> unmapped
more than one  -> mixed
```

Backend hiện xử lý theo thứ tự deterministic:

```text
1. Khởi tạo bằng default.
2. Source mapping có giá trị sẽ ghi đè default.
3. Source mapping rỗng giữ lại default.
4. Formula chạy cuối và ghi đè giá trị trước đó.
```

Frontend phải giải thích đúng thứ tự này nhưng không được ngầm xem cấu hình nhiều mode là an toàn. `mixed` được hiển thị bằng nhãn người dùng `Nhiều cách điền · Cần rà soát` vì kết quả có thể thay đổi theo việc source cell rỗng hay có dữ liệu.

`mixed` là warning/review state ở frontend, không tự trở thành blocker. Blocker vẫn chỉ đến từ readiness/backend khi có lỗi deterministic như thiếu cột `(*)`, giá trị bắt buộc rỗng hoặc dữ liệu không parse được.

Trường có `(*)` được đánh dấu `required` độc lập với mode.

### Master-data resolution state

`MasterDataResolutionTable` quản lý UI state cục bộ:

- `expanded`
- `statusFilter`
- `query`
- `page`

Page size cố định là 20.

Summary statuses:

- `action_required`: `missing`, `conflict`, `suggested`
- `not_checked`
- `verified`

Default behavior:

- Card luôn hiển thị summary.
- Danh sách mặc định thu gọn.
- Nếu có required item ở trạng thái `missing` hoặc `conflict`, card tự mở và chọn filter `action_required`.
- Nếu toàn bộ item là `not_checked`, card giữ trạng thái thu gọn để không che phần mapping/preview.
- Trường hợp chưa có snapshot doanh nghiệp phải luôn hiện summary warning và CTA `Chọn/Tạo hồ sơ doanh nghiệp`; `not_checked` không được trình bày như `verified`.

Search áp dụng trên:

- `raw_value`
- `field`
- catalog label/type
- candidate code/name
- resolved target code

Sau filter/search, đổi page về 0.

### Mapping summary UI

Thay phần summary chỉ có `11/11` bằng hai tầng:

1. Giữ key-field cards để người dùng rà nhanh các cột quan trọng.
2. Thêm summary toàn bộ template:
   - Từ Excel
   - Mặc định
   - Công thức
   - Chưa thiết lập
   - Nhiều cách điền

Mỗi summary chip là một filter button cho mapping table. Có thêm `Tất cả`.

Confidence copy đổi từ:

```text
Khớp 100%
```

thành:

```text
Độ tin cậy gợi ý 100%
```

và luôn đi kèm copy:

```text
Đây là độ tin cậy ghép cột, không phải xác nhận dữ liệu đúng nghiệp vụ.
```

Nếu có `mixed` hoặc warning, không hiển thị trạng thái mang ý nghĩa hoàn tất tuyệt đối.

Filter `Bắt buộc cần xử lý` luôn có sẵn và bao gồm:

- Required field chưa thiết lập.
- Required field có `mixed` configuration.
- Required field được backend readiness trả blocker.

Summary/filter chỉ hỗ trợ điều hướng và không tự thay đổi severity từ backend.

### Validation issue list

`ValidationIssueTable` không được render tối đa 200 issue cùng lúc như hiện tại.

Thiết kế mới:

- Page size 25.
- Summary/filter theo `blocker`, `warning`, `info`.
- Nếu có blocker, mặc định chọn `blocker`; nếu không có blocker thì chọn `all`.
- Tìm theo dòng, cột, số chứng từ, message, actual và expected.
- Header summary luôn hiển thị tổng count, kể cả khi filter/search đang ẩn một số issue.
- Không được xóa hoặc bỏ qua issue; pagination chỉ thay đổi cách hiển thị.

### Download CTA state machine

CTA chính được tính từ state hiện tại:

| Condition | Label | Enabled | Action |
|---|---|---:|---|
| No analyze payload | Không hiển thị | No | None |
| No readiness report | Kiểm tra trước khi tải | Yes | Run preview/readiness |
| Readiness loading | Đang kiểm tra dữ liệu… | No | None |
| Blockers exist | Cần sửa lỗi trước khi tải | No | None |
| Warning not acknowledged | Xác nhận cảnh báo để tải | No | None |
| Ready or warnings acknowledged | Tải file MISA | Yes | Export |
| Export in progress | Đang tạo file MISA… | No | None |
| Export completed | Tải lại file MISA | Yes | Export existing run/profile |

Khi CTA `Kiểm tra trước khi tải` được bấm:

1. Chạy preview nếu chưa có preview rows.
2. Chạy readiness.
3. Scroll/focus tới readiness card.
4. Không bắt đầu download trong cùng click.

Khi export bắt đầu, frontend vẫn gửi warning acknowledgement và backend vẫn revalidate.

Mọi thay đổi mapping, default, formula, preview cell, xóa preview row, workspace hoặc master-data alias phải:

1. Xóa readiness report cũ.
2. Xóa warning acknowledgement cũ.
3. Chuyển CTA về `Kiểm tra trước khi tải`.

Readiness report cũ không bao giờ được dùng để mở download sau khi dữ liệu đầu vào đã thay đổi.

## Component Changes

### `MasterDataResolutionTable.jsx`

- Add collapsed summary header.
- Add status chips and counts.
- Add search input.
- Add 20-item pagination.
- Render only current page.
- Preserve current candidate search and alias confirmation behavior.

### `ConvertPage.jsx`

- Use mapping summary helpers.
- Add active mapping filter state.
- Render filtered target headers in mapping table.
- Replace duplicated download button condition/label logic with computed CTA state.
- Add `handlePrimaryDownloadCta()` to separate validation from export.
- Add progress/help copy beneath CTA.

### `ValidationIssueTable.jsx`

- Add severity summary/filter.
- Add search.
- Add 25-item pagination.
- Preserve full issue payload and source links.

### Optional small components

If `ConvertPage.jsx` becomes harder to read, extract:

- `MappingCoverageSummary.jsx`
- `DownloadCta.jsx`

Extraction is allowed only when it reduces the changed section; no unrelated page refactor.

## Accessibility

- Summary filters are real buttons with `aria-pressed`.
- Collapsible master-data section uses `aria-expanded` and a labelled control.
- Search input has a visible label or `aria-label`.
- Pagination buttons have Vietnamese accessible names.
- Loading copy is exposed as `aria-live="polite"`.
- Disabled CTA includes adjacent text explaining why it is disabled.

## Responsive Behavior

- Mapping summary chips wrap on mobile.
- Master-data controls stack vertically below `sm`.
- Table remains horizontally scrollable, but only filtered rows render.
- CTA remains full-width on mobile.
- No new global horizontal overflow.

## Error Handling

- Empty search results display a clear empty state and preserve summary counts.
- Page index is clamped when filter/search changes.
- Alias confirmation/search errors remain inside the master-data card.
- Required master-data conflicts remain visible in the summary even when the list is collapsed.
- Failed readiness restores the mapping/preview state and shows the existing error alert.
- CTA never falls back to `Tải file MISA` if readiness failed.

## Testing Strategy

### Unit tests first

Create:

```text
frontend/src/utils/converterUx.test.mjs
```

Cover:

- All five mapping modes.
- Backend precedence metadata for mixed configurations.
- Required field metadata.
- Whole-template counts.
- Mapping filters.
- Validation issue search/filter/pagination.
- CTA labels/actions for every state.
- Warning acknowledgement and blocker precedence.
- Readiness invalidation after any mapping/preview/master-data change.

Add focused component/helper tests for master-data filtering/pagination using pure exported helpers if React DOM test tooling is not available.

### Build and static validation

- `npm run lint`
- `npm run build`
- `npm run qa:fast`
- `git diff --check`

### Browser QA

Use the real 1.930-row sales file and verify:

- Master-data card starts collapsed unless required conflicts exist.
- Expanding renders at most 20 rows.
- Search and status filters work.
- Mapping counts add up to 59.
- `Nhiều cách điền` filter exposes the current multi-mode field without converting it into an automatic blocker.
- Validation issue table renders at most 25 issues per page.
- Initial CTA says `Kiểm tra trước khi tải`.
- Validation click does not download.
- CTA changes correctly after readiness and acknowledgement.
- Download still produces a structurally valid MISA `.xls`.
- Desktop and 390 px mobile viewport do not gain global overflow.

## Acceptance Criteria

- Page height after preview is bounded and no longer grows linearly with every master-data resolution.
- Master-data table renders no more than 20 rows per page.
- Mapping summary accounts for every target header.
- A field with multiple configured modes is counted as `mixed`, explains backend precedence and requires review rather than silently assigning one mode.
- Mixed configuration alone is not an automatic blocker.
- Every data/mapping/master-data change invalidates previous readiness and acknowledgement.
- Validation issue table renders no more than 25 rows per page without dropping issues.
- User cannot mistake a validation action for an immediate download.
- Backend export gate remains unchanged and cannot be bypassed.
- Existing mapping edits, master-data alias confirmation, preview editing and download still work.
