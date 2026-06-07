"""Excel cell addressing for validation issues."""

from __future__ import annotations


def column_index(headers: list[str], source_header: str | None) -> int | None:
    if not source_header:
        return None
    try:
        return headers.index(source_header)
    except ValueError:
        return None


def excel_cell(row: int | None, column_index: int | None) -> str | None:
    if row is None or column_index is None or column_index < 0:
        return None
    letters = _column_letters(column_index + 1)
    return f"{letters}{row}"


def _column_letters(column_number: int) -> str:
    """1-based column number to Excel letters."""
    result = ""
    n = column_number
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        result = chr(65 + remainder) + result
    return result or "A"
