from __future__ import annotations

import openpyxl

from app.excel_io import read_input_table, read_purchase_adjustment_context


def test_purchase_adjustment_context_joins_summary_to_detail_for_review(tmp_path):
    path = tmp_path / "purchase-adjustment.xlsx"
    workbook = openpyxl.Workbook()
    summary = workbook.active
    summary.title = "HoaDon_TongQuat"
    summary.append(["HÓA ĐƠN MUA VÀO"])
    summary.append([])
    summary.append([])
    summary.append(
        ["MST người bán", "Ký hiệu", "Số", "Trạng thái HĐ"]
    )
    summary.append(
        [
            "0105696842",
            "1K26TEB",
            "41617",
            "HĐ Điều chỉnh - Điều chỉnh cho ký hiệu hóa đơn 1K26TEB, "
            "số 38884, ngày lập 03/04/2026",
        ]
    )

    detail = workbook.create_sheet("Smart_KTSC_OK")
    detail.append(
        [
            "SR_HD",
            "SOCT",
            "SO_HD",
            "MATHANG",
            "Phân loại",
            "TTVND",
            "MADTPNCO",
        ]
    )
    detail.append(
        ["1K26TEB", "41617", "41617", "Dịch vụ", "Dịch vụ", -1000, "0105696842"]
    )
    workbook.save(path)

    table = read_input_table(path)
    contexts = read_purchase_adjustment_context(path, table)

    assert contexts == [
        {
            "supplier_tax_code": "0105696842",
            "invoice_symbol": "1K26TEB",
            "invoice_number": "41617",
            "status": (
                "HĐ Điều chỉnh - Điều chỉnh cho ký hiệu hóa đơn 1K26TEB, "
                "số 38884, ngày lập 03/04/2026"
            ),
            "adjusts_invoice": {
                "invoice_symbol": "1K26TEB",
                "invoice_number": "38884",
                "invoice_date": "03/04/2026",
            },
            "detail_row_count": 1,
            "requires_user_review": True,
        }
    ]
