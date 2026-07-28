from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


@dataclass(frozen=True)
class VatBasisResult:
    ok: bool
    severity: str
    basis: str
    expected: str | None = None
    actual: str | None = None
    message: str = ""


@dataclass(frozen=True)
class VatTaxableBaseResolution:
    taxable_base: Decimal | None
    status: str = "resolved"


SUPPORTED_BASES = {
    "line_after_discount",
    "line_before_discount",
    "invoice_taxable_base",
}
VAT_BASIS_TOLERANCE = Decimal("1")


def resolve_vat_taxable_base(
    *,
    amount: object | None,
    discount: object | None,
    vat_rate: object | None,
    vat_amount: object | None,
    basis: str | None,
    invoice_taxable_base: object | None = None,
) -> VatTaxableBaseResolution:
    normalized_basis = str(basis or "").strip().lower()
    if normalized_basis and normalized_basis not in SUPPORTED_BASES:
        return VatTaxableBaseResolution(None, "unknown")

    after_discount = _decimal(amount)
    discount_amount = _decimal(discount)
    if normalized_basis == "line_after_discount":
        return VatTaxableBaseResolution(after_discount)
    if normalized_basis == "line_before_discount":
        if after_discount is None:
            return VatTaxableBaseResolution(None)
        return VatTaxableBaseResolution(after_discount + (discount_amount or Decimal("0")))
    if normalized_basis == "invoice_taxable_base":
        invoice_base = _decimal(invoice_taxable_base)
        return VatTaxableBaseResolution(
            invoice_base, "resolved" if invoice_base is not None else "unknown"
        )

    if after_discount is None or discount_amount is None or discount_amount == 0:
        return VatTaxableBaseResolution(after_discount)

    rate = _decimal(vat_rate)
    actual = _decimal(vat_amount)
    if rate is None or actual is None or rate == 0 or _money(actual) == 0:
        return VatTaxableBaseResolution(after_discount)

    before_discount = after_discount + discount_amount
    actual_money = _money(actual)
    after_matches = abs(_money(after_discount * rate) - actual_money) <= VAT_BASIS_TOLERANCE
    before_matches = abs(_money(before_discount * rate) - actual_money) <= VAT_BASIS_TOLERANCE
    if after_matches:
        return VatTaxableBaseResolution(after_discount)
    if before_matches:
        return VatTaxableBaseResolution(before_discount)
    return VatTaxableBaseResolution(None, "ambiguous")


def validate_vat_basis(
    basis: str,
    *,
    taxable_base: object | None = None,
    vat_rate: object | None = None,
    vat: object | None = None,
) -> VatBasisResult:
    normalized_basis = str(basis or "").strip().lower()
    if normalized_basis not in SUPPORTED_BASES:
        return VatBasisResult(
            ok=False,
            severity="warning",
            basis="unknown",
            message="Chưa xác định được cơ sở tính thuế GTGT; cần kế toán xác nhận.",
        )
    base = _decimal(taxable_base)
    rate = _decimal(vat_rate)
    actual = _decimal(vat)
    if base is None or rate is None or actual is None:
        return VatBasisResult(
            ok=False,
            severity="warning",
            basis=normalized_basis,
            message="Thiếu cơ sở, thuế suất hoặc tiền thuế để đối chiếu.",
        )
    expected = _money(base * rate)
    actual_money = _money(actual)
    if abs(expected - actual_money) > VAT_BASIS_TOLERANCE:
        return VatBasisResult(
            ok=False,
            severity="blocker",
            basis=normalized_basis,
            expected=str(expected),
            actual=str(actual_money),
            message="Tiền thuế GTGT không khớp với cơ sở tính thuế đã chọn.",
        )
    if rate == Decimal("0.08"):
        return VatBasisResult(
            ok=True,
            severity="warning",
            basis=normalized_basis,
            expected=str(expected),
            actual=str(actual_money),
            message="Thuế suất 8% khớp toán học nhưng điều kiện áp dụng cần xác nhận.",
        )
    return VatBasisResult(
        ok=True,
        severity="info",
        basis=normalized_basis,
        expected=str(expected),
        actual=str(actual_money),
        message="Tiền thuế GTGT khớp cơ sở tính thuế đã chọn.",
    )


def _decimal(value: object | None) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None


def _money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
