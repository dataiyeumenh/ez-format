from pathlib import Path

import openpyxl

from app.converter import convert_file, validate_file


HEADERS = [
    "Mã hóa đơn",
    "Thời gian",
    "Tên khách hàng",
    "Mã hàng",
    "Tên hàng",
    "Số lượng",
    "Đơn giá",
    "Giảm giá %",
    "Giảm giá",
    "Thành tiền",
    "Tổng tiền hàng",
    "Giảm giá hóa đơn",
    "% VAT",
    "Tiền thuế",
    "Thu khác",
    "Khách cần trả",
]


def _write_sales_workbook(path: Path, rows: list[list[object]]) -> Path:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(HEADERS)
    for row in rows:
        sheet.append(row)
    workbook.save(path)
    return path


def _base_row(**overrides: object) -> list[object]:
    values = {
        "Mã hóa đơn": "HD001",
        "Thời gian": "2025-12-25",
        "Tên khách hàng": "Khách A",
        "Mã hàng": "SP001",
        "Tên hàng": "Sản phẩm A",
        "Số lượng": 2,
        "Đơn giá": 100,
        "Giảm giá %": 0,
        "Giảm giá": 0,
        "Thành tiền": 200,
        "Tổng tiền hàng": 200,
        "Giảm giá hóa đơn": 0,
        "% VAT": 10,
        "Tiền thuế": 20,
        "Thu khác": 0,
        "Khách cần trả": 220,
    }
    values.update(overrides)
    return [values[header] for header in HEADERS]


def _warning_by_code(report, code: str):
    return next(warning for warning in report.warnings if warning.code == code)


def test_validate_warns_when_line_amount_does_not_match_quantity_price_discount(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "wrong_line_amount.xlsx",
        [_base_row(**{"Số lượng": 2, "Đơn giá": 50, "Giảm giá": 0, "Thành tiền": 90})],
    )

    report = validate_file(input_path, "bsn_sales")

    warning = _warning_by_code(report, "calculation_line_amount_mismatch")
    assert warning.row == 2
    assert warning.invoice == "HD001"
    assert warning.field == "line_amount"
    assert warning.expected == 100
    assert warning.actual == 90
    assert warning.delta == -10
    assert warning.source_header == "Thành tiền"
    assert warning.cell == "J2"


def test_validate_warns_when_discount_percent_does_not_match_discount_amount(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "wrong_discount.xlsx",
        [
            _base_row(
                **{
                    "Số lượng": 2,
                    "Đơn giá": 100,
                    "Giảm giá %": 10,
                    "Giảm giá": 30,
                    "Thành tiền": 170,
                    "Tổng tiền hàng": 170,
                    "Tiền thuế": 17,
                    "Khách cần trả": 187,
                }
            )
        ],
    )

    report = validate_file(input_path, "bsn_sales")

    warning = _warning_by_code(report, "calculation_discount_mismatch")
    assert warning.field == "discount_amount"
    assert warning.expected == 20
    assert warning.actual == 30
    assert warning.delta == 10


def test_validate_warns_when_vat_amount_does_not_match_taxable_amount_and_rate(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "wrong_vat.xlsx",
        [_base_row(**{"Số lượng": 1, "Đơn giá": 100, "Thành tiền": 100, "Tổng tiền hàng": 100, "Tiền thuế": 12})],
    )

    report = validate_file(input_path, "bsn_sales")

    warning = _warning_by_code(report, "calculation_vat_mismatch")
    assert warning.field == "vat_amount"
    assert warning.expected == 10
    assert warning.actual == 12
    assert warning.delta == 2
    assert warning.source_header == "Tiền thuế"
    assert warning.cell == "N2"


def test_validate_warns_when_invoice_subtotal_does_not_match_sum_of_lines(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "wrong_invoice_subtotal.xlsx",
        [
            _base_row(**{"Mã hàng": "SP001", "Số lượng": 1, "Đơn giá": 100, "Thành tiền": 100, "Tổng tiền hàng": 140}),
            _base_row(**{"Mã hàng": "SP002", "Số lượng": 1, "Đơn giá": 50, "Thành tiền": 50, "Tổng tiền hàng": 140}),
        ],
    )

    report = validate_file(input_path, "bsn_sales")

    warning = _warning_by_code(report, "calculation_invoice_subtotal_mismatch")
    assert warning.row == 2
    assert warning.invoice == "HD001"
    assert warning.field == "invoice_subtotal"
    assert warning.expected == 150
    assert warning.actual == 140
    assert warning.delta == -10


def test_validate_warns_when_payable_does_not_match_invoice_amounts(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "wrong_payable.xlsx",
        [
            _base_row(
                **{
                    "Số lượng": 1,
                    "Đơn giá": 100,
                    "Thành tiền": 100,
                    "Tổng tiền hàng": 100,
                    "Giảm giá hóa đơn": 10,
                    "Tiền thuế": 10,
                    "Thu khác": 5,
                    "Khách cần trả": 100,
                }
            )
        ],
    )

    report = validate_file(input_path, "bsn_sales")

    warning = _warning_by_code(report, "calculation_payable_mismatch")
    assert warning.field == "payable"
    assert warning.expected == 105
    assert warning.actual == 100
    assert warning.delta == -5


def test_validate_does_not_calculate_line_amount_from_zero_placeholder_operands(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "zero_placeholder.xlsx",
        [
            _base_row(
                **{
                    "Số lượng": 804,
                    "Đơn giá": 0,
                    "Thành tiền": 2_905_880,
                    "Tổng tiền hàng": 2_905_880,
                    "Tiền thuế": 0,
                    "Khách cần trả": 2_905_880,
                }
            )
        ],
    )

    report = validate_file(input_path, "bsn_sales")

    assert not any(
        warning.code == "calculation_line_amount_mismatch" for warning in report.warnings
    )


def test_validate_accepts_line_amount_explained_by_displayed_unit_price_rounding(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "rounded_unit_price.xlsx",
        [
            _base_row(
                **{
                    "Số lượng": 1500,
                    "Đơn giá": 213.33,
                    "Thành tiền": 320_000,
                    "Tổng tiền hàng": 320_000,
                    "Tiền thuế": 0,
                    "Khách cần trả": 320_000,
                }
            )
        ],
    )

    report = validate_file(input_path, "bsn_sales")

    assert not any(
        warning.code == "calculation_line_amount_mismatch" for warning in report.warnings
    )


def test_convert_blocks_calculation_warnings_until_override_is_set(tmp_path):
    input_path = _write_sales_workbook(
        tmp_path / "bad_convert.xlsx",
        [_base_row(**{"Số lượng": 2, "Đơn giá": 50, "Giảm giá": 0, "Thành tiền": 90})],
    )
    output_path = tmp_path / "blocked.xls"

    blocked = convert_file(input_path, "bsn_sales", output_path)

    assert blocked.ok is True
    assert any(warning.code == "calculation_line_amount_mismatch" for warning in blocked.warnings)
    assert not output_path.exists()

    allowed = convert_file(
        input_path,
        "bsn_sales",
        output_path,
        {"allow_calculation_warnings": True},
    )

    assert allowed.ok is True
    assert output_path.exists()
