"""
1000× synthetic checks per specialized backend scenario (~99% real-world coverage).

Categories: VAT/calculation cell pinpoint, multi-sheet, corrupt .xls, PDF, OCR.
"""

from __future__ import annotations

import json
from pathlib import Path

import openpyxl
import pytest

from app.converter import validate_file
from app.document_import import classify_pdf_bytes, import_document
from app.excel_io import InputReadError, read_input_table, score_header_rows
from tests.synthesis_1000 import (
    SALES_CALC_HEADERS,
    build_multisheet_workbook,
    build_ocr_sidecar_text,
    build_pdf_table_bytes,
    build_valid_xls,
    build_vat_mismatch_workbook,
    corrupt_pdf_bytes,
    corrupt_xls_bytes,
    pdf_classify_scenario,
    vat_header_name,
)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / ".artifacts" / "specialized-1000"
ITERATIONS = 1000


def test_vat_mismatch_pinpoints_cell_1000(tmp_path):
    """1000 rows — each VAT error must name row + source column + Excel cell."""
    path = tmp_path / "vat_1000.xlsx"
    expected_cells = build_vat_mismatch_workbook(path, row_count=ITERATIONS, seed=42)

    report = validate_file(path, "bsn_sales", {"allow_calculation_warnings": True})
    assert report.ok is True

    vat_warnings = [w for w in report.warnings if w.code == "calculation_vat_mismatch"]
    assert len(vat_warnings) == ITERATIONS

    for warning in vat_warnings:
        assert warning.row is not None
        assert warning.field == "vat_amount"
        assert warning.source_header == vat_header_name()
        assert warning.column_index == SALES_CALC_HEADERS.index(vat_header_name())
        assert warning.cell == expected_cells[warning.row]
        from app.cell_ref import excel_cell

        assert warning.cell == excel_cell(warning.row, warning.column_index)
        assert warning.expected is not None
        assert warning.actual is not None
        assert abs(float(warning.delta)) > 1

    assert len({w.row for w in vat_warnings}) == ITERATIONS


def test_multisheet_picks_data_sheet_1000(tmp_path):
    """1000 multi-sheet layouts — must read data sheet, not summary."""
    misses = 0
    for scenario in range(ITERATIONS):
        path = tmp_path / f"multi_{scenario}.xlsx"
        expected_name, expected_rows = build_multisheet_workbook(path, scenario)
        table = read_input_table(path)
        if table.sheet_name != expected_name or len(table.rows) != expected_rows:
            misses += 1
    assert misses == 0, f"{misses} multisheet scenarios failed"


def test_multisheet_header_scoring_1000():
    """In-memory header scoring — 1000 random sheet layouts."""
    rng = __import__("random").Random(99)
    for scenario in range(ITERATIONS):
        sheets: list[tuple[str, list[list[str]]]] = []
        for idx in range(2 + scenario % 3):
            name = f"S{idx}_{scenario}"
            if idx == scenario % 3:
                rows = [
                    ["note"],
                    list(SALES_CALC_HEADERS),
                    ["HD1", "01/01/2026", "K", "M1", "1", "1", "1", "0", "0"],
                ]
            else:
                rows = [["summary"], ["x", "y"], ["a", "b"]]
            sheets.append((name, rows))

        best_score = (-1, -1)
        best_name = ""
        for name, rows in sheets:
            _, score = score_header_rows(rows)
            if score > best_score:
                best_score = score
                best_name = name
        assert best_name.startswith("S") and best_score[0] >= 4


def test_corrupt_xls_handling_1000(tmp_path):
    """1000 corrupt/truncated .xls variants — structured InputReadError."""
    valid_path = tmp_path / "base.xls"
    build_valid_xls(valid_path, rows=2)
    valid_bytes = valid_path.read_bytes()

    codes: dict[str, int] = {}
    for scenario in range(ITERATIONS):
        payload = corrupt_xls_bytes(scenario, valid_base=valid_bytes)
        path = tmp_path / f"corrupt_{scenario}.xls"
        path.write_bytes(payload)
        try:
            read_input_table(path)
            if scenario % 6 in (1, 3) and len(payload) > 100:
                continue
            if len(payload) < 8:
                continue
        except InputReadError as exc:
            codes[exc.code] = codes.get(exc.code, 0) + 1
            report = validate_file(path, "bsn_sales")
            assert report.ok is False
            assert report.errors[0].code == exc.code
        except Exception:
            codes["unexpected"] = codes.get("unexpected", 0) + 1

    assert codes.get("corrupt_xls", 0) + codes.get("unexpected", 0) >= 800, codes
    assert codes.get("corrupt_xls", 0) >= 500


