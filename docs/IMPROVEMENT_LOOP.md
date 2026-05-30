# Vòng lặp cải tiến website EzFormat

## Chạy kiểm tra một lần

```powershell
npm run qa
# hoặc: pwsh -File scripts/site-improve.ps1
```

Ghi kết quả vào `docs/improvement-log.md` và in prompt gợi ý cho agent chỉnh UX tiếp theo.

## Bật vòng lặp tự động (mặc định 2 giờ/lần)

```powershell
pwsh -File scripts/improve-loop.ps1 -IntervalMinutes 120
```

Chạy nền trong terminal có **monitored output** (Cursor loop skill). Mỗi tick in sentinel:

`AGENT_LOOP_WAKE_ezformat-ux {"prompt":"..."}`

Agent đọc prompt → chạy `site-improve.ps1` → một cải tiến UX nhỏ hoặc sửa lỗi build.

## Dừng vòng lặp

Dừng terminal đang chạy `improve-loop.ps1` (Ctrl+C).

## Phạm vi mỗi vòng (ưu tiên)

1. Build frontend + smoke test converter pass
2. Một thay đổi UX: mobile, a11y, loading, copy tiếng Việt
3. Lazy-load admin routes nếu bundle > 500KB
4. Không commit trừ khi user yêu cầu
