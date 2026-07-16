from __future__ import annotations

from typing import Any

from app.master_data_resolver import resolve_master_data
from app.voucher_models import FieldProvenance, SourceReference, VoucherField


def source_field(
    value: Any,
    *,
    sheet: str,
    row: int,
    header: str | None,
    filled_down: bool = False,
) -> VoucherField:
    if value in (None, ""):
        return VoucherField(value=None, trust="missing")
    return VoucherField(
        value=value,
        trust="supported" if filled_down else "verified",
        provenance=[
            FieldProvenance(
                source="source_fill_down" if filled_down else "source_direct",
                references=[SourceReference(sheet=sheet, row=row, header=header)],
            )
        ],
    )


def derived_field(value: Any, *, note: str) -> VoucherField:
    return VoucherField(
        value=value,
        trust="supported",
        provenance=[FieldProvenance(source="deterministic_derived", note=note)],
    )


def apply_master_data_to_drafts(
    drafts: list[Any],
    context: dict[str, Any] | None,
) -> None:
    if not context:
        return
    for draft in drafts:
        _resolve_header_partner(draft.header, "supplier", "supplier_code", "supplier_tax_code", context)
        _resolve_header_partner(draft.header, "customer", "customer_code", "customer_tax_code", context)
        for line in draft.lines:
            _resolve_field(line.fields.get("item_code"), "item", "Mã hàng (*)", context)
            _resolve_field(line.fields.get("unit"), "unit", "ĐVT", context)
            for field_name in (
                "inventory_account",
                "payable_account",
                "debit_account",
                "credit_account",
            ):
                _resolve_field(
                    line.fields.get(field_name),
                    "account",
                    "TK kho/TK chi phí (*)",
                    context,
                )


def _resolve_header_partner(
    header: dict[str, VoucherField],
    catalog_type: str,
    code_field: str,
    tax_field: str,
    context: dict[str, Any],
) -> None:
    code = header.get(code_field)
    tax = header.get(tax_field)
    source = code if code and code.value not in (None, "") else tax
    if not source or source.value in (None, ""):
        return
    target = _resolved_master_data_field(
        source,
        catalog_type,
        "Mã nhà cung cấp" if catalog_type == "supplier" else "Mã khách hàng",
        context,
    )
    if target:
        header[code_field] = target


def _resolve_field(
    field: VoucherField | None,
    catalog_type: str,
    target_header: str,
    context: dict[str, Any],
) -> None:
    if not field or field.value in (None, ""):
        return
    resolved = _resolved_master_data_field(
        field,
        catalog_type,
        target_header,
        context,
    )
    if resolved:
        field.value = resolved.value
        field.trust = resolved.trust
        field.provenance = resolved.provenance


def _resolved_master_data_field(
    field: VoucherField,
    catalog_type: str,
    target_header: str,
    context: dict[str, Any],
) -> VoucherField | None:
    result = resolve_master_data(
        [{target_header: field.value}],
        context,
        source_system="reconstruction",
    )
    resolution = next(
        (
            item
            for item in result.resolutions
            if item.catalog_type == catalog_type and item.status == "verified"
        ),
        None,
    )
    if not resolution or not resolution.target_code:
        return None
    references = [
        reference
        for provenance in field.provenance
        for reference in provenance.references
    ]
    source = (
        "confirmed_alias"
        if resolution.match_method == "confirmed_alias"
        else "workspace_master_data"
    )
    return VoucherField(
        value=resolution.target_code,
        trust="verified",
        provenance=[
            FieldProvenance(
                source=source,
                references=references,
                note=f"Đối chiếu {catalog_type}: {resolution.match_method}",
            )
        ],
    )
