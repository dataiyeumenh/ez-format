from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import openpyxl
import xlrd
import xlwt

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
        best_name: str | None = None
        best_rows: list[Any] = []
        best_score = (-1, -1)
        best_header_idx = 0
        for name in workbook.sheetnames:
            sheet = workbook[name]
            rows = list(sheet.iter_rows(values_only=True))
            if not rows:
                continue
            header_idx, score = score_header_rows(rows)
            if score > best_score:
                best_score = score
                best_name = name
                best_rows = rows
                best_header_idx = header_idx

        if not best_rows:
            return InputTable(headers=[], rows=[], sheet_name=None, header_row_index=0)

        headers = [
            "" if value is None else str(value).strip() for value in best_rows[best_header_idx]
        ]
        records = _rows_to_records(headers, best_rows[best_header_idx + 1 :])
        return InputTable(
            headers=headers,
            rows=records,
            sheet_name=best_name,
            header_row_index=best_header_idx,
        )
    finally:
        workbook.close()


def _read_xls(path: Path) -> InputTable:
    try:
        book = xlrd.open_workbook(str(path), formatting_info=False)
    except xlrd.XLRDError as exc:
        raise InputReadError("corrupt_xls", f"Corrupt or unsupported .xls file: {exc}") from exc
    except Exception as exc:
        raise InputReadError("corrupt_xls", f"Cannot read .xls file: {exc}") from exc

    best_name: str | None = None
    best_rows: list[Any] = []
    best_score = (-1, -1)
    best_header_idx = 0

    for sheet in book.sheets():
        rows = [[sheet.cell_value(row, col) for col in range(sheet.ncols)] for row in range(sheet.nrows)]
        if not rows:
            continue
        header_idx, score = score_header_rows(rows)
        if score > best_score:
            best_score = score
            best_name = sheet.name
            best_rows = rows
            best_header_idx = header_idx

    if not best_rows:
        return InputTable(headers=[], rows=[], sheet_name=None, header_row_index=0)

    headers = ["" if value is None else str(value).strip() for value in best_rows[best_header_idx]]
    records = _rows_to_records(headers, best_rows[best_header_idx + 1 :])
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
    workbook = xlwt.Workbook(encoding="utf-8")
    sheet = workbook.add_sheet(template.sheet_name[:31] or "Sheet1")
    date_style = xlwt.easyxf(num_format_str="DD/MM/YYYY")

    for row_idx, row in enumerate(template.preamble_rows):
        for col_idx, value in enumerate(row):
            if not is_blank(value):
                sheet.write(row_idx, col_idx, value)

    for col_idx, header in enumerate(template.headers):
        if header:
            sheet.write(template.header_row_index, col_idx, header)

    for record_idx, record in enumerate(output_rows, start=template.header_row_index + 1):
        for col_idx, header in enumerate(template.headers):
            if not header:
                continue
            value = record.get(header, "")
            if isinstance(value, (datetime, date)):
                sheet.write(record_idx, col_idx, value, date_style)
            else:
                sheet.write(record_idx, col_idx, value)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(str(output_path))
