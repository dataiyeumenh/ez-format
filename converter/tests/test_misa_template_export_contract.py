from datetime import datetime

import xlrd

from app.excel_io import write_xls_from_template
from app.misa_templates import list_misa_templates


def _col_widths(sheet, limit: int) -> list[int | None]:
    return [getattr(sheet.colinfo_map.get(col), "width", None) for col in range(limit)]


def _row_heights(sheet, limit: int) -> list[int | None]:
    return [getattr(sheet.rowinfo_map.get(row), "height", None) for row in range(limit)]


def _style_signature(book, sheet, row: int, col: int) -> tuple:
    xf = book.xf_list[sheet.cell_xf_index(row, col)]
    font = book.font_list[xf.font_index]
    fmt = book.format_map[xf.format_key].format_str
    return (
        fmt,
        font.name,
        font.bold,
        font.height,
        xf.alignment.hor_align,
        xf.alignment.vert_align,
        xf.alignment.text_wrapped,
        xf.border.left_line_style,
        xf.border.right_line_style,
        xf.border.top_line_style,
        xf.border.bottom_line_style,
        xf.background.fill_pattern,
        xf.background.pattern_colour_index,
        xf.background.background_colour_index,
    )


def _style_signatures(book, sheet, row: int, limit: int) -> list[tuple]:
    return [_style_signature(book, sheet, row, col) for col in range(limit)]


def test_export_preserves_preamble_alignment_for_all_misa_templates(tmp_path):
    for template in list_misa_templates():
        output_path = tmp_path / f"{template.id}.xls"
        write_xls_from_template(template.workbook, [], output_path)

        sheet = xlrd.open_workbook(str(output_path)).sheet_by_index(0)
        exported_headers = [
            str(value).strip()
            for value in sheet.row_values(template.workbook.header_row_index)[: len(template.headers)]
        ]
        assert exported_headers == template.headers

        for row_idx, preamble_row in enumerate(template.workbook.preamble_rows):
            for col_idx, expected in enumerate(preamble_row):
                if expected in (None, ""):
                    continue
                assert sheet.cell_value(row_idx, col_idx) == expected, (
                    template.id,
                    row_idx + 1,
                    col_idx + 1,
                    expected,
                    sheet.cell_value(row_idx, col_idx),
                )


def test_bsn_sales_augmented_lot_expiry_do_not_shift_cost_preamble(tmp_path):
    template = next(item for item in list_misa_templates() if item.id == "bsn_sales")
    output_path = tmp_path / "bsn_sales.xls"
    write_xls_from_template(template.workbook, [], output_path)

    sheet = xlrd.open_workbook(str(output_path)).sheet_by_index(0)
    headers = sheet.row_values(template.workbook.header_row_index)
    assert headers.index("Số lô") == headers.index("% thuế xuất khẩu") + 1
    assert headers.index("Hạn sử dụng") == headers.index("Số lô") + 1
    assert sheet.cell_value(6, headers.index("TK thuế GTGT")) == ""
    assert sheet.cell_value(6, headers.index("Mã kho")) == "Chi tiết giá vốn"


def test_bsn_sales_export_copies_real_59_column_template_formatting(tmp_path):
    template = next(item for item in list_misa_templates() if item.id == "bsn_sales")
    output_path = tmp_path / "bsn_sales_formatted.xls"
    row = {header: "" for header in template.headers}
    row["Số chứng từ (*)"] = "HDTEST"

    write_xls_from_template(template.workbook, [row], output_path)

    source_book = xlrd.open_workbook(str(template.workbook.path), formatting_info=True)
    source_sheet = source_book.sheet_by_index(0)
    output_book = xlrd.open_workbook(str(output_path), formatting_info=True)
    output_sheet = output_book.sheet_by_index(0)

    assert source_sheet.ncols == 59
    assert output_sheet.ncols == 59
    assert "Số lô" in output_sheet.row_values(template.workbook.header_row_index)
    assert "Hạn sử dụng" in output_sheet.row_values(template.workbook.header_row_index)
    assert output_sheet.merged_cells == source_sheet.merged_cells
    assert _col_widths(output_sheet, 59) == _col_widths(source_sheet, 59)
    assert _row_heights(output_sheet, 12) == _row_heights(source_sheet, 12)
    assert _style_signatures(
        output_book, output_sheet, template.workbook.header_row_index, 12
    ) == _style_signatures(
        source_book, source_sheet, template.workbook.header_row_index, 12
    )


def test_export_writes_iso_date_strings_as_excel_date_cells(tmp_path):
    template = next(item for item in list_misa_templates() if item.id == "bsn_sales")
    output_path = tmp_path / "bsn_sales_dates.xls"
    row = {header: "" for header in template.headers}
    row["Số chứng từ (*)"] = "HD-DATE-001"
    row["Ngày hạch toán (*)"] = "2025-12-25T17:23:44.267000"
    row["Ngày chứng từ (*)"] = "2025-12-25T17:23:44.267000"
    row["Hạn sử dụng"] = "2029-07-01T00:00:00"

    write_xls_from_template(template.workbook, [row], output_path)

    book = xlrd.open_workbook(str(output_path), formatting_info=True)
    sheet = book.sheet_by_index(0)
    headers = sheet.row_values(template.workbook.header_row_index)
    data_row = template.workbook.header_row_index + 1

    for header, expected in (
        ("Ngày hạch toán (*)", datetime(2025, 12, 25, 17, 23, 44, 267000)),
        ("Ngày chứng từ (*)", datetime(2025, 12, 25, 17, 23, 44, 267000)),
        ("Hạn sử dụng", datetime(2029, 7, 1)),
    ):
        cell = sheet.cell(data_row, headers.index(header))
        assert cell.ctype == xlrd.XL_CELL_DATE
        assert xlrd.xldate_as_datetime(cell.value, book.datemode) == expected


def test_export_clears_stale_template_data_rows(tmp_path):
    template = next(item for item in list_misa_templates() if item.id == "bsn_sales")
    output_path = tmp_path / "one_row.xls"
    row = {header: "" for header in template.headers}
    row["Số chứng từ (*)"] = "ONLY_ONE"

    write_xls_from_template(template.workbook, [row], output_path)

    sheet = xlrd.open_workbook(str(output_path)).sheet_by_index(0)
    headers = sheet.row_values(template.workbook.header_row_index)
    invoice_col = headers.index("Số chứng từ (*)")
    assert sheet.cell_value(template.workbook.header_row_index + 1, invoice_col) == "ONLY_ONE"
    stale_row = template.workbook.header_row_index + 2
    if sheet.nrows > stale_row:
        assert sheet.cell_value(stale_row, invoice_col) == ""


def test_export_does_not_copy_blank_template_tail(tmp_path):
    template = next(item for item in list_misa_templates() if item.id == "bsn_sales")
    output_path = tmp_path / "trimmed_tail.xls"
    row = {header: "" for header in template.headers}
    row["Số chứng từ (*)"] = "TRIMMED"

    write_xls_from_template(template.workbook, [row], output_path)

    sheet = xlrd.open_workbook(str(output_path), formatting_info=True).sheet_by_index(0)
    assert sheet.nrows <= 12
    assert len(sheet.rowinfo_map) <= 128
