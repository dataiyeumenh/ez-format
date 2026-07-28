from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.cell_ref import column_index as header_column_index
from app.cell_ref import excel_cell
from app.field_detection import semantic_value
from app.models import JsonDict, ReportIssue, ValidationReport
from app.normalization import is_blank
from app.parsing import parse_number
from app.vat_basis import resolve_vat_taxable_base


CALCULATION_CODE_PREFIX = "calculation_"
DEFAULT_TOLERANCE = 1.0


@dataclass
class InvoiceCalculation:
    invoice: str
    first_row: int
    computed_subtotal: float = 0.0
    actual_subtotal: float | None = None
    invoice_discount: float = 0.0
    vat_amounts: list[float] = field(default_factory=list)
    other_charges: float = 0.0
    payable: float | None = None


def check_calculation_rules(
    rows: list[dict[str, Any]],
    detected_columns: dict[str, str],
    options: JsonDict | None = None,
    headers: list[str] | None = None,
    first_data_row: int = 2,
) -> list[ReportIssue]:
    tolerance = _calculation_tolerance(options)
    vat_basis = str((options or {}).get("vat_basis") or "").strip().lower()
    headers = headers or []
    warnings: list[ReportIssue] = []
    invoices: dict[str, InvoiceCalculation] = {}

    for row_number, row in enumerate(rows, start=first_data_row):
        invoice = _text(semantic_value(row, detected_columns, "invoice")) or None
        quantity = _number(row, detected_columns, "quantity")
        raw_unit_price = semantic_value(row, detected_columns, "unit_price")
        unit_price = _number(row, detected_columns, "unit_price")
        line_amount = _number(row, detected_columns, "line_amount")
        discount_total = line_discount_total(row, detected_columns, tolerance)

        expected_line_amount: float | None = None
        if quantity not in (None, 0) and unit_price not in (None, 0):
            gross_amount = quantity * unit_price
            expected_line_amount = gross_amount - (discount_total or 0)
            line_tolerance = _line_amount_tolerance(
                quantity,
                raw_unit_price,
                tolerance,
            )
            if line_amount is not None and _outside_tolerance(
                expected_line_amount, line_amount, line_tolerance
            ):
                warnings.append(
                    _issue(
                        row=row_number,
                        invoice=invoice,
                        field="line_amount",
                        code="calculation_line_amount_mismatch",
                        expected=expected_line_amount,
                        actual=line_amount,
                        tolerance=line_tolerance,
                        message="Line amount must equal quantity × unit price − line discount.",
                        detected_columns=detected_columns,
                        headers=headers,
                    )
                )

            discount_percent = _percent(row, detected_columns, "discount_percent")
            if (
                discount_percent is not None
                and abs(discount_percent) > 0
                and discount_total is not None
                and abs(discount_total) > 0
            ):
                expected_discount = gross_amount * discount_percent
                discount_tolerance = _percentage_amount_tolerance(gross_amount, tolerance)
                if _outside_tolerance(expected_discount, discount_total, discount_tolerance):
                    warnings.append(
                        _issue(
                            row=row_number,
                            invoice=invoice,
                            field="discount_amount",
                            code="calculation_discount_mismatch",
                            expected=expected_discount,
                            actual=discount_total,
                            tolerance=discount_tolerance,
                            message="Line discount must match quantity × unit price × discount percent.",
                            detected_columns=detected_columns,
                            headers=headers,
                        )
                    )

        vat_rate = _percent(row, detected_columns, "vat_rate")
        vat_amount = _number(row, detected_columns, "vat_amount")
        taxable_amount, vat_basis_warning = _vat_taxable_amount(
            row=row,
            detected_columns=detected_columns,
            line_amount=line_amount,
            expected_line_amount=expected_line_amount,
            discount_total=discount_total,
            vat_rate=vat_rate,
            vat_amount=vat_amount,
            vat_basis=vat_basis,
        )
        if vat_basis_warning is not None:
            warnings.append(
                _issue(
                    row=row_number,
                    invoice=invoice,
                    field="vat_amount",
                    code=vat_basis_warning,
                    expected=0,
                    actual=0,
                    tolerance=0,
                    message="VAT basis chưa rõ vì dòng có chiết khấu; chưa kết luận lệch tiền thuế.",
                    detected_columns=detected_columns,
                    headers=headers,
                )
            )
        if taxable_amount is not None and vat_rate is not None and vat_amount is not None:
            expected_vat = taxable_amount * vat_rate
            if _outside_tolerance(expected_vat, vat_amount, tolerance):
                warnings.append(
                    _issue(
                        row=row_number,
                        invoice=invoice,
                        field="vat_amount",
                        code="calculation_vat_mismatch",
                        expected=expected_vat,
                        actual=vat_amount,
                        tolerance=tolerance,
                        message="VAT amount must equal taxable amount × VAT rate.",
                        detected_columns=detected_columns,
                        headers=headers,
                    )
                )

        if invoice:
            calculation = invoices.setdefault(
                invoice, InvoiceCalculation(invoice=invoice, first_row=row_number)
            )
            calculation.computed_subtotal += (
                line_amount if line_amount is not None else expected_line_amount or 0
            )
            _set_once(calculation, "actual_subtotal", _number(row, detected_columns, "invoice_subtotal"))
            _set_once(
                calculation, "invoice_discount", _number(row, detected_columns, "invoice_discount")
            )
            _set_once(calculation, "other_charges", _number(row, detected_columns, "other_charges"))
            _set_once(calculation, "payable", _number(row, detected_columns, "payable"))
            if vat_amount is not None:
                calculation.vat_amounts.append(vat_amount)

    for calculation in invoices.values():
        if calculation.actual_subtotal is not None and _outside_tolerance(
            calculation.computed_subtotal, calculation.actual_subtotal, tolerance
        ):
            warnings.append(
                _issue(
                    row=calculation.first_row,
                    invoice=calculation.invoice,
                    field="invoice_subtotal",
                    code="calculation_invoice_subtotal_mismatch",
                    expected=calculation.computed_subtotal,
                    actual=calculation.actual_subtotal,
                    tolerance=tolerance,
                    message="Invoice subtotal must equal the sum of line amounts for the invoice.",
                    detected_columns=detected_columns,
                    headers=headers,
                )
            )

        if calculation.payable is not None:
            subtotal = (
                calculation.actual_subtotal
                if calculation.actual_subtotal is not None
                else calculation.computed_subtotal
            )
            expected_payable = (
                subtotal
                - calculation.invoice_discount
                + sum(calculation.vat_amounts)
                + calculation.other_charges
            )
            if _outside_tolerance(expected_payable, calculation.payable, tolerance):
                warnings.append(
                    _issue(
                        row=calculation.first_row,
                        invoice=calculation.invoice,
                        field="payable",
                        code="calculation_payable_mismatch",
                        expected=expected_payable,
                        actual=calculation.payable,
                        tolerance=tolerance,
                        message="Payable amount must equal subtotal − invoice discount + VAT + other charges.",
                        detected_columns=detected_columns,
                        headers=headers,
                    )
                )

    return warnings


