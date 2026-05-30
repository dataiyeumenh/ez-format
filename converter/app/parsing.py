from __future__ import annotations

from datetime import date, datetime
from typing import Any


def parse_number(value: Any) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value

    text = str(value).strip()
    if not text:
        return None
    text = text.replace("₫", "").replace("VND", "").replace("VNĐ", "").strip()
    text = text.replace(" ", "").replace("\u00a0", "")
    text = _normalize_number_separators(text)

    try:
        number = float(text)
    except ValueError:
        return None
    return int(number) if number.is_integer() else number


def _normalize_number_separators(text: str) -> str:
    comma_count = text.count(",")
    dot_count = text.count(".")
    if comma_count and dot_count:
        last_comma = text.rfind(",")
        last_dot = text.rfind(".")
        decimal_separator = "," if last_comma > last_dot else "."
        thousands_separator = "." if decimal_separator == "," else ","
        return text.replace(thousands_separator, "").replace(decimal_separator, ".")

    separator = "," if comma_count else "." if dot_count else ""
    if not separator:
        return text

    if text.count(separator) > 1:
        return text.replace(separator, "")

    before, after = text.split(separator, 1)
    if before and after.isdigit() and len(after) == 3:
        return before + after
    return text.replace(separator, ".")


def parse_date(value: Any) -> datetime | date | float | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value
    if isinstance(value, (int, float)):
        return value

    text = str(value).strip()
    if not text:
        return None

    formats = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
        "%d-%m-%Y",
    )
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None
