from pathlib import Path

import xlrd
from fastapi.testclient import TestClient

from app.main import app

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "fixtures" / "samples"

client = TestClient(app)


def test_session_export_ignores_client_edited_preview_rows(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")

    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        analyze = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    "raw_sales_sample.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert analyze.status_code == 200
    analyze_payload = analyze.json()
    suggestion = analyze_payload["mapping_suggestion"]

    preview = client.post(
        "/api/v1/mappings/preview",
        json={
            "upload_id": analyze_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": suggestion["mapping"],
            "defaults": {
                **suggestion["defaults"],
                "Hình thức bán hàng": "Bán hàng hóa trong nước",
                "Phương thức thanh toán": "Chưa thu tiền",
                "TK Tiền/Chi phí/Nợ (*)": "131",
                "TK Doanh thu/Có (*)": "5111",
            },
            "formulas": suggestion["formulas"],
        },
    )
    assert preview.status_code == 200
    preview_payload = preview.json()
    edited_rows = [dict(preview_payload["rows"][0])]
    doc_header = "Số chứng từ (*)"
    edited_rows[0][doc_header] = "EDITED-PREVIEW-001"

    confirm = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": analyze_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": suggestion["mapping"],
            "defaults": {
                **suggestion["defaults"],
                "Hình thức bán hàng": "Bán hàng hóa trong nước",
                "Phương thức thanh toán": "Chưa thu tiền",
                "TK Tiền/Chi phí/Nợ (*)": "131",
                "TK Doanh thu/Có (*)": "5111",
            },
            "formulas": suggestion["formulas"],
            "profile_name": "Edited preview export",
        },
    )
    assert confirm.status_code == 200
    profile_id = confirm.json()["profile_id"]

    export = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": analyze_payload["upload_id"],
            "profile_id": profile_id,
            "rows": edited_rows,
            "acknowledge_warnings": True,
        },
    )
    assert export.status_code == 200

    workbook = xlrd.open_workbook(file_contents=export.content)
    sheet = workbook.sheet_by_index(0)
    headers = preview_payload["headers"]
    assert (
        sheet.cell_value(8, headers.index(doc_header))
        == preview_payload["rows"][0][doc_header]
    )
