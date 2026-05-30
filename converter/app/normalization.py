from __future__ import annotations

import re
import unicodedata
from typing import Any


def normalize_header(value: object) -> str:
    text = "" if value is None else str(value)
    text = text.strip().replace("%", " percent ")
    text = text.replace("Đ", "D").replace("đ", "d")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_")


def normalize_record_keys(record: dict[str, Any]) -> dict[str, Any]:
    return {normalize_header(key): value for key, value in record.items()}


def is_blank(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False