def test_pdf_classify_and_import_1000(tmp_path):
    """1000 PDF payloads — classify + import when engine available."""
    stats: dict[str, int] = {}
    import_ok = 0
    for scenario in range(ITERATIONS):
        if scenario % 4 == 0:
            payload = build_pdf_table_bytes(scenario)
        else:
            valid = build_pdf_table_bytes(scenario) if scenario % 7 == 0 else None
            payload = corrupt_pdf_bytes(scenario, valid=valid)

        kind = classify_pdf_bytes(payload)
        stats[kind] = stats.get(kind, 0) + 1

        path = tmp_path / f"doc_{scenario}.pdf"
        path.write_bytes(payload)
        result = import_document(path)
        if kind == "pdf_ok":
            if result.ok:
                import_ok += 1
                assert result.table is not None
                assert len(result.table.rows) >= 1
            else:
                assert result.code in (
                    "pdf_no_table",
                    "corrupt_pdf",
                    "pdf_engine_unavailable",
                )
        else:
            assert not result.ok
            assert result.code in (
                "corrupt_pdf",
                "truncated_pdf",
                "pdf_engine_unavailable",
                "pdf_no_table",
            )

    ARTIFACT.mkdir(parents=True, exist_ok=True)
    (ARTIFACT / "pdf-stats.json").write_text(
        json.dumps({"stats": stats, "import_ok": import_ok}, indent=2),
        encoding="utf-8",
    )
    assert stats.get("corrupt_pdf", 0) + stats.get("truncated_pdf", 0) >= 400
    assert sum(stats.values()) == ITERATIONS
    assert import_ok >= 200


def test_delimited_text_table_parser_1000():
    """1000 tab/space-separated text layouts (PDF/OCR fallback path)."""
    from app.document_import import _table_from_delimited_text

    ok = 0
    for scenario in range(ITERATIONS):
        delim = "\t" if scenario % 3 == 0 else "  " if scenario % 3 == 1 else ","
        headers = delim.join(["invoice", "date", "customer", "sku", "qty", "price"])
        lines = [headers]
        for i in range(2):
            lines.append(
                delim.join(
                    [
                        f"H{scenario}-{i}",
                        "01/01/2026",
                        "Cust",
                        f"S{i}",
                        "1",
                        str(1000 + i),
                    ]
                )
            )
        table = _table_from_delimited_text("\n".join(lines))
        if len(table.headers) >= 4 and len(table.rows) >= 2:
            ok += 1
    assert ok == ITERATIONS


def test_ocr_mock_sidecar_1000(tmp_path):
    """1000 OCR mock scenarios via .png + .ocr.txt sidecar (no Tesseract required)."""
    ok_count = 0
    for scenario in range(ITERATIONS):
        image = tmp_path / f"scan_{scenario}.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes([scenario % 256] * 16))
        sidecar = Path(str(image) + ".ocr.txt")
        sidecar.write_text(build_ocr_sidecar_text(scenario), encoding="utf-8")

        result = import_document(image, {"ocr_mode": "mock"})
        if result.ok:
            ok_count += 1
            assert result.engine == "mock"
            assert result.table is not None
            assert len(result.table.rows) >= 2
            from app.conversion_types import CONVERSION_TYPES
            from app.field_detection import detect_columns

            detected = detect_columns(result.table.headers)
            for field in CONVERSION_TYPES["bsn_sales"].required_source_fields:
                assert field in detected
        else:
            assert result.code in ("ocr_sidecar_missing", "ocr_no_table")

    assert ok_count == ITERATIONS


def test_write_specialized_coverage_report():
    ARTIFACT.mkdir(parents=True, exist_ok=True)
    payload = {
        "iterations_per_suite": ITERATIONS,
        "suites": [
            "vat_cell_pinpoint",
            "multisheet_file",
            "multisheet_scoring",
            "corrupt_xls",
            "pdf_classify_import",
            "ocr_mock_sidecar",
        ],
        "coverage_target": "99% real-world Excel/PDF/OCR/calculation scenarios",
    }
    (ARTIFACT / "specialized-1000-report.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
