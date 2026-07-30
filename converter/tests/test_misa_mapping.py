from __future__ import annotations

from decimal import Decimal

import pytest

from app.excel_io import InputTable
from app.misa_mapping import (
    apply_mapping,
    evaluate_formula,
    heuristic_suggestion,
    sanitize_mapping_for_template,
    transform_value,
)
from app.parsing import parse_number


@pytest.mark.parametrize("left", ["", None, "khong-phai-so"])
def test_multiply_formula_does_not_coerce_blank_or_invalid_operand_to_zero(left):
    assert evaluate_formula(
        "${Số lượng} * ${Đơn giá}",
        {"Số lượng": left, "Đơn giá": 100},
    ) == ""


def test_multiply_formula_preserves_numeric_zero():
    assert evaluate_formula(
        "${Số lượng} * ${Đơn giá}",
        {"Số lượng": 0, "Đơn giá": 100},
    ) == 0


@pytest.mark.parametrize("invoice_number", ["HD_2026", "INV_001", "000001_02"])
def test_real_invoice_numeric_suffix_is_preserved(invoice_number):
    assert transform_value(invoice_number, "Số chứng từ (*)") == invoice_number


def test_explicit_system_row_marker_is_removed_from_invoice_number():
    assert (
        transform_value("HD_2026__EZ_FORMAT_ROW_12", "Số chứng từ (*)")
        == "HD_2026"
    )


def test_numeric_mapping_preserves_unsafe_decimal_precision():
    raw_value = "9007199254740993.0000000001"

    assert parse_number(raw_value) == Decimal(raw_value)
    assert transform_value(raw_value, "Đơn giá") == Decimal(raw_value)


def test_formula_preserves_unsafe_decimal_precision():
    assert evaluate_formula(
        "${Số lượng} * ${Đơn giá}",
        {"Số lượng": "1", "Đơn giá": "9007199254740993.0000000001"},
    ) == Decimal("9007199254740993.0000000001")


def test_known_exporter_duplicate_suffix_is_removed_without_generic_stripping():
    assert (
        transform_value("HDO1764925151999_77832", "Số chứng từ (*)")
        == "HDO1764925151999"
    )


def test_purchase_heuristic_requires_manual_inventory_account_mapping():
    table = InputTable(
        headers=["Phân loại"],
        rows=[{"Phân loại": "Dịch vụ"}, {"Phân loại": "Hàng hóa"}],
        sheet_name="Smart_KTSC_OK",
        header_row_index=0,
    )
    target_headers = ["Hình thức mua hàng", "TK kho/TK chi phí (*)"]

    suggestion = heuristic_suggestion(
        table,
        "misa_purchase_domestic",
        target_headers,
    )
    rows = apply_mapping(
        table,
        target_headers,
        suggestion.mapping,
        suggestion.defaults,
        suggestion.formulas,
    )

    assert suggestion.mapping["Phân loại"] == "Hình thức mua hàng"
    assert all(row["TK kho/TK chi phí (*)"] == "" for row in rows)
    assert any("ánh xạ thủ công" in warning for warning in suggestion.warnings)


def test_purchase_explicit_account_default_is_preserved_for_all_classifications():
    table = InputTable(
        headers=["Phân loại"],
        rows=[{"Phân loại": "Dịch vụ"}, {"Phân loại": "Hàng hóa"}],
        sheet_name="Smart_KTSC_OK",
        header_row_index=0,
    )
    target_headers = ["Hình thức mua hàng", "TK kho/TK chi phí (*)"]
    suggestion = heuristic_suggestion(
        table,
        "misa_purchase_domestic",
        target_headers,
    )

    rows = apply_mapping(
        table,
        target_headers,
        suggestion.mapping,
        {**suggestion.defaults, "TK kho/TK chi phí (*)": "154"},
        suggestion.formulas,
    )

    assert [row["TK kho/TK chi phí (*)"] for row in rows] == ["154", "154"]


def test_heuristic_confidence_does_not_count_hardcoded_required_defaults():
    table = InputTable(
        headers=["Mô tả"],
        rows=[{"Mô tả": "Hàng hóa"}],
        sheet_name="raw",
        header_row_index=0,
    )

    suggestion = heuristic_suggestion(
        table,
        "misa_purchase_domestic",
        ["Hình thức mua hàng", "TK công nợ/TK tiền (*)"],
    )

    assert suggestion.confidence == 0.45
    assert "TK công nợ/TK tiền (*)" not in suggestion.defaults
    assert any("TK công nợ/TK tiền (*)" in warning for warning in suggestion.warnings)


def test_purchase_sanitizer_removes_classification_account_inference_only():
    sanitized = sanitize_mapping_for_template(
        "misa_purchase_domestic",
        {
            "Phân loại": ["Hình thức mua hàng", "TK kho/TK chi phí (*)"],
            "TK Nợ đã duyệt": "TK kho/TK chi phí (*)",
        },
    )

    assert sanitized == {
        "Phân loại": "Hình thức mua hàng",
        "TK Nợ đã duyệt": "TK kho/TK chi phí (*)",
    }
