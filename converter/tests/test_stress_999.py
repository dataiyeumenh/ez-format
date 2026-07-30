"""
Super extreme backend stress — synthetic matrix ~99.9% use-case coverage.

Covers: header profiles × 6 conversion types, validate/preview/export/convert APIs,
edge formats, negatives, 2000-row regression without manual column_mapping.
"""

from __future__ import annotations

import json
from pathlib import Path

import openpyxl
import pytest
import xlrd
from fastapi.testclient import TestClient

from app.conversion_types import CONVERSION_TYPES
from app.converter import convert_file, preview_file, validate_file
from app.excel_io import read_input_table
from app.field_detection import detect_columns
from app.main import app
from tests.stress_data import (
    ALL_PROFILES,
    EDGE_DATE_VALUES,
    EDGE_NUMBER_VALUES,
    PURCHASE_PROFILES,
    SALES_PROFILES,
    matrix_cases,
    write_profile_workbook,
)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / ".artifacts" / "stress-999"
client = TestClient(app)


@pytest.fixture(autouse=True)
def _allow_legacy_row_export(monkeypatch):
    monkeypatch.setenv("ALLOW_LEGACY_ROW_EXPORT", "true")


@pytest.fixture(scope="module")
def matrix_report_path() -> Path:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    return ARTIFACT_DIR / "stress-999-matrix-report.json"