def _vat_taxable_amount(
    *,
    row: dict[str, Any],
    detected_columns: dict[str, str],
    line_amount: float | None,
    expected_line_amount: float | None,
    discount_total: float | None,
    vat_rate: float | None,
    vat_amount: float | None,
    vat_basis: str,
) -> tuple[float | None, str | None]:
    after_discount = line_amount if line_amount is not None else expected_line_amount
    invoice_base = semantic_value(row, detected_columns, "invoice_taxable_base")
    resolution = resolve_vat_taxable_base(
        amount=after_discount,
        discount=discount_total,
        vat_rate=vat_rate,
        vat_amount=vat_amount,
        basis=vat_basis,
        invoice_taxable_base=parse_number(invoice_base),
    )
    if resolution.status == "unknown":
        if vat_basis == "invoice_taxable_base":
            has_material_discount = discount_total is not None and abs(discount_total) > 0
            has_taxable_vat = (
                vat_rate is not None
                and abs(vat_rate) > 0
                and vat_amount is not None
                and abs(vat_amount) > 0
            )
            if not has_material_discount:
                return after_discount, None
            if vat_rate is not None and abs(vat_rate) == 0:
                return after_discount, None
            if not has_taxable_vat:
                return None, None
        return None, "calculation_vat_basis_unknown"
    if resolution.status == "ambiguous":
        return None, "calculation_vat_basis_ambiguous"
    if resolution.taxable_base is None:
        return None, None
    return float(resolution.taxable_base), None


