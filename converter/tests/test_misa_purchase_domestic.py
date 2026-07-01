from datetime import datetime

import openpyxl
import xlrd
from fastapi.testclient import TestClient

from app.excel_io import read_input_table
from app.main import app


TARGET_ID = "misa_purchase_domestic"

client = TestClient(app)


def _write_purchase_workbook(path):
    workbook = openpyxl.Workbook()
    summary = workbook.active
    summary.title = "HoaDon_TongQuat"
    summary.append(["BÁO CÁO HÓA ĐƠN MUA VÀO"])
    summary.append([])
    summary.append([])
    summary.append(["STT", "Mẫu số", "Ký hiệu", "Số hóa đơn", "Ngày hóa đơn"])
    summary.append([1, "1", "1C26TAA", "HD001", datetime(2026, 4, 2)])

    detail = workbook.create_sheet("Smart_KTSC_OK")
    headers = [
        "SR_HD", "SOCT", "NGAYCT", "SO_HD", "NGAY_HD", "DIENGIAI", "HTTT",
        "TKCO", "MATHANG", "TENDM", "Phân loại", "DONVI", "LUONG", "DGVND",
        "TTVND", "PT_CK", "CHIETKHAU", "TKTHUE", "TS_GTGT", "THUEVND",
        "MADTPNCO", "TENKH", "DIACHI",
    ]
    detail.append(headers)
    detail.append([
        "1C26TAA", "PN001", datetime(2026, 4, 2), "HD001", datetime(2026, 4, 2),
        "Tiền điện", "", "331", "Điện", "Điện", "Dịch vụ", "kWh", 804, 0,
        2905880, 0, 0, "1331", 8, 232470, "0300951119-005", "Nhà cung cấp A",
        "TP.HCM",
    ])
    detail.append([
        "1C26TBB", "PN002", datetime(2026, 4, 3), "HD002", datetime(2026, 4, 3),
        "Mua nguyên liệu", "Chuyển khoản", "1111", "NL001", "Nguyên liệu 1",
        "Hàng hóa", "Kg", 10, 10000, 100000, 0, 0, "1331", 10, 10000,
        "0312345678", "Nhà cung cấp B", "Bình Dương",
    ])
    workbook.save(path)
    return path


def test_purchase_workbook_prefers_smart_detail_sheet(tmp_path):
    table = read_input_table(_write_purchase_workbook(tmp_path / "purchase.xlsx"))

    assert table.sheet_name == "Smart_KTSC_OK"
    assert table.header_row_index == 0
    assert len(table.rows) == 2
    assert {"SR_HD", "SOCT", "MATHANG", "Phân loại", "TTVND"}.issubset(
        table.headers
    )


def test_purchase_domestic_template_exposes_real_58_column_contract():
    response = client.get("/api/v1/templates")

    assert response.status_code == 200
    template = next(item for item in response.json()["items"] if item["id"] == TARGET_ID)
    assert template["sheet_name"] == "Mua hang trong nuoc"
    assert template["header_row"] == 8
    assert template["data_start_row"] == 9
    assert len(template["headers"]) == 58
    assert template["headers"][0] == "Hình thức mua hàng"
    assert template["headers"][25] == "Mã hàng (*)"
    assert template["headers"][-1] == "CP không hợp lý"


def test_analyze_preview_and_export_purchase_file(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")

    raw_purchase = _write_purchase_workbook(tmp_path / "purchase.xlsx")
    with raw_purchase.open("rb") as handle:
        analyze = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": TARGET_ID},
            files={
                "file": (
                    raw_purchase.name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert analyze.status_code == 200
    payload = analyze.json()
    assert payload["detected"]["sheet_name"] == "Smart_KTSC_OK"
    assert payload["detected"]["header_row"] == 1
    assert payload["detected"]["row_count"] == 2
    suggestion = payload["mapping_suggestion"]
    assert suggestion["mapping"]["Phân loại"] == [
        "Hình thức mua hàng",
        "TK kho/TK chi phí (*)",
    ]
    assert suggestion["mapping"]["NGAYCT"] == [
        "Ngày hạch toán (*)",
        "Ngày chứng từ (*)",
    ]
    assert suggestion["mapping"]["SOCT"] == "Số phiếu nhập (*)"
    assert suggestion["mapping"]["MATHANG"] == ["Mã hàng (*)", "Tên hàng"]
    assert suggestion["mapping"]["TENKH"] == "Tên nhà cung cấp"
    assert suggestion["mapping"]["TTVND"] == "Thành tiền"

    preview = client.post(
        "/api/v1/mappings/preview",
        json={
            "upload_id": payload["upload_id"],
            "target_template_id": TARGET_ID,
            "mapping": suggestion["mapping"],
            "defaults": suggestion["defaults"],
            "formulas": suggestion["formulas"],
        },
    )
    assert preview.status_code == 200
    preview_payload = preview.json()
    assert preview_payload["stats"] == {"source_rows": 2, "output_rows": 2}
    service_row = preview_payload["rows"][0]
    assert service_row["Hình thức mua hàng"] == "Mua hàng trong nước không qua kho"
    assert service_row["Tên nhà cung cấp"]
    assert service_row["Mã hàng (*)"]
    assert service_row["Thành tiền"] == 2905880
    assert service_row["% thuế GTGT"] == 8
    assert service_row["TK kho/TK chi phí (*)"] == "6428"
    goods_row = next(
        row
        for row in preview_payload["rows"]
        if row["Hình thức mua hàng"] == "Mua hàng trong nước nhập kho"
    )
    assert goods_row["TK kho/TK chi phí (*)"] == "1561"
    assert goods_row["TK công nợ/TK tiền (*)"] in {"1111", "331"}

    confirm = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": payload["upload_id"],
            "target_template_id": TARGET_ID,
            "mapping": suggestion["mapping"],
            "defaults": suggestion["defaults"],
            "formulas": suggestion["formulas"],
            "profile_name": "BAE Foods mua vào",
        },
    )
    assert confirm.status_code == 200

    export = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": payload["upload_id"],
            "profile_id": confirm.json()["profile_id"],
        },
    )
    assert export.status_code == 200
    workbook = xlrd.open_workbook(file_contents=export.content, formatting_info=True)
    sheet = workbook.sheet_by_name("Mua hang trong nuoc")
    assert sheet.row_values(7) == preview_payload["headers"]
    assert len(sheet.row_values(7)) == 58
    assert sheet.cell_value(8, preview_payload["headers"].index("Tên nhà cung cấp"))
    assert sheet.cell_value(8, preview_payload["headers"].index("Thành tiền")) == 2905880
