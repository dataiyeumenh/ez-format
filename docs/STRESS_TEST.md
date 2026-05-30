# Backend stress test (99.9% use-case matrix)

## Chạy

```powershell
npm run test:specialized     # VAT cell + PDF/OCR + corrupt xls + multisheet ×1000 (~30s)
npm run test:stress          # stress 999 matrix (~30s)
npm run test:extreme         # QA + UI + specialized + stress + messy1000 + pytest + live HTTP
```

## Phạm vi

| Lớp | Nội dung |
|-----|----------|
| **Matrix 21×6** | 7 profile header (formal / retail / minimal / shuffled / purchase common / messy) × 6 loại conversion |
| **API** | validate → preview → export → convert (FastAPI TestClient) |
| **Scale** | 2000 dòng (1000 sales + 1000 purchase), **không** cần `column_mapping` AI |
| **Edge** | Ngày Excel/ISO/text, số VNĐ/dấu phẩy |
| **Negative** | file rỗng, .txt, sales→purchase |
| **Messy 1000** | (trong `test:extreme`) shuffled columns + calculation warnings |

## Cải tiến engine

- `detect_columns()` dùng alias chính xác + **pattern fallback** (`app/column_patterns.py`) — nhận `Số PN nội bộ`, `SL nhập`, v.v. không cần mock AI.

## Báo cáo

- `converter/.artifacts/stress-999/stress-999-matrix-report.json`
- `converter/.artifacts/stress-999/stress-2000-report.json`
