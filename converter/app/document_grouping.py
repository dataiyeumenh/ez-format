from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from app.normalization import is_blank, normalize_header


SAFE_FILL_DOWN_FIELDS = (
    "invoice",
    "invoice_symbol",
    "invoice_date",
    "date",
    "purchase_receipt",
    "supplier_code",
    "supplier_tax_code",
    "supplier_name",
    "customer_code",
    "customer_tax_code",
    "customer_name",
    "seller_tax_code",
    "buyer_tax_code",
    "payment_method",
)

CANONICAL_TO_SEMANTIC = {
    "invoice_number": "invoice",
    "invoice_symbol": "invoice_symbol",
    "invoice_date": "invoice_date",
    "posting_date": "date",
    "purchase_receipt": "purchase_receipt",
    "supplier_tax_code": "supplier_tax_code",
    "customer_tax_code": "customer_tax_code",
    "supplier_code": "supplier_code",
    "supplier_name": "supplier_name",
    "customer_code": "customer_code",
    "customer_name": "customer_name",
    "payment_method": "payment_method",
}


@dataclass(frozen=True)
class PreparedRow:
    source_row: int
    direct: dict[str, Any]
    effective: dict[str, Any]
    filled_fields: frozenset[str]


def prepare_rows(
    rows: list[dict[str, Any]],
    detected_columns: dict[str, str],
    *,
    header_row_index: int,
    fill_down_fields: list[str] | None = None,
) -> list[PreparedRow]:
    previous: dict[str, Any] = {}
    output: list[PreparedRow] = []
    for index, record in enumerate(rows):
        direct = {
            semantic: record.get(header)
            for semantic, header in detected_columns.items()
        }
        effective = dict(direct)
        filled: set[str] = set()
        configured_fill_down = {
            CANONICAL_TO_SEMANTIC.get(field, field)
            for field in (fill_down_fields or SAFE_FILL_DOWN_FIELDS)
        }
        for semantic in configured_fill_down:
            if semantic not in detected_columns:
                continue
            if is_blank(effective.get(semantic)) and not is_blank(previous.get(semantic)):
                effective[semantic] = previous[semantic]
                filled.add(semantic)
            elif not is_blank(effective.get(semantic)):
                previous[semantic] = effective[semantic]
        output.append(
            PreparedRow(
                source_row=header_row_index + index + 2,
                direct=direct,
                effective=effective,
                filled_fields=frozenset(filled),
            )
        )
    return output


def group_prepared_rows(
    rows: list[PreparedRow],
    *,
    direction: str,
    grouping_keys: list[str] | None = None,
) -> list[tuple[str, bool, list[PreparedRow]]]:
    groups: dict[str, list[PreparedRow]] = {}
    fallback: dict[str, bool] = {}
    order: list[str] = []
    for row in rows:
        key, uses_fallback = document_group_key(
            row,
            direction=direction,
            grouping_keys=grouping_keys,
        )
        if key not in groups:
            groups[key] = []
            fallback[key] = uses_fallback
            order.append(key)
        groups[key].append(row)
    return [(key, fallback[key], groups[key]) for key in order]


def group_output_rows(
    rows: list[dict[str, Any]],
    *,
    direction: str,
) -> list[tuple[str, bool, list[PreparedRow]]]:
    prepared = [
        PreparedRow(
            source_row=index,
            direct=dict(row),
            effective=dict(row),
            filled_fields=frozenset(),
        )
        for index, row in enumerate(rows, start=1)
    ]
    return group_prepared_rows(prepared, direction=direction)


def document_group_key(
    row: PreparedRow,
    *,
    direction: str,
    grouping_keys: list[str] | None = None,
) -> tuple[str, bool]:
    values = row.effective
    if grouping_keys:
        resolved = [
            _text(values.get(CANONICAL_TO_SEMANTIC.get(field, field)))
            for field in grouping_keys
        ]
        if any(resolved):
            return (
                "profile:" + direction + ":" + ":".join(resolved),
                any(not value for value in resolved),
            )
    invoice = _text(values.get("invoice"))
    symbol = _text(values.get("invoice_symbol"))
    if direction == "purchase":
        counterparty = _text(
            values.get("seller_tax_code")
            or values.get("supplier_tax_code")
            or values.get("supplier_code")
        )
    else:
        counterparty = _text(
            values.get("buyer_tax_code")
            or values.get("customer_tax_code")
            or values.get("customer_code")
        )

    if invoice and counterparty and (direction != "purchase" or symbol):
        return f"strong:{direction}:{counterparty}:{symbol}:{invoice}", False

    receipt = _text(values.get("purchase_receipt"))
    posting_date = _text(values.get("invoice_date") or values.get("date"))
    if invoice or receipt:
        return f"fallback:{direction}:{counterparty}:{symbol}:{invoice or receipt}:{posting_date}", True
    return f"row:{direction}:{row.source_row}", True


def stable_draft_id(sheet_name: str, group_key: str, source_rows: list[int]) -> str:
    payload = json.dumps(
        {
            "sheet": normalize_header(sheet_name),
            "group": group_key,
            "rows": source_rows,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()
