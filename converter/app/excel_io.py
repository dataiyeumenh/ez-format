from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from itertools import islice
from pathlib import Path
from typing import Any

import openpyxl
import xlrd
import xlwt
from xlutils.filter import XLWTWriter

from app.normalization import is_blank


class InputReadError(Exception):
    """Structured failure when reading Excel input."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class InputTable:
    headers: list[str]
    rows: list[dict[str, Any]]
    sheet_name: str | None = None
    header_row_index: int = 0


@dataclass(frozen=True)
class TemplateWorkbook:
    path: Path
    sheet_name: str
    header_row_index: int
    headers: list[str]
    preamble_rows: list[list[Any]]


def find_header_row(sheet: xlrd.sheet.Sheet) -> int:
    best_score: tuple[int, int, int] | None = None
    best_row = 0
    max_scan_rows = min(sheet.nrows, 30)

    for row_idx in range(max_scan_rows):
        values = [str(sheet.cell_value(row_idx, col)).strip() for col in range(sheet.ncols)]
        non_empty = sum(1 for value in values if value)
        keyword_hits = sum(
            1
            for value in values
            if any(
                keyword in value.lower()
                for keyword in (
                    "ngày",
                    "mã",
                    "số",
                    "hình thức",
                    "phương thức",
                    "đơn giá",
                    "thành tiền",
                )
            )
        )
        score = (keyword_hits, non_empty, -row_idx)
        if best_score is None or score > best_score:
            best_score = score
            best_row = row_idx

    return best_row


def read_template(path: Path) -> TemplateWorkbook:
    book = xlrd.open_workbook(str(path), formatting_info=False)
    sheet = book.sheet_by_index(0)
    header_row_index = find_header_row(sheet)
    headers = [str(sheet.cell_value(header_row_index, col)).strip() for col in range(sheet.ncols)]
    preamble_rows = [
        [sheet.cell_value(row, col) for col in range(sheet.ncols)] for row in range(header_row_index)
    ]
    return TemplateWorkbook(
        path=path,
        sheet_name=sheet.name,
        header_row_index=header_row_index,
        headers=headers,
        preamble_rows=preamble_rows,
    )


def read_input_table(path: Path) -> InputTable:
    suffix = path.suffix.lower()
    if suffix == ".xlsx":
        return _read_xlsx(path)
    if suffix == ".xls":
        return _read_xls(path)
    raise InputReadError("unsupported_format", "Only .xls and .xlsx files are supported.")


def score_header_rows(rows: list[Any]) -> tuple[int, int]:
    best_score: tuple[int, int] | None = None
    best_idx = 0
    for idx, row in enumerate(rows[:30]):
        values = ["" if value is None else str(value).strip() for value in row]
        non_empty = sum(1 for value in values if value)
        keyword_hits = sum(
            1
            for value in values
            if any(
                keyword in value.lower()
                for keyword in ("mã", "ngày", "thời gian", "tên", "số lượng", "đơn giá", "thành tiền")
            )
        )
        score = (keyword_hits, non_empty)
        if best_score is None or score > best_score:
            best_score = score
            best_idx = idx
    return best_idx, best_score or (0, 0)


def _read_xlsx(path: Path) -> InputTable:
    try:
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception as exc:
        raise InputReadError("corrupt_xlsx", f"Cannot read Excel workbook: {exc}") from exc
    try:
        preferred_sheet = _known_purchase_detail_sheet(workbook)
        if preferred_sheet is not None:
            header_row = next(preferred_sheet.iter_rows(min_row=1, max_row=1, values_only=True), ())
            headers = ["" if value is None else str(value).strip() for value in header_row]
            return InputTable(
                headers=headers,
                rows=_rows_to_records(
                    headers,
                    preferred_sheet.iter_rows(min_row=2, values_only=True),
                ),
                sheet_name=preferred_sheet.title,
                header_row_index=0,
            )

        best_name: str | None = None
        best_score = (-1, -1)
        best_header_idx = 0
        for name in workbook.sheetnames:
            sheet = workbook[name]
            rows = list(islice(sheet.iter_rows(values_only=True), 30))
            if not rows:
                continue
            header_idx, score = score_header_rows(rows)
            if score > best_score:
                best_score = score
                best_name = name
                best_header_idx = header_idx

        if not best_name:
            return InputTable(headers=[], rows=[], sheet_name=None, header_row_index=0)

        sheet = workbook[best_name]
        header_row = next(
            sheet.iter_rows(
                min_row=best_header_idx + 1,
                max_row=best_header_idx + 1,
                values_only=True,
            ),
            (),
        )
        headers = [
            "" if value is None else str(value).strip() for value in header_row
        ]
        records = _rows_to_records(
            headers,
            sheet.iter_rows(min_row=best_header_idx + 2, values_only=True),
        )
        return InputTable(
            headers=headers,
            rows=records,
            sheet_name=best_name,
            header_row_index=best_header_idx,
        )
    finally:
        workbook.close()


def _known_purchase_detail_sheet(workbook: openpyxl.Workbook):
    """Select the partner's line-detail sheet only when its schema markers match."""
    if "Smart_KTSC_OK" not in workbook.sheetnames:
        return None
    sheet = workbook["Smart_KTSC_OK"]
    first_row = next(sheet.iter_rows(min_row=1, max_row=1, values_only=True), ())
    headers = {str(value).strip() for value in first_row if value is not None}
    required_markers = {"SR_HD", "SOCT", "MATHANG", "Phân loại", "TTVND"}
    return sheet if required_markers.issubset(headers) else None


