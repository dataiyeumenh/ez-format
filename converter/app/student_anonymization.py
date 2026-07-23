from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from openpyxl import load_workbook
from xlrd import open_workbook
from xlutils.copy import copy as copy_xls_workbook


ANONYMIZATION_CATEGORIES = (
    "company",
    "counterparty",
    "tax_code",
    "address",
    "email",
    "phone",
    "bank_account",
    "document_number",
)

_TEXT_PREFIXES = {
    "company": "COMPANY",
    "counterparty": "COUNTERPARTY",
    "address": "ADDRESS",
}
_NUMERIC_PREFIXES = {
    "tax_code": "TAX",
    "phone": "PHONE",
    "bank_account": "BANK",
    "document_number": "DOC",
}


class AnonymizationExportError(ValueError):
    """Raised when a generated workbook still contains confidential content."""

    def __init__(self, matched_categories: Iterable[str]) -> None:
        self.matched_categories = tuple(matched_categories)
        super().__init__(
            "Cannot export workbook with confidential values in: "
            + ", ".join(self.matched_categories)
        )


@dataclass(frozen=True)
class AnonymizedWorkbook:
    content: bytes
    filename: str
    replaced_categories: tuple[str, ...]
    warnings: tuple[str, ...] = ()


class AnonymizationSession:
    def __init__(self, session_id: str, secret: str | bytes) -> None:
        self.session_id = str(session_id or "").strip()
        if not self.session_id:
            raise ValueError("session_id is required")
        secret_bytes = secret if isinstance(secret, bytes) else str(secret or "").encode()
        if not secret_bytes:
            raise ValueError("secret is required")
        self._secret = secret_bytes
        self._replacements: dict[tuple[str, str], str] = {}

    def replace(self, category: str, value: Any):
        normalized_category = _validate_category(category)
        if value is None:
            return None
        source = str(value)
        if not source.strip():
            return source
        canonical = source.strip().casefold()
        cache_key = (normalized_category, canonical)
        if cache_key not in self._replacements:
            digest = hmac.new(
                self._secret,
                f"{self.session_id}\0{normalized_category}\0{canonical}".encode(
                    "utf-8"
                ),
                hashlib.sha256,
            ).digest()
            self._replacements[cache_key] = _replacement_for(
                normalized_category,
                source,
                digest,
            )
        return self._replacements[cache_key]

    anonymize = replace


def scan_confidential_values(
    payload: Any,
    confidential_values: Mapping[str, Iterable[Any]],
) -> tuple[str, ...]:
    searchable_values = tuple(
        value.casefold() for value in _iter_text_values(payload) if value.strip()
    )
    matches: list[str] = []
    for category in ANONYMIZATION_CATEGORIES:
        if category not in confidential_values:
            continue
        _validate_category(category)
        originals = (
            str(value).strip().casefold()
            for value in _confidential_value_items(confidential_values[category])
            if value is not None and str(value).strip()
        )
        if any(
            original in candidate
            for original in originals
            for candidate in searchable_values
        ):
            matches.append(category)
    return tuple(matches)


def anonymize_workbook_bytes(
    *,
    filename: str,
    content: bytes,
    session: AnonymizationSession,
    confidential_values: Mapping[str, Iterable[Any]],
    full_document_numbers: bool = False,
) -> AnonymizedWorkbook:
    """Return a newly serialized, scanner-gated workbook without writing the source."""
    normalized_filename = str(filename or "").strip()
    extension = Path(normalized_filename).suffix.lower()
    if extension not in {".xlsx", ".xls"}:
        raise ValueError("Only .xlsx and .xls workbooks can be anonymized")
    if not isinstance(content, bytes) or not content:
        raise ValueError("Workbook content is required")

    active_values = _active_confidential_values(
        confidential_values,
        full_document_numbers=full_document_numbers,
    )
    if extension == ".xlsx":
        exported, replaced_categories = _anonymize_xlsx(content, session, active_values)
        warnings: tuple[str, ...] = ()
    else:
        exported, replaced_categories = _anonymize_xls(content, session, active_values)
        warnings = (
            "XLS export may flatten unsupported workbook structures; verify formatting before sharing.",
        )

    matches = scan_confidential_values(
        _workbook_values(exported, extension), active_values
    )
    if matches:
        raise AnonymizationExportError(matches)
    return AnonymizedWorkbook(
        content=exported,
        filename=_export_filename(normalized_filename),
        replaced_categories=tuple(
            category for category in ANONYMIZATION_CATEGORIES if category in replaced_categories
        ),
        warnings=warnings,
    )


def _active_confidential_values(
    confidential_values: Mapping[str, Iterable[Any]],
    *,
    full_document_numbers: bool,
) -> dict[str, tuple[Any, ...]]:
    active: dict[str, tuple[Any, ...]] = {}
    for category, values in confidential_values.items():
        normalized_category = _validate_category(category)
        if normalized_category == "document_number" and not full_document_numbers:
            continue
        active[normalized_category] = tuple(_confidential_value_items(values))
    return active


