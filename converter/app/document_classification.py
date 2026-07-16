from __future__ import annotations

from typing import Any

from app.normalization import normalize_header
from app.voucher_models import FieldTrust, VoucherDirection, VoucherNature


GOODS_MARKERS = {
    "hang_hoa",
    "hanghoa",
    "vat_tu",
    "nguyen_vat_lieu",
    "inventory",
    "goods",
    "product",
}
SERVICE_MARKERS = {
    "dich_vu",
    "dichvu",
    "service",
    "phi_dich_vu",
    "chi_phi",
}


def classify_line_nature(
    explicit_value: Any,
    *,
    item_code: Any = None,
    quantity: Any = None,
    unit: Any = None,
    item_name: Any = None,
) -> tuple[VoucherNature, FieldTrust]:
    normalized = normalize_header(explicit_value)
    if normalized in GOODS_MARKERS or any(marker in normalized for marker in GOODS_MARKERS):
        return "goods", "verified"
    if normalized in SERVICE_MARKERS or any(marker in normalized for marker in SERVICE_MARKERS):
        return "service", "verified"

    name = normalize_header(item_name)
    if any(marker in name for marker in SERVICE_MARKERS):
        return "service", "suggested"
    if item_code not in (None, "") and quantity not in (None, "") and unit not in (None, ""):
        return "goods", "suggested"
    return "unknown", "missing"


def aggregate_nature(
    values: list[tuple[VoucherNature, FieldTrust]],
) -> tuple[VoucherNature, FieldTrust]:
    known = {nature for nature, _ in values if nature != "unknown"}
    if len(known) > 1:
        return "mixed", "conflict"
    if len(known) == 1:
        nature = next(iter(known))
        trust: FieldTrust = (
            "verified" if all(item_trust == "verified" for _, item_trust in values) else "suggested"
        )
        return nature, trust
    return "unknown", "missing"


def detect_direction(
    *,
    mode: str,
    workspace_tax_code: str,
    seller_tax_code: str,
    buyer_tax_code: str,
    has_supplier_fields: bool,
    has_customer_fields: bool,
) -> tuple[VoucherDirection, FieldTrust]:
    normalized_mode = normalize_header(mode)
    if normalized_mode in {"purchase", "mua", "mua_vao"}:
        return "purchase", "supported"
    if normalized_mode in {"sales", "sale", "ban", "ban_ra"}:
        return "sales", "supported"

    workspace = _tax_code(workspace_tax_code)
    seller = _tax_code(seller_tax_code)
    buyer = _tax_code(buyer_tax_code)
    if workspace:
        seller_match = bool(seller and workspace == seller)
        buyer_match = bool(buyer and workspace == buyer)
        if buyer_match and not seller_match:
            return "purchase", "verified"
        if seller_match and not buyer_match:
            return "sales", "verified"
        if buyer_match and seller_match:
            return "unknown", "conflict"

    if has_supplier_fields and not has_customer_fields:
        return "purchase", "suggested"
    if has_customer_fields and not has_supplier_fields:
        return "sales", "suggested"
    return "unknown", "missing"


def _tax_code(value: Any) -> str:
    return "".join(character for character in str(value or "") if character.isdigit())