def _read_xls(path: Path) -> InputTable:
    try:
        book = xlrd.open_workbook(str(path), formatting_info=False)
    except xlrd.XLRDError as exc:
        raise InputReadError("corrupt_xls", f"Corrupt or unsupported .xls file: {exc}") from exc
    except Exception as exc:
        raise InputReadError("corrupt_xls", f"Cannot read .xls file: {exc}") from exc

    best_name: str | None = None
    best_sheet: xlrd.sheet.Sheet | None = None
    best_score = (-1, -1)
    best_header_idx = 0

    for sheet in book.sheets():
        rows = [
            [sheet.cell_value(row, col) for col in range(sheet.ncols)]
            for row in range(min(sheet.nrows, 30))
        ]
        if not rows:
            continue
        header_idx, score = score_header_rows(rows)
        if score > best_score:
            best_score = score
            best_name = sheet.name
            best_sheet = sheet
            best_header_idx = header_idx

    if best_sheet is None:
        return InputTable(headers=[], rows=[], sheet_name=None, header_row_index=0)

    headers = [
        "" if value is None else str(value).strip()
        for value in best_sheet.row_values(best_header_idx)
    ]
    records = _rows_to_records(
        headers,
        (
            [best_sheet.cell_value(row, col) for col in range(best_sheet.ncols)]
            for row in range(best_header_idx + 1, best_sheet.nrows)
        ),
    )
    return InputTable(
        headers=headers,
        rows=records,
        sheet_name=best_name,
        header_row_index=best_header_idx,
    )


