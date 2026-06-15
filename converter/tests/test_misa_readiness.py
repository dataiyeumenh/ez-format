from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import xlwt

from app.excel_io import read_input_table
from app.rule_sources import RULE_SOURCES
from app.rule_normalizers import (
    normalize_text,
    parse_decimal_value,
    parse_vat_rate,
    parse_vietnamese_date,
)
from app.misa_readiness import validate_misa_readiness


def test_rule_sources_are_citable():
    assert RULE_SOURCES
    for source in RULE_SOURCES.values():
        assert source.title
        assert source.url.startswith("https://")
        assert source.verified_at


def test_rule_normalizers_parse_vietnamese_accounting_values():
    assert normalize_text("  A\u00a0  B  ") == "A B"
    assert parse_decimal_value("1,234,567") == Decimal("1234567")
    assert parse_decimal_value("1.234.567") == Decimal("1234567")
    assert parse_decimal_value("1.234,56") == Decimal("1234.56")
    assert parse_decimal_value("1,234.56") == Decimal("1234.56")
    assert parse_decimal_value("(123)") == Decimal("-123")
    assert parse_decimal_value("-") is None
    assert parse_vietnamese_date("01/02/2026") == date(2026, 2, 1)
    assert parse_vietnamese_date("2026-02-01") == date(2026, 2, 1)
    assert parse_vietnamese_date(46023) == date(2026, 1, 1)
    assert parse_vat_rate("KCT") == "NON_TAXABLE"
    assert parse_vat_rate("8%") == Decimal("0.08")


def test_xls_input_reports_formula_cells(tmp_path):
    path = tmp_path / "formula_input.xls"
    book = xlwt.Workbook()
    sheet = book.add_sheet("Data")
    for col, header in enumerate(["Mã hóa đơn", "Mã hàng", "Số lượng", "Đơn giá", "Thành tiền"]):
        sheet.write(0, col, header)
    sheet.write(1, 0, "HD001")
    sheet.write(1, 1, "SP001")
    sheet.write(1, 2, 2)
    sheet.write(1, 3, 100)
    sheet.write(1, 4, xlwt.Formula("C2*D2"))
    book.save(str(path))

    table = read_input_table(path)

    assert table.formula_cells == ["E2"]


def test_readiness_blocks_missing_required_mapping_and_value():
    headers = [
        "Ngày hạch toán (*)",
        "Ngày chứng từ (*)",
        "Số chứng từ (*)",
        "Mã hàng (*)",
    ]
    report = validate_misa_readiness(
        input_rows=1,
        target_template_id="bsn_sales",
        target_headers=headers,
        mapping={"Raw invoice": "Số chứng từ (*)"},
        defaults={},
        formulas={},
        output_rows=[{"Số chứng từ (*)": "HD001", "Mã hàng (*)": ""}],
    )

    assert report.status == "blocked"
    assert report.summary.blocker >= 1
    assert {issue.code for issue in report.issues} >= {
        "required_mapping_missing",
        "required_value_blank",
    }


def test_readiness_uses_decimal_amount_and_vat_rules():
    headers = [
        "Ngày hạch toán (*)",
        "Ngày chứng từ (*)",
        "Số chứng từ (*)",
        "Mã hàng (*)",
        "Số lượng",
        "Đơn giá",
        "Thành tiền",
        "Thuế suất GTGT",
        "Tiền thuế GTGT",
    ]
    base_row = {
        "Ngày hạch toán (*)": "01/07/2026",
        "Ngày chứng từ (*)": "01/07/2026",
        "Số chứng từ (*)": "HD001",
        "Mã hàng (*)": "SP001",
        "Số lượng": "2",
        "Đơn giá": "1.000",
        "Thành tiền": "2.000",
        "Thuế suất GTGT": "8%",
        "Tiền thuế GTGT": "160",
    }

    warning_report = validate_misa_readiness(
        input_rows=1,
        target_template_id="bsn_sales",
        target_headers=headers,
        mapping={
            "Ngày": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
            "Mã HĐ": "Số chứng từ (*)",
            "Mã hàng": "Mã hàng (*)",
        },
        defaults={},
        formulas={},
        output_rows=[base_row],
    )
    assert warning_report.status == "needs_review"
    assert warning_report.summary.warning >= 1
    assert any(issue.code == "vat_8_eligibility_uncertain" for issue in warning_report.issues)

    bad_row = dict(base_row)
    bad_row["Thành tiền"] = "2.500"
    bad_report = validate_misa_readiness(
        input_rows=1,
        target_template_id="bsn_sales",
        target_headers=headers,
        mapping={
            "Ngày": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
            "Mã HĐ": "Số chứng từ (*)",
            "Mã hàng": "Mã hàng (*)",
        },
        defaults={},
        formulas={},
        output_rows=[bad_row],
    )
    assert bad_report.status == "blocked"
    assert any(issue.code == "line_amount_mismatch" for issue in bad_report.issues)


