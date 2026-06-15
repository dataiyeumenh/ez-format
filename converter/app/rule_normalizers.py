from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any


BLANK_MARKERS = {"", "-", "—", "–", "none", "null", "nan"}


def normalize_text(value: Any) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def normalize_key(value: Any) -> str:
    text = normalize_text(value).replace("Đ", "D").replace("đ", "d")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_")


def is_blank_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return normalize_text(value).lower() in BLANK_MARKERS
    return False


def parse_decimal_value(value: Any) -> Decimal | None:
    if is_blank_value(value):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return Decimal(1 if value else 0)
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))

    text = normalize_text(value)
    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative = True
        text = text[1:-1].strip()
    text = text.replace(" ", "").replace("\u00a0", "")
    text = re.sub(r"[^\d,.\-]", "", text)
    if text.startswith("-"):
        negative = True
        text = text[1:]
    if not text:
        return None

    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        groups = text.split(",")
        if len(groups) > 1 and all(len(group) == 3 for group in groups[1:]):
            text = "".join(groups)
        else:
            text = text.replace(",", ".")
    elif "." in text:
        groups = text.split(".")
        if len(groups) > 1 and all(len(group) == 3 for group in groups[1:]):
            text = "".join(groups)

    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    return -number if negative else number


def parse_vietnamese_date(value: Any) -> date | None:
    if is_blank_value(value):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value <= 0:
            return None
        return date(1899, 12, 30) + timedelta(days=int(value))

    text = normalize_text(value)
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d/%m/%y", "%d-%m-%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_vat_rate(value: Any) -> Decimal | str | None:
    if is_blank_value(value):
        return None
    text = normalize_text(value)
    key = normalize_key(text)
    if key in {"kct", "khong_chiu_thue", "khong_thue", "non_taxable"}:
        return "NON_TAXABLE"
    if key in {"khong_ke_khai", "khong_phai_ke_khai"}:
        return "NON_TAXABLE"
    number = parse_decimal_value(text.replace("%", ""))
    if number is None:
        return None
    if number > 1:
        number = number / Decimal("100")
    return number


def round_money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("1"))

