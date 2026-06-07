# Backend test automation (fix loop until PASS)

## Yêu cầu hoàn tất

Autopilot **chỉ xong** khi `backend-test-gate` PASS toàn bộ:

| Bước | Nội dung |
|------|----------|
| Specialized 1000 | VAT → ô Excel, PDF, OCR mock, .xls corrupt, đa sheet (×1000) |
| Stress 999 | Matrix header × 6 loại conversion |
| E2E extreme | validate → preview → export + API |
| Messy 1000 | 1000 dòng cột xáo trộn |
| Full pytest | Toàn bộ test converter (~86+) |

## Lệnh

```powershell
# Một lần (gate)
npm run test:gate

# Autopilot: tối đa 5 vòng, retry 15s giữa các vòng
npm run test:autopilot

# Lặp đến khi PASS (tối đa 999 vòng — dùng khi agent sửa xen kẽ)
npm run test:autopilot:until
```

## Khi FAIL

- `docs/backend-test-last-run.json` — bước nào lỗi
- `docs/backend-test-failure.md` — hướng dẫn agent sửa
- In ra: `AGENT_LOOP_WAKE_ezformat-backend-tests` → Cursor agent đọc và sửa

## Khi PASS

- `docs/backend-test-pass.json`
- Xóa `docs/backend-test-failure.md` (nếu có)

## Quy trình agent (trong Cursor)

1. Chạy `npm run test:autopilot`
2. Nếu FAIL → đọc failure doc → sửa code → chạy lại `npm run test:autopilot`
3. Lặp cho đến **BACKEND TEST GATE PASSED**

## Liên quan

- `npm run test:extreme` — thêm QA fast + UI + live HTTP
- `npm run qa:autopilot` — gate frontend/build nhanh
