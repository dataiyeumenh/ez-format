# Hướng dẫn bật AI cho website EzFormat sau khi deploy Render/Vercel

## Kết luận nhanh

Đúng: nếu website muốn dùng AI để gợi ý mapping/converter thì **máy local của bạn phải bật** và chỉ cần chạy lệnh:

```powershell
cd "E:\0. EXE2\ez-format"
npm run ai:ngrok
```

Lệnh này sẽ bật 3 phần:

1. **Ollama local** trên máy bạn.
2. **EzFormat AI Gateway** local ở port `8010`.
3. **ngrok tunnel** để Render converter gọi được AI Gateway trên máy bạn.

Luồng chạy:

```text
Vercel frontend
→ Render converter
→ ngrok public URL
→ AI Gateway trên máy bạn
→ Ollama trên máy bạn
```

## Khi nào cần chạy lệnh này?

Chạy lệnh này khi:

- Website production cần dùng AI mapping.
- Bạn vừa khởi động lại máy.
- Bạn đã tắt terminal đang chạy AI/ngrok.
- ngrok URL cũ bị mất hoặc đổi.

Nếu không chạy, website vẫn có thể hoạt động nếu `AI_REQUIRED=false`, nhưng AI sẽ offline và converter chỉ dùng profile/rule/manual mapping.

## Cách chạy mỗi lần cần bật AI

Mở PowerShell rồi chạy:

```powershell
cd "E:\0. EXE2\ez-format"
npm run ai:ngrok
```

Giữ terminal đó mở. Không tắt terminal nếu vẫn muốn website dùng AI.

## Cách kiểm tra đã chạy đúng chưa

Sau khi chạy, kiểm tra file:

```text
E:\0. EXE2\ez-format\.artifacts\ngrok-ai\vps-ai.env
```

Trong file đó sẽ có dạng:

```env
AI_PROVIDER=remote_http
AI_BASE_URL=https://<ngrok-domain>/v1/misa/suggest-mapping
AI_TOKEN=<secret-token>
AI_TIMEOUT_SECONDS=120
AI_REQUIRED=false
```

Render converter phải dùng đúng `AI_BASE_URL` và `AI_TOKEN` này.

## Nếu ngrok URL bị đổi

Nếu bạn dùng ngrok free, public URL có thể thay đổi. Khi URL đổi:

1. Chạy lại:

```powershell
cd "E:\0. EXE2\ez-format"
npm run ai:ngrok
```

2. Mở file:

```text
E:\0. EXE2\ez-format\.artifacts\ngrok-ai\vps-ai.env
```

3. Copy `AI_BASE_URL` mới.
4. Vào Render converter → Environment → sửa `AI_BASE_URL`.
5. Restart hoặc redeploy Render converter.

## Env cần có trên Render converter

```env
MISA_TEMPLATE_DIR=fixtures/templates
MISA_TEMPLATE_MANIFEST_PATH=config/misa-template-manifest.json
MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS=partner_sample_derived
MAPPING_DB_PATH=data/mapping_profiles.sqlite

AI_PROVIDER=remote_http
AI_BASE_URL=https://<ngrok-domain>/v1/misa/suggest-mapping
AI_TOKEN=<token trong vps-ai.env>
AI_TIMEOUT_SECONDS=120
AI_REQUIRED=false
```

Các template hiện tại là bản dẫn xuất cấu trúc đã xóa toàn bộ dữ liệu sau header
từ mẫu do đối tác cung cấp; các file template hiện tại không chứa giá trị khách
hàng sau header. Chưa rõ ngày tiếp nhận, sản phẩm và release MISA; dự án không
tuyên bố đây là file tải từ nguồn MISA chính thức. Commit lịch sử có thể còn byte
tiền nhiệm; rewrite lịch sử cần một thao tác được phê duyệt riêng.

`xlutils.copy` hiện không giữ được formula, defined name, drawing/object và data
validation trong BIFF `.xls`. Chạy
`python -m app.misa_templates verify --require-export-safe` trước release.
Template có các record này sẽ làm production fail-closed; không có cơ chế bypass
và không phụ thuộc Excel COM trên Render.

Không đưa `AI_TOKEN` lên Vercel frontend.

## Env cần có trên Vercel frontend

```env
VITE_NODE_API_URL=https://<backend-node-render>.onrender.com
```

Browser requests must use the Node backend. Do not expose the FastAPI converter URL in Vite environment variables.

Sau khi đổi env trên Vercel, cần redeploy frontend.

## Lỗi thường gặp

### Website báo AI/converter offline

Kiểm tra:

- Render converter có chạy không: `https://<converter-render>.onrender.com/healthz`
- Máy local có đang chạy `npm run ai:ngrok` không.
- `AI_BASE_URL` trên Render có đúng URL mới nhất trong `vps-ai.env` không.
- Terminal chạy ngrok có bị tắt không.

### AI không hoạt động nhưng converter vẫn chạy

Có thể do:

- Máy local tắt.
- Ollama chưa chạy được.
- ngrok URL đổi.
- `AI_TOKEN` trên Render không khớp token local.

### Có cần deploy AI lên Render không?

Không cần với hướng hiện tại. AI chạy trên máy bạn để tiết kiệm VPS/Render tài nguyên. Render chỉ gọi AI qua ngrok.
