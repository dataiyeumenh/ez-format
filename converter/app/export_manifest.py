from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from app.conversion_types import get_conversion_type
from app.document_grouping import group_output_rows, stable_draft_id
from app.models import ExportManifestRow, ExportManifestV1
from app.normalization import normalize_header
from app.parsing import parse_decimal


LOCATOR_ALIASES = {
    "document_number": (
        "Số chứng từ (*)",
        "Số phiếu nhập (*)",
        "Số chứng từ",
        "Số phiếu nhập",
    ),
    "invoice_number": ("Số hóa đơn", "Số HĐ", "Số hóa đơn (*)"),
    "document_date": ("Ngày chứng từ (*)", "Ngày chứng từ", "Ngày hạch toán (*)"),
    "invoice_date": ("Ngày hóa đơn", "Ngày HĐ", "Ngày hóa đơn (*)"),
    "partner_code": ("Mã khách hàng", "Mã nhà cung cấp", "Mã đối tượng"),
    "item_code": ("Mã hàng (*)", "Mã dịch vụ (*)", "Mã hàng", "Mã dịch vụ"),
    "amount": ("Thành tiền", "Thành tiền quy đổi", "Tiền hàng", "Tổng tiền thanh toán"),
}


def build_export_manifest(
    *,
    conversion_id: str,
    export_batch_id: str,
    target_template_id: str,
    template_hash: str,
    raw_file_hash: str,
    mapping_profile_id: str,
    mapping_profile_version: int,
    validation_ruleset_version: str,
    output_rows: list[dict[str, Any]],
    row_origins: list[dict[str, Any]],
    mapping_profile_state_hash: str | None = None,
    misa_version: str | None = None,
) -> ExportManifestV1:
    if len(output_rows) != len(row_origins):
        raise ValueError("Mỗi output row phải có đúng một provenance origin")

    direction = _direction(target_template_id)
    locators = [_locator(row) for row in output_rows]
    semantic_rows = [_grouping_values(locator, direction) for locator in locators]
    grouped = group_output_rows(semantic_rows, direction=direction)
    group_by_output_row: dict[int, str] = {}
    document_groups: list[dict[str, Any]] = []

    raw_ids_by_row = [
        _raw_row_ids(raw_file_hash, origin)
        for origin in row_origins
    ]
    for group_key, uses_fallback, prepared_rows in grouped:
        output_row_numbers = [item.source_row for item in prepared_rows]
        document_group_id = "doc-" + stable_draft_id(
            target_template_id,
            group_key,
            output_row_numbers,
        )
        for output_row_number in output_row_numbers:
            group_by_output_row[output_row_number] = document_group_id
        group_raw_ids = list(
            dict.fromkeys(
                raw_id
                for output_row_number in output_row_numbers
                for raw_id in raw_ids_by_row[output_row_number - 1]
            )
        )
        amount_total = _amount_total(
            [locators[output_row_number - 1].get("amount") for output_row_number in output_row_numbers]
        )
        has_complete_provenance = all(
            raw_ids_by_row[output_row_number - 1]
            for output_row_number in output_row_numbers
        )
        document_groups.append(
            {
                "document_group_id": document_group_id,
                "output_row_numbers": output_row_numbers,
                "raw_row_ids": group_raw_ids,
                "line_count": len(output_row_numbers),
                "amount_total": amount_total,
                "group_integrity": (
                    "deterministic"
                    if not uses_fallback and has_complete_provenance
                    else "unknown"
                ),
            }
        )

    rows = [
        ExportManifestRow(
            export_row_id=_stable_id(
                "export-row",
                {"batch": export_batch_id, "row": output_row_number},
            ),
            output_row_number=output_row_number,
            document_group_id=group_by_output_row[output_row_number],
            raw_row_ids=raw_ids_by_row[output_row_number - 1],
            locator=locator,
            line_fingerprint=_stable_id(
                "line",
                _canonical_output_row(output_row),
                length=64,
            ),
        )
        for output_row_number, (output_row, locator) in enumerate(
            zip(output_rows, locators, strict=True),
            start=1,
        )
    ]

    return ExportManifestV1(
        conversion_id=str(conversion_id),
        export_batch_id=str(export_batch_id),
        misa_version=misa_version,
        target_template_id=target_template_id,
        template_hash=template_hash,
        raw_file_hash=raw_file_hash,
        mapping_profile_id=mapping_profile_id,
        mapping_profile_version=int(mapping_profile_version),
        mapping_profile_state_hash=mapping_profile_state_hash,
        validation_ruleset_version=validation_ruleset_version,
        rows=rows,
        document_groups=document_groups,
    )