def _confidential_value_items(values: Iterable[Any] | Any) -> Iterable[Any]:
    if isinstance(values, (str, bytes, bytearray)):
        return (values,)
    return values


def _anonymize_xlsx(
    content: bytes,
    session: AnonymizationSession,
    confidential_values: Mapping[str, Iterable[Any]],
) -> tuple[bytes, set[str]]:
    workbook = load_workbook(BytesIO(content), data_only=False)
    replaced_categories: set[str] = set()
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows():
            for cell in row:
                replacement = _replacement_for_cell(
                    cell.value, session, confidential_values
                )
                if replacement is not None:
                    cell.value, category = replacement
                    replaced_categories.add(category)
    stream = BytesIO()
    workbook.save(stream)
    return stream.getvalue(), replaced_categories


def _anonymize_xls(
    content: bytes,
    session: AnonymizationSession,
    confidential_values: Mapping[str, Iterable[Any]],
) -> tuple[bytes, set[str]]:
    source = open_workbook(file_contents=content, formatting_info=True)
    workbook = copy_xls_workbook(source)
    replaced_categories: set[str] = set()
    for sheet_index, source_sheet in enumerate(source.sheets()):
        target_sheet = workbook.get_sheet(sheet_index)
        for row_index in range(source_sheet.nrows):
            for column_index in range(source_sheet.ncols):
                replacement = _replacement_for_cell(
                    source_sheet.cell_value(row_index, column_index),
                    session,
                    confidential_values,
                )
                if replacement is not None:
                    target_sheet.write(row_index, column_index, replacement[0])
                    # xlutils copies the original XF table; restore the source cell's entry after writing.
                    target_sheet._Worksheet__rows[row_index]._Row__cells[
                        column_index
                    ].xf_idx = source_sheet.cell(row_index, column_index).xf_index
                    replaced_categories.add(replacement[1])
    stream = BytesIO()
    workbook.save(stream)
    return stream.getvalue(), replaced_categories


def _replacement_for_cell(
    value: Any,
    session: AnonymizationSession,
    confidential_values: Mapping[str, Iterable[Any]],
) -> tuple[str, str] | None:
    if not isinstance(value, str) or value.startswith("="):
        return None
    candidate = value.casefold()
    for category in ANONYMIZATION_CATEGORIES:
        for original in confidential_values.get(category, ()):
            if original is None:
                continue
            source = str(original).strip()
            if source and source.casefold() in candidate:
                return (
                    re.sub(
                        re.escape(source),
                        session.replace(category, source),
                        value,
                        flags=re.IGNORECASE,
                    ),
                    category,
                )
    return None


def _workbook_values(content: bytes, extension: str) -> list[list[list[Any]]]:
    if extension == ".xlsx":
        workbook = load_workbook(BytesIO(content), data_only=False)
        return [
            [[cell.value for cell in row] for row in worksheet.iter_rows()]
            for worksheet in workbook.worksheets
        ]
    workbook = open_workbook(file_contents=content)
    return [
        [
            [sheet.cell_value(row_index, column_index) for column_index in range(sheet.ncols)]
            for row_index in range(sheet.nrows)
        ]
        for sheet in workbook.sheets()
    ]


def _export_filename(filename: str) -> str:
    source = Path(filename)
    return f"{source.stem}-anonymized{source.suffix.lower()}"


def _replacement_for(category: str, source: str, digest: bytes) -> str:
    token = digest.hex()[:12].upper()
    if category in _TEXT_PREFIXES:
        return f"{_TEXT_PREFIXES[category]}-{token}"
    if category == "email":
        return f"student-{digest.hex()[:12]}@example.invalid"
    if category in _NUMERIC_PREFIXES:
        return f"{_NUMERIC_PREFIXES[category]}-{_numeric_token(source, digest)}"
    raise ValueError(f"Unsupported anonymization category: {category}")


def _numeric_token(source: str, digest: bytes) -> str:
    source_digits = "".join(character for character in source if character.isdigit())
    length = max(8, len(source_digits))
    leading_zeroes = len(source_digits) - len(source_digits.lstrip("0"))
    leading_zeroes = min(leading_zeroes, max(0, length - 1))
    generated = "".join(str(byte % 10) for byte in digest)
    while len(generated) < length:
        generated += generated
    return ("0" * leading_zeroes + generated)[:length]


def _validate_category(category: str) -> str:
    normalized = str(category or "").strip().lower()
    if normalized not in ANONYMIZATION_CATEGORIES:
        raise ValueError(f"Unsupported anonymization category: {category}")
    return normalized


def _iter_text_values(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from _iter_text_values(item)
    elif isinstance(value, Iterable) and not isinstance(value, (bytes, bytearray)):
        for item in value:
            yield from _iter_text_values(item)
    elif value is not None and not isinstance(value, (bytes, bytearray)):
        yield str(value)
