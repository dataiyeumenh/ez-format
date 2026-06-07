# PDF — phạm vi sản phẩm

## Phiên bản hiện tại (v1)

- **Hỗ trợ:** Excel `.xlsx`, `.xls` → form nhập MISA (6 loại).
- **Không hỗ trợ:** Upload hoặc chuyển đổi trực tiếp từ PDF.

## Hướng dẫn người dùng

1. Mở báo cáo PDF trong phần mềm nguồn (POS, kế toán, ERP…).
2. **Xuất / Save as** sang Excel (`.xlsx`).
3. Vào [Chuyển đổi](/convert) trên EzFormat và tải file Excel lên.

UI sẽ hiển thị thông báo rõ nếu người dùng chọn file `.pdf`.

## Kế hoạch sau (Phase 3 — chưa triển khai)

- Trích bảng từ PDF (pdfplumber / tabula) → preview giống luồng Excel.
- OCR cho PDF scan (tùy chọn).
- Endpoint `POST /api/v1/conversions` nhận `application/pdf` với mã lỗi có hướng dẫn cho đến khi feature sẵn sàng.

## Kỹ thuật

Converter (`converter/app/main.py`) chỉ chấp nhận MIME Excel; không cần đổi API cho v1.
