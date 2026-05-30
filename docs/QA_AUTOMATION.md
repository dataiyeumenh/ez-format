# QA/QC tự động — EzFormat

## Một lần (trước commit / sau sửa code)

```powershell
npm run qa          # đầy đủ (~90s, gồm 43 test Python)
npm run qa:fast     # nhanh (~15s, bỏ test messy 1000)
```

Kết quả:
- `docs/qa-last-run.json` — báo cáo JSON
- `docs/qa-log.md` — lịch sử
- `docs/qa-failure.md` — chỉ khi FAIL (hướng dẫn agent sửa)

## Autopilot (retry 3 lần)

```powershell
npm run qa:autopilot       # nhanh (~10s) — CI / loop nền
npm run qa:autopilot:full  # đầy đủ pytest (~2 phút) — trước release
```

Nếu vẫn fail → ghi `docs/qa-failure.md` + `docs/qa-last-run.json` và in sentinel `AGENT_LOOP_WAKE_ezformat-qa` để agent sửa.

## Watch (chạy nền mỗi 60 phút)

```powershell
npm run qa:watch
```

Chạy trong terminal Cursor có **monitored output**; khi fail sẽ wake agent.

## Sau QA — cải tiến UI

```powershell
npm run ui:improve   # QA gate + ESLint + Prettier + build
npm run pipeline     # qa:fast → ui:improve (một lệnh)
```

Xem [UI_AUTOMATION.md](UI_AUTOMATION.md).

## CI (GitHub Actions)

Workflow `.github/workflows/qa.yml` chạy `npm run qa:ci` trên push/PR.

## Các bước kiểm tra

| Bước | Nội dung |
|------|----------|
| Prerequisites | node, python, npm |
| Fixtures | 6 file template MISA |
| Backend syntax | `node --check` các file JS chính |
| Frontend build | `vite build` |
| API smoke | healthz, conversion-types, preview, export |
| Full tests | toàn bộ pytest (bỏ khi `qa:fast`) |