def test_readiness_reports_workbook_and_business_warnings():
    tomorrow = date.today() + timedelta(days=1)
    tomorrow_text = tomorrow.strftime("%d/%m/%Y")
    report = validate_misa_readiness(
        input_rows=2,
        target_template_id="bsn_sales",
        target_headers=[
            "Ngày hạch toán (*)",
            "Ngày chứng từ (*)",
            "Số chứng từ (*)",
            "Tên khách hàng",
            "Mã hàng (*)",
            "Số lượng",
            "Đơn giá",
            "Thành tiền",
            "Mã số thuế",
        ],
        mapping={
            "Ngày": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
            "Mã HĐ": "Số chứng từ (*)",
            "Mã hàng": "Mã hàng (*)",
        },
        defaults={},
        formulas={},
        output_rows=[
            {
                "Ngày hạch toán (*)": tomorrow_text,
                "Ngày chứng từ (*)": tomorrow_text,
                "Số chứng từ (*)": "HD001",
                "Tên khách hàng": "  Công ty  A  ",
                "Mã hàng (*)": "SP001",
                "Số lượng": "1.000",
                "Đơn giá": "0",
                "Thành tiền": "0",
                "Mã số thuế": "",
            }
        ],
        source_headers=["Ngày", "Mã HĐ", "Mã hàng", "Cột dư"],
        hidden_rows=[1],
        formula_cells=["F2"],
        blank_rows_ignored=1,
    )

    codes = {issue.code for issue in report.issues}
    assert {
        "future_date",
        "zero_price_promotion_unclear",
        "buyer_tax_code_missing_optional",
        "hidden_rows_detected",
        "formula_cell_used",
        "blank_row_ignored",
        "unused_source_columns",
        "text_trimmed",
        "number_normalized",
        "date_normalized",
    }.issubset(codes)
    assert report.status == "needs_review"


def test_readiness_detects_additional_rule_ids():
    headers = [
        "Số chứng từ (*)",
        "Ngày chứng từ (*)",
        "Tên khách hàng",
        "Mã hàng (*)",
        "Số lượng",
        "Đơn giá",
        "Thành tiền",
        "Thuế suất GTGT",
        "Tiền thuế GTGT",
        "TK Doanh thu/Có (*)",
    ]
    rows = [
        {
            "Số chứng từ (*)": "HD001",
            "Ngày chứng từ (*)": "01/01/2026",
            "Tên khách hàng": "Khách A",
            "Mã hàng (*)": "SP001",
            "Số lượng": 1,
            "Đơn giá": 100,
            "Thành tiền": 100,
            "Thuế suất GTGT": "5%",
            "Tiền thuế GTGT": 5,
            "TK Doanh thu/Có (*)": "ABC",
        },
        {
            "Số chứng từ (*)": "HD001",
            "Ngày chứng từ (*)": "02/01/2026",
            "Tên khách hàng": "Khách B",
            "Mã hàng (*)": "SP002",
            "Số lượng": 1,
            "Đơn giá": 100,
            "Thành tiền": 100,
            "Thuế suất GTGT": "10%",
            "Tiền thuế GTGT": 10,
            "TK Doanh thu/Có (*)": "5111",
        },
        {
            "Số chứng từ (*)": "",
            "Ngày chứng từ (*)": "01/01/2026",
            "Tên khách hàng": "Khách C",
            "Mã hàng (*)": "SP003",
            "Số lượng": 1,
            "Đơn giá": 100,
            "Thành tiền": 100,
            "Thuế suất GTGT": "10%",
            "Tiền thuế GTGT": 10,
            "TK Doanh thu/Có (*)": "5111",
        },
        {
            "Số chứng từ (*)": "",
            "Ngày chứng từ (*)": "01/01/2026",
            "Tên khách hàng": "Khách C",
            "Mã hàng (*)": "SP003",
            "Số lượng": 1,
            "Đơn giá": 100,
            "Thành tiền": 100,
            "Thuế suất GTGT": "10%",
            "Tiền thuế GTGT": 10,
            "TK Doanh thu/Có (*)": "5111",
        },
    ]

    report = validate_misa_readiness(
        input_rows=len(rows),
        target_template_id="bsn_sales",
        target_headers=headers,
        mapping={
            "Số HĐ": "Số chứng từ (*)",
            "Ngày": "Ngày chứng từ (*)",
            "Mã hàng": "Mã hàng (*)",
            "TK": "TK Doanh thu/Có (*)",
        },
        defaults={},
        formulas={},
        output_rows=rows,
    )

    codes = {issue.code for issue in report.issues}
    assert {
        "vat_5_category_uncertain",
        "account_pattern_unusual",
        "invoice_header_conflict",
        "one_tax_template_mixed_rates",
        "possible_duplicate",
    }.issubset(codes)
    assert report.status == "blocked"


