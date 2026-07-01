from pathlib import Path

import openpyxl
import xlrd

from app.conversion_types import CONVERSION_TYPES
from app.converter import convert_file, validate_file
from app.excel_io import find_header_row, read_template


ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "fixtures" / "samples"
TEMPLATES = ROOT / "fixtures" / "templates"


def _header_map(sheet):
    header_row = find_header_row(sheet)
    return {
        str(sheet.cell_value(header_row, col)).strip(): col
        for col in range(sheet.ncols)
        if str(sheet.cell_value(header_row, col)).strip()
    }


def _find_row_by_value(sheet, column_index: int, value: str) -> int:
    for row_index in range(sheet.nrows):
        if sheet.cell_value(row_index, column_index) == value:
            return row_index
    raise AssertionError(f"Cannot find {value!r} in column {column_index}.")


def test_all_conversion_templates_are_registered_and_have_required_headers():
    assert set(CONVERSION_TYPES) == {
        "bsn_sales",
        "bsn_purchase",
        "misa_purchase_domestic",
        "sales_goods",
        "sales_service",
        "purchase_goods",
        "purchase_service",
    }

    for conversion_type, definition in CONVERSION_TYPES.items():
        template = read_template(definition.template_path)
        headers = template.headers

        for header in definition.required_output_headers:
            assert header in headers, f"{conversion_type} missing template header {header}"


def test_validate_raw_sales_sample_detects_columns_and_row_count():
    report = validate_file(SAMPLES / "raw_sales_sample.xlsx", "bsn_sales")

    assert report.ok is True
    assert report.summary.input_rows == 1930
    assert report.summary.output_rows == 1930
    assert report.summary.error_count == 0
    assert report.detected_columns["invoice"] == "Mã hóa đơn"
    assert report.detected_columns["item_code"] == "Mã hàng"


def test_validate_missing_required_column_returns_structured_error(tmp_path):
    bad_file = tmp_path / "missing_invoice.xlsx"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["Thời gian", "Mã khách hàng", "Tên khách hàng", "Mã hàng", "Số lượng", "Đơn giá"])
    sheet.append(["2025-12-25", "KH001", "Khách A", "SP001", 1, 100000])
    workbook.save(bad_file)

    report = validate_file(bad_file, "bsn_sales")

    assert report.ok is False
    assert report.summary.error_count == 1
    assert report.errors[0].field == "invoice"
    assert report.errors[0].code == "missing_required_column"


def test_purchase_template_is_exposed_but_sales_input_is_blocked():
    report = validate_file(SAMPLES / "raw_sales_sample.xlsx", "purchase_goods")

    assert report.ok is False
    assert any(error.field == "supplier_code" for error in report.errors)
    assert any(error.field == "purchase_receipt" for error in report.errors)


def test_convert_raw_sales_to_bsn_sales_xls_matches_golden_key_fields(tmp_path):
    output_path = tmp_path / "converted.xls"

    report = convert_file(SAMPLES / "raw_sales_sample.xlsx", "bsn_sales", output_path)

    assert report.ok is True
    assert output_path.exists()

    converted_book = xlrd.open_workbook(str(output_path))
    converted_sheet = converted_book.sheet_by_index(0)
    converted_headers = _header_map(converted_sheet)
    golden_book = xlrd.open_workbook(str(SAMPLES / "golden_sales_import.xls"))
    golden_sheet = golden_book.sheet_by_index(0)
    golden_headers = _header_map(golden_sheet)

    comparable_fields = [
        "Hình thức bán hàng",
        "Phương thức thanh toán",
        "Kiêm phiếu xuất kho",
        "Lập kèm hóa đơn",
        "Đã lập hóa đơn",
        "Số chứng từ (*)",
        "Số phiếu xuất",
        "Mã khách hàng",
        "Tên khách hàng",
        "Diễn giải/Lý do nộp",
        "Lý do xuất",
        "Mã hàng (*)",
        "Tên hàng",
        "Là dòng ghi chú",
        "Hàng khuyến mại",
        "TK Tiền/Chi phí/Nợ (*)",
        "TK Doanh thu/Có (*)",
        "ĐVT",
        "Số lượng",
        "Đơn giá",
        "Thành tiền",
        "Tiền chiết khấu",
        "TK chiết khấu",
        "TK thuế GTGT",
        "Mã kho",
        "TK giá vốn",
        "TK Kho",
    ]

    for field in comparable_fields:
        assert converted_sheet.cell_value(8, converted_headers[field]) == golden_sheet.cell_value(
            8, golden_headers[field]
        )

    converted_row = _find_row_by_value(
        converted_sheet, converted_headers["Số chứng từ (*)"], "HD046174"
    )
    golden_row = _find_row_by_value(golden_sheet, golden_headers["Số chứng từ (*)"], "HD046174")
    assert converted_sheet.cell_value(converted_row, converted_headers["Số lượng"]) == 10
    assert converted_sheet.cell_value(
        converted_row, converted_headers["Tiền chiết khấu"]
    ) == golden_sheet.cell_value(golden_row, golden_headers["Tiền chiết khấu"])