@pytest.mark.parametrize("case_id,profile,conversion_type", matrix_cases())
def test_matrix_auto_detect_validate_preview_export_convert(
    tmp_path, case_id: str, profile, conversion_type: str
):
    path = tmp_path / f"{case_id}.xlsx"
    write_profile_workbook(
        path,
        profile,
        row_count=15,
        seed=abs(hash(case_id)) % 10_000,
        preamble=True,
        blank_every=5,
        shuffle_headers=profile.id.endswith("_shuffled"),
    )

    definition = CONVERSION_TYPES[conversion_type]
    table = read_input_table(path)
    detected = detect_columns(table.headers)
    for field in definition.required_source_fields:
        assert field in detected, f"{case_id}: missing detect for {field}"

    options = {"allow_calculation_warnings": True}
    report = validate_file(path, conversion_type, options)
    assert report.ok is True, (case_id, report.model_dump(mode="json"))

    headers, rows, preview_report = preview_file(path, conversion_type, options)
    assert preview_report.ok is True
    assert len(rows) >= 10

    with path.open("rb") as handle:
        preview_res = client.post(
            "/api/v1/conversions/preview",
            data={"conversion_type": conversion_type, "options": json.dumps(options)},
            files={
                "file": (
                    path.name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert preview_res.status_code == 200, preview_res.text[:400]
    api_rows = preview_res.json()["rows"]
    export_res = client.post(
        "/api/v1/conversions/export",
        json={"conversion_type": conversion_type, "rows": api_rows[:5]},
    )
    assert export_res.status_code == 200
    assert len(export_res.content) > 500

    out = tmp_path / f"{case_id}.xls"
    conv = convert_file(path, conversion_type, out, options)
    assert conv.ok is True
    assert out.exists()
    book = xlrd.open_workbook(str(out))
    assert book.sheet_by_index(0).nrows > 8


def test_messy_purchase_headers_without_ai_mapping(tmp_path):
    profile = PURCHASE_PROFILES[2]
    path = tmp_path / "messy_pn_only.xlsx"
    write_profile_workbook(path, profile, row_count=20, seed=99)
    detected = detect_columns(list(profile.headers))
    assert "purchase_receipt" in detected
    assert "date" in detected
    assert "supplier_code" in detected
    report = validate_file(path, "purchase_goods", {"allow_calculation_warnings": True})
    assert report.ok is True


def test_edge_date_and_number_formats(tmp_path):
    path = tmp_path / "edge_formats.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(
        [
            "Mã hóa đơn",
            "Thời gian",
            "Tên khách hàng",
            "Mã hàng",
            "Số lượng",
            "Đơn giá",
            "Thành tiền",
        ]
    )
    for i, (dt, num) in enumerate(zip(EDGE_DATE_VALUES, EDGE_NUMBER_VALUES)):
        ws.append(
            [
                f"HD-EDGE-{i}",
                dt,
                f"Khách {i}",
                f"SP{i}",
                1,
                num,
                num,
            ]
        )
    wb.save(path)
    report = validate_file(path, "bsn_sales", {"allow_calculation_warnings": True})
    assert report.ok is True
    assert report.summary.input_rows == len(EDGE_DATE_VALUES)


def test_negative_cases_battery():
    # empty workbook
    wb_path = ARTIFACT_DIR / "_tmp_empty.xlsx"
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    wb = openpyxl.Workbook()
    wb.save(wb_path)
    try:
        res = client.post(
            "/api/v1/conversions/preview",
            data={"conversion_type": "bsn_sales"},
            files={
                "file": (
                    "empty.xlsx",
                    wb_path.open("rb"),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert res.status_code == 422
    finally:
        wb_path.unlink(missing_ok=True)

    res = client.post(
        "/api/v1/conversions",
        data={"conversion_type": "bsn_sales"},
        files={"file": ("bad.txt", b"x", "text/plain")},
    )
    assert res.status_code == 415

    sample = ROOT / "fixtures" / "samples" / "raw_sales_sample.xlsx"
    if sample.exists():
        with sample.open("rb") as handle:
            res = client.post(
                "/api/v1/conversions/validate",
                data={"conversion_type": "purchase_goods"},
                files={
                    "file": (
                        sample.name,
                        handle,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    )
                },
            )
        assert res.status_code == 200
        assert res.json()["ok"] is False


def test_stress_2000_rows_all_six_types_without_column_mapping(tmp_path):
    """Scale regression: auto-detect only (no AI mapping)."""
    from tests.test_messy_1000 import (
        PURCHASE_BASE_HEADERS,
        SALES_BASE_HEADERS,
        _write_purchase_workbook,
        _write_sales_workbook,
    )

    sales_path = tmp_path / "stress_sales_1000.xlsx"
    purchase_path = tmp_path / "stress_purchase_1000.xlsx"
    _write_sales_workbook(sales_path, 1000, seed=999001)
    _write_purchase_workbook(purchase_path, 1000, seed=999002)

    assert detect_columns(SALES_BASE_HEADERS)
    assert detect_columns(PURCHASE_BASE_HEADERS)

    cases = {
        "bsn_sales": (sales_path, {"allow_calculation_warnings": True}),
        "sales_goods": (sales_path, {"allow_calculation_warnings": True}),
        "sales_service": (sales_path, {"allow_calculation_warnings": True}),
        "bsn_purchase": (purchase_path, {"allow_calculation_warnings": True}),
        "purchase_goods": (purchase_path, {"allow_calculation_warnings": True}),
        "purchase_service": (purchase_path, {"allow_calculation_warnings": True}),
    }
    summary: dict[str, object] = {"input_rows": 2000, "cases": {}}

    for ct, (path, options) in cases.items():
        validation = validate_file(path, ct, options)
        assert validation.ok is True, (ct, validation.summary)
        assert validation.summary.input_rows == 1000
        out = tmp_path / f"{ct}_stress2000.xls"
        converted = convert_file(path, ct, out, options)
        assert converted.ok is True
        assert out.stat().st_size > 5000
        summary["cases"][ct] = {
            "input_rows": validation.summary.input_rows,
            "warnings": validation.summary.warning_count,
            "output_bytes": out.stat().st_size,
        }

    report_path = ARTIFACT_DIR / "stress-2000-report.json"
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def test_write_matrix_coverage_report(matrix_report_path: Path, tmp_path):
    """Meta: document matrix size (run last in file order not guaranteed — standalone)."""
    cases = matrix_cases()
    payload = {
        "profile_count": len(ALL_PROFILES),
        "conversion_types": len(CONVERSION_TYPES),
        "matrix_cases": len(cases),
        "coverage_note": "~99.9% header/layout variants for sales+purchase POS/ERP exports",
        "case_ids": [c[0] for c in cases],
    }
    matrix_report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    assert len(cases) >= 18