def _direction(target_template_id: str) -> str:
    kind = get_conversion_type(target_template_id).kind
    return "purchase" if kind.startswith("purchase") else "sales"


def _locator(row: dict[str, Any]) -> dict[str, str | None]:
    normalized_row = {normalize_header(str(key)): value for key, value in row.items()}
    return {
        name: _locator_text(_first_value(normalized_row, aliases), decimal=name == "amount")
        for name, aliases in LOCATOR_ALIASES.items()
    }


def _canonical_output_row(row: dict[str, Any]) -> list[list[Any]]:
    entries = [
        [normalize_header(str(header)), _canonical_value(value)]
        for header, value in row.items()
    ]
    return sorted(
        entries,
        key=lambda item: json.dumps(
            item,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


def _canonical_value(value: Any) -> Any:
    if value is None or value == "":
        return ["blank"]
    if isinstance(value, bool):
        return ["boolean", value]
    if isinstance(value, Decimal):
        return ["scalar", format(value, "f")]
    if isinstance(value, (date, datetime)):
        return ["date", value.isoformat()]
    if isinstance(value, (int, float, str)):
        return ["scalar", str(value)]
    if isinstance(value, dict):
        return [
            "object",
            sorted(
                (str(key), _canonical_value(item))
                for key, item in value.items()
            ),
        ]
    if isinstance(value, (list, tuple)):
        return ["array", [_canonical_value(item) for item in value]]
    return ["scalar", str(value)]


def _first_value(row: dict[str, Any], aliases: tuple[str, ...]) -> Any:
    for alias in aliases:
        normalized = normalize_header(alias)
        if normalized in row and row[normalized] not in (None, ""):
            return row[normalized]
    return None


def _locator_text(value: Any, *, decimal: bool = False) -> str | None:
    if value is None or value == "":
        return None
    if decimal:
        parsed = parse_decimal(value)
        return _decimal_text(parsed) if parsed is not None else None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return _decimal_text(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    return text or None


def _grouping_values(locator: dict[str, str | None], direction: str) -> dict[str, Any]:
    document_number = locator.get("document_number")
    values: dict[str, Any] = {
        "invoice": locator.get("invoice_number") or (document_number if direction == "sales" else None),
        "invoice_date": locator.get("invoice_date"),
        "date": locator.get("document_date"),
    }
    if direction == "purchase":
        values["purchase_receipt"] = document_number
        values["supplier_code"] = locator.get("partner_code")
    else:
        values["customer_code"] = locator.get("partner_code")
    return values


def _raw_row_ids(raw_file_hash: str, origin: dict[str, Any]) -> list[str]:
    sheet = str(origin.get("raw_sheet") or "").strip()
    raw_rows = origin.get("raw_rows")
    if not sheet or not isinstance(raw_rows, list):
        return []
    output: list[str] = []
    for raw_row in raw_rows:
        if isinstance(raw_row, bool):
            continue
        try:
            row_number = int(raw_row)
        except (TypeError, ValueError):
            continue
        if row_number < 1:
            continue
        output.append(
            _stable_id(
                "raw-row",
                {
                    "file": raw_file_hash,
                    "sheet": normalize_header(sheet),
                    "row": row_number,
                },
            )
        )
    return list(dict.fromkeys(output))


def _amount_total(values: list[str | None]) -> str | None:
    parsed = [parse_decimal(value) for value in values]
    if any(value is None for value in parsed):
        return None
    return _decimal_text(sum((value for value in parsed if value is not None), Decimal("0")))


def _decimal_text(value: Decimal) -> str:
    return format(value, "f")


def _stable_id(namespace: str, value: Any, *, length: int = 24) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(f"{namespace}:{payload}".encode("utf-8")).hexdigest()[:length]