def _rows_to_records(headers: list[str], rows: list[Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in rows:
        values = list(row)
        if all(is_blank(value) for value in values):
            continue
        record: dict[str, Any] = {}
        for idx, header in enumerate(headers):
            if not header:
                continue
            record[header] = values[idx] if idx < len(values) else None
        if any(not is_blank(value) for value in record.values()):
            records.append(record)
    return records


def write_xls_from_template(
    template: TemplateWorkbook,
    output_rows: list[dict[str, Any]],
    output_path: Path,
) -> None:
    source_book = xlrd.open_workbook(str(template.path), formatting_info=True)
    source_sheet = source_book.sheet_by_name(template.sheet_name)
    workbook = xlwt.Workbook(encoding="utf-8")
    sheet = workbook.add_sheet(template.sheet_name)
    styles = _xlwt_styles_for(source_book)
    data_start_row = template.header_row_index + 1
    output_end_row = data_start_row + len(output_rows)

    if output_end_row > 65536:
        raise ValueError("Output exceeds the .xls row limit of 65,536 rows.")

    _copy_column_layout(source_sheet, sheet, len(template.headers))
    _copy_static_template_rows(
        source_sheet=source_sheet,
        output_sheet=sheet,
        styles=styles,
        max_col_count=len(template.headers),
        data_start_row=data_start_row,
    )
    for row_idx in range(data_start_row, min(source_sheet.nrows, max(output_end_row, 12))):
        _copy_row_layout(
            source_sheet,
            sheet,
            row_idx,
            fallback_row=data_start_row,
        )
    data_styles = [
        _style_for_cell(
            source_sheet,
            styles,
            data_start_row,
            col_idx,
            fallback_row=data_start_row,
        )
        for col_idx in range(len(template.headers))
    ]

    for record_idx, record in enumerate(output_rows, start=data_start_row):
        _copy_row_layout(
            source_sheet,
            sheet,
            record_idx,
            fallback_row=data_start_row,
        )
        for col_idx, header in enumerate(template.headers):
            if not header:
                continue
            value = record.get(header, "")
            sheet.write(record_idx, col_idx, _xls_cell_value(value), data_styles[col_idx])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(str(output_path))


def _copy_column_layout(
    source_sheet: xlrd.sheet.Sheet,
    output_sheet: xlwt.Worksheet.Worksheet,
    max_col_count: int,
) -> None:
    for col_idx in range(max_col_count):
        source_col = source_sheet.colinfo_map.get(col_idx)
        if source_col is None:
            continue
        output_col = output_sheet.col(col_idx)
        output_col.width = source_col.width
        output_col.hidden = source_col.hidden
        output_col.level = source_col.outline_level
        output_col.collapse = source_col.collapsed


def _copy_static_template_rows(
    *,
    source_sheet: xlrd.sheet.Sheet,
    output_sheet: xlwt.Worksheet.Worksheet,
    styles: list[xlwt.Style.XFStyle],
    max_col_count: int,
    data_start_row: int,
) -> None:
    merged_top_left: dict[tuple[int, int], tuple[int, int, int, int]] = {}
    merged_covered: set[tuple[int, int]] = set()
    for rlo, rhi, clo, chi in source_sheet.merged_cells:
        if rlo >= data_start_row:
            continue
        merged_top_left[(rlo, clo)] = (rlo, rhi, clo, chi)
        for row_idx in range(rlo, rhi):
            for col_idx in range(clo, chi):
                if (row_idx, col_idx) != (rlo, clo):
                    merged_covered.add((row_idx, col_idx))

    for row_idx in range(data_start_row):
        _copy_row_layout(source_sheet, output_sheet, row_idx, fallback_row=row_idx)
        for col_idx in range(max_col_count):
            if (row_idx, col_idx) in merged_covered:
                continue
            value = (
                source_sheet.cell_value(row_idx, col_idx)
                if row_idx < source_sheet.nrows and col_idx < source_sheet.ncols
                else ""
            )
            style = _style_for_cell(
                source_sheet,
                styles,
                row_idx,
                col_idx,
                fallback_row=min(row_idx, max(source_sheet.nrows - 1, 0)),
            )
            merged = merged_top_left.get((row_idx, col_idx))
            if merged:
                rlo, rhi, clo, chi = merged
                output_sheet.write_merge(rlo, rhi - 1, clo, chi - 1, value, style)
            else:
                output_sheet.write(row_idx, col_idx, value, style)


def _copy_row_layout(
    source_sheet: xlrd.sheet.Sheet,
    output_sheet: xlwt.Worksheet.Worksheet,
    row_idx: int,
    *,
    fallback_row: int,
) -> None:
    source_row = source_sheet.rowinfo_map.get(row_idx) or source_sheet.rowinfo_map.get(fallback_row)
    if source_row is None:
        return
    output_row = output_sheet.row(row_idx)
    output_row.height = source_row.height
    output_row.height_mismatch = True


def _xlwt_styles_for(book: xlrd.book.Book) -> list[xlwt.Style.XFStyle]:
    writer = XLWTWriter()
    writer.start()
    writer.workbook(book, str(book))
    return list(writer.style_list)


def _style_for_cell(
    sheet: xlrd.sheet.Sheet,
    styles: list[xlwt.Style.XFStyle],
    row_idx: int,
    col_idx: int,
    fallback_row: int,
) -> xlwt.Style.XFStyle:
    source_row = row_idx if row_idx < sheet.nrows else min(fallback_row, sheet.nrows - 1)
    try:
        xf_index = sheet.cell_xf_index(source_row, col_idx)
    except IndexError:
        xf_index = sheet.cell_xf_index(min(fallback_row, sheet.nrows - 1), col_idx)
    if xf_index is None or xf_index >= len(styles):
        return xlwt.Style.default_style
    return styles[xf_index]


def _xls_cell_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return _excel_serial(value)
    if value is None:
        return ""
    return value


def _clear_stale_template_rows(
    source_sheet: xlrd.sheet.Sheet,
    output_sheet: xlwt.Worksheet.Worksheet,
    styles: list[xlwt.Style.XFStyle],
    start_row: int,
    max_col_count: int,
    fallback_row: int,
) -> None:
    last_value_row = _last_nonblank_row(source_sheet, start_row, max_col_count)
    for row_idx in range(start_row, last_value_row + 1):
        for col_idx in range(max_col_count):
            if col_idx >= source_sheet.ncols:
                continue
            if is_blank(source_sheet.cell_value(row_idx, col_idx)):
                continue
            style = _style_for_cell(
                source_sheet,
                styles,
                row_idx,
                col_idx,
                fallback_row=fallback_row,
            )
            output_sheet.write(row_idx, col_idx, "", style)


def _last_nonblank_row(sheet: xlrd.sheet.Sheet, start_row: int, max_col_count: int) -> int:
    for row_idx in range(sheet.nrows - 1, start_row - 1, -1):
        values = sheet.row_values(row_idx, 0, min(max_col_count, sheet.ncols))
        if any(not is_blank(value) for value in values):
            return row_idx
    return start_row - 1


def _excel_serial(value: datetime | date) -> float:
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime(value.year, value.month, value.day)
    epoch = datetime(1899, 12, 30)
    delta = dt - epoch
    return delta.days + delta.seconds / 86400 + delta.microseconds / 86400 / 1_000_000