def test_readiness_blocks_vat_8_when_policy_disallows_it():
    report = validate_misa_readiness(
        input_rows=1,
        target_template_id="bsn_sales",
        target_headers=[
            "Số chứng từ (*)",
            "Ngày chứng từ (*)",
            "Mã hàng (*)",
            "Số lượng",
            "Đơn giá",
            "Thành tiền",
            "Thuế suất GTGT",
            "Tiền thuế GTGT",
        ],
        mapping={
            "Số HĐ": "Số chứng từ (*)",
            "Ngày": "Ngày chứng từ (*)",
            "Mã hàng": "Mã hàng (*)",
        },
        defaults={},
        formulas={},
        output_rows=[
            {
                "Số chứng từ (*)": "HD001",
                "Ngày chứng từ (*)": "01/01/2026",
                "Mã hàng (*)": "SP001",
                "Số lượng": 1,
                "Đơn giá": 100,
                "Thành tiền": 100,
                "Thuế suất GTGT": "8%",
                "Tiền thuế GTGT": 8,
            }
        ],
        vat_policy={"allow_8_percent": False},
    )

    assert any(issue.code == "vat_8_not_allowed_by_policy" for issue in report.issues)
    assert report.status == "blocked"


def test_readiness_allows_multi_line_invoice_with_same_header():
    headers = [
        "Mã số thuế người bán",
        "Ký hiệu hóa đơn",
        "Số hóa đơn",
        "Ngày chứng từ (*)",
        "Mã hàng (*)",
        "Số lượng",
        "Đơn giá",
        "Thành tiền",
    ]
    rows = [
        {
            "Mã số thuế người bán": "0100109106",
            "Ký hiệu hóa đơn": "AA/26E",
            "Số hóa đơn": "000001",
            "Ngày chứng từ (*)": "01/01/2026",
            "Mã hàng (*)": "SP001",
            "Số lượng": 1,
            "Đơn giá": 100,
            "Thành tiền": 100,
        },
        {
            "Mã số thuế người bán": "0100109106",
            "Ký hiệu hóa đơn": "AA/26E",
            "Số hóa đơn": "000001",
            "Ngày chứng từ (*)": "01/01/2026",
            "Mã hàng (*)": "SP002",
            "Số lượng": 2,
            "Đơn giá": 50,
            "Thành tiền": 100,
        },
    ]

    report = validate_misa_readiness(
        input_rows=len(rows),
        target_template_id="bsn_sales",
        target_headers=headers,
        mapping={
            "MST": "Mã số thuế người bán",
            "Ký hiệu": "Ký hiệu hóa đơn",
            "Số HĐ": "Số hóa đơn",
            "Ngày": "Ngày chứng từ (*)",
            "Mã hàng": "Mã hàng (*)",
        },
        defaults={},
        formulas={},
        output_rows=rows,
    )

    assert not any(issue.code == "duplicate_invoice_key" for issue in report.issues)
