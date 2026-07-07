"""Column detection for common Vietnamese Excel headers."""

from __future__ import annotations

from pathlib import Path

import openpyxl
from fastapi.testclient import TestClient

from app.field_detection import detect_columns, semantic_value
from app.main import app

client = TestClient(app)


def test_semantic_value_uses_exact_source_header_without_normalizing_every_key(monkeypatch):
    def fail_if_called(_record):
        raise AssertionError("exact source-header lookup must not normalize the whole record")

    monkeypatch.setattr("app.field_detection.normalize_record_keys", fail_if_called)

    assert semantic_value({"Mã hàng": "SKU-001"}, {"item_code": "Mã hàng"}, "item_code") == "SKU-001"


def test_detect_purchase_common_headers():
    headers = [
        "Số PN",
        "Ngày nhập",
        "Mã NCC",
        "Tên NCC",
        "Mã hàng",
        "Số lượng",
        "Đơn giá",
    ]
    detected = detect_columns(headers)
    assert detected["purchase_receipt"] == "Số PN"
    assert detected["date"] == "Ngày nhập"
    assert detected["supplier_code"] == "Mã NCC"
    assert detected["item_code"] == "Mã hàng"


def test_purchase_goods_validate_with_so_pn_headers(tmp_path: Path):
    path = tmp_path / "purchase_common.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(
        [
            "Số PN",
            "Ngày CT",
            "Mã NCC",
            "Tên NCC",
            "Mã hàng",
            "Số lượng",
            "Giá mua",
        ]
    )
    ws.append(["PN-001", "02/01/2026", "NCC1", "NCC A", "SKU1", 2, 50000])
    wb.save(path)

    with path.open("rb") as handle:
        response = client.post(
            "/api/v1/conversions/validate",
            data={"conversion_type": "purchase_goods"},
            files={
                "file": (
                    path.name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert response.status_code == 200
    report = response.json()
    assert report["ok"] is True, report
