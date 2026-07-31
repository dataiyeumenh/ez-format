from datetime import datetime

import xlrd

from app.excel_io import write_xls_from_template
from app import misa_templates
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


def _row_layout(row_info) -> tuple:
    return (
        row_info.height,
        row_info.has_default_height,
        row_info.height_mismatch,
        row_info.hidden,
        row_info.outline_level,
        row_info.outline_group_starts_ends,
        row_info.additional_space_above,
        row_info.additional_space_below,
    )


def _column_layout(column_info) -> tuple:
    return (
        column_info.width,
        column_info.hidden,
        column_info.outline_level,
        column_info.collapsed,
    )


def _assert_full_structure_equal(
    source_book,
    output_book,
    header_row_index: int,
    schema_column_count: int,
) -> None:
    assert output_book.sheet_names() == source_book.sheet_names()
    source = source_book.sheet_by_index(0)
    output = output_book.sheet_by_index(0)
    assert output.nrows == source.nrows
    assert output.ncols == source.ncols
    assert output.default_row_height == source.default_row_height == 300
    assert output.default_row_height_mismatch == source.default_row_height_mismatch
    assert sorted(output.merged_cells) == sorted(source.merged_cells)
    assert set(output.colinfo_map) == set(source.colinfo_map)
    for column in source.colinfo_map:
        assert _column_layout(output.colinfo_map[column]) == _column_layout(
            source.colinfo_map[column]
        )
    assert set(output.rowinfo_map) == set(source.rowinfo_map)
    for row in source.rowinfo_map:
        assert _row_layout(output.rowinfo_map[row]) == _row_layout(source.rowinfo_map[row])
    covered_merged_cells = {
        (row, column)
        for rlo, rhi, clo, chi in source.merged_cells
        for row in range(rlo, rhi)
        for column in range(clo, chi)
        if (row, column) != (rlo, clo)
    }
    for row in range(min(source.nrows, 12)):
        for column in range(schema_column_count):
            if (row, column) in covered_merged_cells:
                continue
            if (
                source.cell_value(row, column) in (None, "")
                and row not in {header_row_index, header_row_index + 1}
            ):
                continue
            assert _style_signature(output_book, output, row, column) == _style_signature(
                source_book,
                source,
                row,
                column,
            )


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


def test_export_preserves_supported_layout_structure_for_all_misa_templates(tmp_path):
    for template in list_misa_templates():
        output_path = tmp_path / f"layout-{template.id}.xls"
        row = {header: "" for header in template.headers}

        write_xls_from_template(template.workbook, [row], output_path)

        source_book = xlrd.open_workbook(
            file_contents=template.workbook.file_contents,
            formatting_info=True,
        )
        output_book = xlrd.open_workbook(str(output_path), formatting_info=True)
        _assert_full_structure_equal(
            source_book,
            output_book,
            template.workbook.header_row_index,
            len(template.headers),
        )


def test_multi_row_export_uses_corresponding_template_row_styles_with_fallback(tmp_path):
    for template in list_misa_templates():
        output_path = tmp_path / f"multi-row-{template.id}.xls"
        rows = [{header: "" for header in template.headers} for _ in range(4)]
        source_book = xlrd.open_workbook(
            file_contents=template.workbook.file_contents,
            formatting_info=True,
        )
        source_sheet = source_book.sheet_by_index(0)
        data_start = template.workbook.header_row_index + 1

        write_xls_from_template(template.workbook, rows, output_path)

        output_book = xlrd.open_workbook(str(output_path), formatting_info=True)
        output_sheet = output_book.sheet_by_index(0)
        for offset in range(len(rows)):
            output_row = data_start + offset
            source_row = output_row if output_row < source_sheet.nrows else data_start
            assert _style_signatures(
                output_book,
                output_sheet,
                output_row,
                len(template.headers),
            ) == _style_signatures(
                source_book,
                source_sheet,
                source_row,
                len(template.headers),
            ), (template.id, offset)
            assert output_sheet.rowinfo_map[output_row].height == (
                source_sheet.rowinfo_map[source_row].height
            ), (template.id, offset)


def test_record_probe_exposes_xlutils_advanced_biff_loss(tmp_path):
    template = next(item for item in list_misa_templates() if item.id == "sales_goods")
    output_path = tmp_path / "biff-capability-probe.xls"

    write_xls_from_template(
        template.workbook,
        [{header: "" for header in template.headers}],
        output_path,
    )

    source_probe = misa_templates.probe_misa_template_biff(
        template.workbook.file_contents
    )
    output_probe = misa_templates.probe_misa_template_biff(output_path.read_bytes())
    for feature in (
        "formulas",
        "defined_names",
        "drawings_objects",
        "data_validations",
    ):
        assert source_probe[feature]["record_count"] > 0
        assert output_probe[feature]["record_count"] == 0


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


def test_export_preserves_template_tail_layout(tmp_path):
    template = next(item for item in list_misa_templates() if item.id == "bsn_sales")
    output_path = tmp_path / "trimmed_tail.xls"
    row = {header: "" for header in template.headers}
    row["Số chứng từ (*)"] = "TRIMMED"

    write_xls_from_template(template.workbook, [row], output_path)

    sheet = xlrd.open_workbook(str(output_path), formatting_info=True).sheet_by_index(0)
    source = xlrd.open_workbook(
        file_contents=template.workbook.file_contents,
        formatting_info=True,
    ).sheet_by_index(0)
    assert sheet.nrows == source.nrows
    assert len(sheet.rowinfo_map) == len(source.rowinfo_map)
