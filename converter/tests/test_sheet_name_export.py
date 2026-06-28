from pathlib import Path

import openpyxl
import xlrd

from app.converter import convert_file
from app.excel_io import write_xls_from_template, read_template
from app.conversion_types import get_conversion_type
from tests.test_api import MESSY_SALES_HEADERS


def _write_named_sheet_workbook(path: Path, sheet_name: str) -> None:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    sheet.append(["EzFormat sheet name fixture"])
    sheet.append(MESSY_SALES_HEADERS)
    sheet.append(["HD-NAME-001", "25/12/2025", "Khách lẻ A", "SKU-001", "Hàng A", 2, "1.000", 2000])
    workbook.save(path)


def test_write_xls_from_template_uses_source_sheet_name(tmp_path):
    definition = get_conversion_type("sales_goods")
    template = read_template(definition.template_path)
    output_path = tmp_path / "out.xls"
    write_xls_from_template(
        template,
        [],
        output_path,
        output_sheet_name="BaoCao_BanHang_2025",
    )
    book = xlrd.open_workbook(str(output_path))
    assert book.sheet_names() == ["BaoCao_BanHang_2025"]


def test_convert_file_preserves_source_sheet_name(tmp_path):
    input_path = tmp_path / "input.xlsx"
    _write_named_sheet_workbook(input_path, "Smart_KTSC_OK")
    output_path = tmp_path / "out.xls"
    report = convert_file(input_path, "sales_goods", output_path)
    assert report.ok
    book = xlrd.open_workbook(str(output_path))
    assert book.sheet_names() == ["Smart_KTSC_OK"]