def line_discount_total(
    row: dict[str, Any],
    detected_columns: dict[str, str],
    tolerance: float | int = DEFAULT_TOLERANCE,
) -> float | None:
    explicit_total = _number(row, detected_columns, "discount_total")
    if explicit_total is not None:
        return explicit_total

    raw_discount = _number(row, detected_columns, "discount_amount")
    if raw_discount is None:
        return None

    quantity = _number(row, detected_columns, "quantity")
    unit_price = _number(row, detected_columns, "unit_price")
    line_amount = _number(row, detected_columns, "line_amount")
    if quantity is not None and unit_price is not None and line_amount is not None:
        inferred_total = quantity * unit_price - line_amount
        if _within_tolerance(raw_discount, inferred_total, tolerance):
            return raw_discount
        per_unit_total = raw_discount * quantity
        if _within_tolerance(per_unit_total, inferred_total, tolerance):
            return per_unit_total

    return raw_discount


def has_calculation_warnings(report: ValidationReport) -> bool:
    return any(warning.code.startswith(CALCULATION_CODE_PREFIX) for warning in report.warnings)


def allow_calculation_warnings(options: JsonDict | None) -> bool:
    return bool((options or {}).get("allow_calculation_warnings"))


def _calculation_tolerance(options: JsonDict | None) -> float:
    raw_value = (options or {}).get("calculation_tolerance", DEFAULT_TOLERANCE)
    parsed = parse_number(raw_value)
    if parsed is None or parsed < 0:
        return DEFAULT_TOLERANCE
    return float(parsed)


def _set_once(calculation: InvoiceCalculation, field_name: str, value: float | None) -> None:
    if value is None:
        return
    if getattr(calculation, field_name) in (None, 0.0):
        setattr(calculation, field_name, value)


def _number(row: dict[str, Any], detected_columns: dict[str, str], field: str) -> float | None:
    value = semantic_value(row, detected_columns, field)
    if is_blank(value):
        return None
    parsed = parse_number(value)
    if parsed is None:
        return None
    return float(parsed)


def _percent(row: dict[str, Any], detected_columns: dict[str, str], field: str) -> float | None:
    value = semantic_value(row, detected_columns, field)
    if is_blank(value):
        return None
    if isinstance(value, str):
        value = value.strip().replace("%", "")
    parsed = parse_number(value)
    if parsed is None:
        return None
    parsed_float = float(parsed)
    if abs(parsed_float) > 1:
        return parsed_float / 100
    return parsed_float


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _issue(
    *,
    row: int,
    invoice: str | None,
    field: str,
    code: str,
    expected: float,
    actual: float,
    tolerance: float,
    message: str,
    detected_columns: dict[str, str] | None = None,
    headers: list[str] | None = None,
) -> ReportIssue:
    source_header = (detected_columns or {}).get(field)
    col_idx = header_column_index(headers or [], source_header)
    return ReportIssue(
        row=row,
        invoice=invoice,
        field=field,
        code=code,
        expected=_clean_number(expected),
        actual=_clean_number(actual),
        delta=_clean_number(actual - expected),
        tolerance=_clean_number(tolerance),
        message=message,
        source_header=source_header,
        column_index=col_idx,
        cell=excel_cell(row, col_idx),
    )


def _within_tolerance(expected: float, actual: float, tolerance: float | int) -> bool:
    return abs(actual - expected) <= float(tolerance)


def _outside_tolerance(expected: float, actual: float, tolerance: float | int) -> bool:
    return not _within_tolerance(expected, actual, tolerance)


def _percentage_amount_tolerance(base_amount: float, tolerance: float | int) -> float:
    return max(float(tolerance), abs(base_amount) * 0.001)


def _line_amount_tolerance(
    quantity: float,
    raw_unit_price: Any,
    tolerance: float | int,
) -> float:
    parsed_unit_price = parse_number(raw_unit_price)
    if parsed_unit_price is None:
        return float(tolerance)
    decimal_price = Decimal(str(parsed_unit_price))
    quantum = Decimal("1").scaleb(decimal_price.as_tuple().exponent)
    rounding_tolerance = Decimal(str(abs(quantity))) * quantum / 2
    return max(float(tolerance), float(rounding_tolerance))


def _clean_number(value: float | int) -> float | int:
    number = float(value)
    if abs(number) < 1e-9:
        number = 0.0
    rounded = round(number)
    if abs(number - rounded) < 1e-9:
        return int(rounded)
    return round(number, 6)
