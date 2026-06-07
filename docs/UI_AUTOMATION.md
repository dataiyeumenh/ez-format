# Automation cải tiến UI

Chạy **sau** khi QA/QC pass (`npm run qa:fast`).

## Lệnh

| Lệnh | Mô tả |
|------|--------|
| `npm run ui:improve` | QA gate → ESLint → Prettier check → build |
| `npm run ui:autopilot` | UI improve + retry, wake agent nếu fail |
| `npm run ui:watch` | Lặp mỗi 3 giờ |
| `npm run pipeline` | QA fast → UI improve (một lần) |

## Extensions (Cursor)

Đã cài qua CLI + gợi ý trong `.vscode/extensions.json`:

| Extension | ID |
|-----------|-----|
| Tailwind CSS IntelliSense | `bradlc.vscode-tailwindcss` |
| Prettier | `esbenp.prettier-vscode` |
| ESLint | `dbaeumer.vscode-eslint` |
| Color Highlight | `naumovs.color-highlight` |
| Live Server *(Live Preview)* | `ms-vscode.live-server` |

> **Live Preview:** ID `ms-vscode.live-preview` không có trên marketplace Cursor; dùng **Live Server** hoặc `npm run frontend` (Vite :5173).

Reload Cursor sau khi cài extension: `Ctrl+Shift+P` → **Developer: Reload Window**.

## Preview giao diện

```powershell
npm run frontend          # http://localhost:5173 (khuyến nghị)
# hoặc sau build:
cd frontend && npm run build && npm run preview
# hoặc Live Server: chuột phải frontend/index.html → Open with Live Server
```

## Format / lint thủ công

```powershell
cd frontend
npm run format
npm run lint:fix
```

Workspace settings: `.vscode/settings.json` (format on save, Tailwind, ESLint).
