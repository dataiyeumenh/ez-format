# Thiết kế: Chức năng Góp ý cho User

**Ngày:** 2026-06-16
**Trạng thái:** Approved (chờ review spec)

## Mục tiêu

Cho phép user đã đăng nhập gửi góp ý về hệ thống. Admin xem được danh sách góp ý
(read-only) tại trang "Nhật ký hoạt động" hiện có (sẽ đổi tiêu đề thành "Góp ý người dùng").

## Quyết định đã chốt

| Hạng mục | Quyết định |
| --- | --- |
| Lưu trữ | Collection MongoDB riêng `Feedback` (mirror pattern `ConversionRun`) |
| Trường form | Loại (dropdown) + Nội dung (textarea) |
| Đăng nhập | Bắt buộc — nút chỉ trong dropdown user đã login + endpoint có `protect` |
| Vị trí nút | Trong dropdown khi bấm tên user (Navbar), ngay **dưới** "Xem / nâng cấp gói" |
| UX form | Modal popup |
| Admin xem | Bảng góp ý data thật trên `LogsPage`; **xóa toàn bộ logs mock + stats mock** |
| Hành động admin | Chỉ xem (read-only) — không status, không reply |
| Tiêu đề trang admin | Đổi "Nhật ký hoạt động" → **"Góp ý người dùng"**; sidebar label → "Góp ý" |

## Data model — `backend/models/Feedback.js`

```
user              ObjectId ref User   (required, index)
userNameSnapshot  String              // snapshot lúc tạo (admin xem được kể cả user đổi tên / bị xóa)
userEmailSnapshot String
category          String enum ["bug","feature","ui","other"] (required)
message           String              (required, trim, max 2000)
timestamps        true                // createdAt = thời gian góp ý
index             { createdAt: -1 }
```

- Không có field `status` (admin read-only → YAGNI; thêm sau nếu cần triage).
- Snapshot tên/email theo đúng pattern `ConversionRun.js` để danh sách admin bền vững.

### Map category → nhãn hiển thị (tiếng Việt)

| code | nhãn |
| --- | --- |
| `bug` | Lỗi |
| `feature` | Tính năng |
| `ui` | Giao diện |
| `other` | Khác |

## Backend (Node/Express)

Theo đúng pattern `conversionRun*` hiện có.

### `services/feedbackService.js`
- `CATEGORIES` — Set ["bug","feature","ui","other"] + map nhãn.
- `serializeFeedback(doc)` — DTO: id, userName (fallback snapshot), userEmail, category, categoryLabel, message, createdAt.
- `buildFeedbackFilter({ category, from, to })` — query Mongo theo category + khoảng ngày (ISO).
- `summarizeFeedback(items)` — đếm theo từng loại + tổng.

### `controllers/feedbackController.js`
- `createFeedback` (protect): validate category + message không rỗng; snapshot name/email từ `req.user`; tạo doc; trả serialized.
- `getAdminFeedback` (protect + adminOnly): phân trang (page/limit), filter qua `buildFeedbackFilter`, kèm `stats` từ `summarizeFeedback`.

### Routes
- `routes/feedback.js`: `POST /api/feedback` → `createFeedback` (middleware: `requireDb`, `protect`).
- `routes/admin.js` (thêm dòng): `GET /api/admin/feedback` → `feedbackController.getAdminFeedback` (`protect`, `adminOnly`).
- `server.js`: `app.use("/api/feedback", require("./routes/feedback"))`.

## Frontend (React)

### `services/feedback.js` (mới)
- `submitFeedback({ category, message })` → `POST /feedback` (axios instance sẵn có).
- `fetchAdminFeedback({ page, category, from, to })` → `GET /admin/feedback`.

### `components/FeedbackModal.jsx` (mới)
- Props: `open`, `onClose`.
- UI: `<select>` Loại (4 option VN) + `<textarea>` Nội dung (đếm ký tự, max 2000).
- States: idle / submitting (disable nút + spinner) / success (thông báo cảm ơn rồi auto đóng) / error (alert).
- Dùng pattern modal đồng bộ với project (custom overlay như UsersPage, hoặc Radix Dialog — chọn theo cái nhất quán nhất khi implement).

### `components/Navbar.jsx`
- Trong dropdown user (block hiện "Xem / nâng cấp gói"), thêm nút **"Góp ý"** ngay dưới link đó.
- Bấm → set state mở `FeedbackModal`.
- Chỉ render khi user đã đăng nhập (đã nằm trong nhánh logged-in sẵn có).

### `pages/admin/LogsPage.jsx` (viết lại)
- **Xóa** `mockLogs`, `TOTAL_PAGES` hardcode, 4 stat card mock.
- Tiêu đề → "Góp ý người dùng"; phụ đề → "Xem các góp ý người dùng gửi về hệ thống."; sửa nút Export nếu giữ.
- `useEffect` fetch `fetchAdminFeedback` theo page + category filter.
- Stats: đếm theo loại (Lỗi / Tính năng / Giao diện / Khác) từ `stats` API trả về.
- Bảng: Người dùng (avatar chữ cái đầu + tên), Loại (badge màu theo loại), Nội dung (truncate), Thời gian.
- Filter bar: theo Loại (Tất cả / Lỗi / Tính năng / Giao diện / Khác).
- States: loading (skeleton/spinner), empty ("Chưa có góp ý nào"), error.
- Phân trang thật từ response (totalPages), không hardcode.
- Giữ nguyên design language hiện tại (card trắng, border-gray, badge bo tròn, font-black tiêu đề).

### `components/admin/AdminLayout.jsx`
- Đổi label nav item của route logs: "Nhật ký hoạt động" / "Logs" → **"Góp ý"**.

## Test (theo pattern `node:test` sẵn có trong `backend/tests/`)

`backend/tests/feedback.test.js`:
- `serializeFeedback`: fallback dùng snapshot khi user null; map categoryLabel đúng.
- `buildFeedbackFilter`: filter theo category; theo khoảng ngày from/to.
- `summarizeFeedback`: đếm đúng số lượng từng loại + tổng.
- Validate: category ngoài enum bị từ chối (test ở tầng service/model nếu tách được logic).

## Verify (trước khi claim done)

- `npm run qa` (hoặc `qa:fast`) — backend syntax check + frontend build + converter tests phải PASS.
- `node --test backend/tests/feedback.test.js` — test mới PASS.
- Quote output (exit 0) làm bằng chứng.

## Ngoài phạm vi (YAGNI)

- Status / workflow xử lý góp ý.
- Admin reply lại user.
- Rating sao.
- Email notification khi có góp ý mới.
- Trang `/admin/feedback` riêng (đã chọn nhúng vào LogsPage).
