from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from app.document_classification import (
    aggregate_nature,
    classify_line_nature,
    detect_direction,
)
from app.document_grouping import (
    PreparedRow,
    group_prepared_rows,
    prepare_rows,
    stable_draft_id,
)
from app.excel_io import InputTable
from app.field_detection import apply_column_mapping, detect_columns
from app.field_provenance import derived_field, source_field
from app.normalization import is_blank, normalize_header
from app.parsing import parse_date
from app.voucher_models import (
    ReconstructionIssue,
    ReconstructionSummary,
    RowConservation,
    VoucherDraft,
    VoucherField,
    VoucherLineDraft,
    VoucherReconstructionReport,
    VoucherTotals,
)


HEADER_FIELDS = {
    "invoice_number": "invoice",
    "invoice_symbol": "invoice_symbol",
    "invoice_date": "invoice_date",
    "posting_date": "date",
    "purchase_receipt": "purchase_receipt",
    "supplier_code": "supplier_code",
    "supplier_tax_code": "supplier_tax_code",
    "supplier_name": "supplier_name",
    "customer_code": "customer_code",
    "customer_tax_code": "customer_tax_code",
    "customer_name": "customer_name",
    "payment_method": "payment_method",
}

LINE_FIELDS = {
    "item_code": "item_code",
    "item_name": "item_name",
    "unit": "unit",
    "quantity": "quantity",
    "unit_price": "unit_price",
    "amount": "line_amount",
    "discount_rate": "discount_percent",
    "discount_amount": "discount_amount",
    "vat_rate": "vat_rate",
    "vat_amount": "vat_amount",
    "inventory_account": "inventory_account",
    "payable_account": "payable_account",
    "debit_account": "debit_account",
    "credit_account": "credit_account",
}

MONEY_FIELDS = {"quantity", "unit_price", "amount", "discount_rate", "discount_amount", "vat_rate", "vat_amount"}


def reconstruct_vouchers(
    table: InputTable,
    *,
    mode: str = "auto",
    workspace_tax_code: str = "",
    requested_template_id: str | None = None,
    column_mapping: dict[str, str] | None = None,
    fill_down_fields: list[str] | None = None,
    grouping_keys: list[str] | None = None,
    template_routing: dict[str, str] | None = None,
) -> VoucherReconstructionReport:
    detected = detect_columns(table.headers)
    detected, _ = apply_column_mapping(detected, table.headers, column_mapping)
    prepared = prepare_rows(
        table.rows,
        detected,
        header_row_index=table.header_row_index,
        fill_down_fields=fill_down_fields,
    )
    direction, direction_trust = _report_direction(
        prepared,
        detected,
        mode=mode,
        workspace_tax_code=workspace_tax_code,
    )
    grouped = group_prepared_rows(
        prepared,
        direction=direction,
        grouping_keys=grouping_keys,
    )
    drafts = [
        _build_draft(
            table,
            detected,
            group_key,
            uses_fallback,
            rows,
            direction=direction,
            direction_trust=direction_trust,
            requested_template_id=requested_template_id,
            template_routing=template_routing,
        )
        for group_key, uses_fallback, rows in grouped
    ]
    assigned = sum(len(draft.source_rows) for draft in drafts)
    row_conservation = RowConservation(
        source_rows=len(table.rows),
        assigned_rows=assigned,
        unresolved_rows=max(0, len(table.rows) - assigned),
    )
    report_issues: list[ReconstructionIssue] = []
    if assigned != len(table.rows):
        report_issues.append(
            ReconstructionIssue(
                severity="blocker",
                code="row_conservation_failed",
                message="Số dòng nguồn không khớp số dòng đã gán vào chứng từ.",
                expected=len(table.rows),
                actual=assigned,
                fix_hint="Kiểm tra lại grouping trước khi export.",
            )
        )
    summary = _summary(drafts)
    return VoucherReconstructionReport(
        source_signature_hash=_signature(table),
        sheet_name=table.sheet_name or "",
        detected_columns=detected,
        drafts=drafts,
        summary=summary,
        row_conservation=row_conservation,
        issues=report_issues,
    )


def _report_direction(
    rows: list[PreparedRow],
    detected: dict[str, str],
    *,
    mode: str,
    workspace_tax_code: str,
) -> tuple[str, str]:
    seller = _first_value(rows, "seller_tax_code") or _first_value(rows, "supplier_tax_code")
    buyer = _first_value(rows, "buyer_tax_code") or _first_value(rows, "customer_tax_code")
    return detect_direction(
        mode=mode,
        workspace_tax_code=workspace_tax_code,
        seller_tax_code=_text(seller),
        buyer_tax_code=_text(buyer),
        has_supplier_fields=any(
            field in detected for field in ("supplier_code", "supplier_tax_code", "supplier_name")
        ),
        has_customer_fields=any(
            field in detected for field in ("customer_code", "customer_tax_code", "customer_name")
        ),
    )


def _build_draft(
    table: InputTable,
    detected: dict[str, str],
    group_key: str,
    uses_fallback: bool,
    rows: list[PreparedRow],
    *,
    direction: str,
    direction_trust: str,
    requested_template_id: str | None,
    template_routing: dict[str, str] | None,
) -> VoucherDraft:
    issues: list[ReconstructionIssue] = []
    header = _build_header(table, detected, rows, issues)
    lines = [_build_line(table, detected, row, sequence) for sequence, row in enumerate(rows, 1)]
    nature, nature_trust = aggregate_nature(
        [(line.nature, line.nature_trust) for line in lines]
    )
    if uses_fallback:
        issues.append(
            ReconstructionIssue(
                severity="warning",
                code="fallback_document_grouping",
                message="Ranh giới chứng từ dùng khóa dự phòng và cần được kiểm tra.",
                source_rows=[row.source_row for row in rows],
                fix_hint="Kiểm tra số hóa đơn, ký hiệu và mã số thuế đối tượng.",
            )
        )
    if nature == "mixed":
        issues.append(
            ReconstructionIssue(
                severity="warning",
                code="mixed_document_nature",
                message="Chứng từ chứa cả hàng hóa và dịch vụ.",
                source_rows=[row.source_row for row in rows],
                fix_hint="Chọn template phù hợp hoặc tách chứng từ sau khi kiểm tra nghiệp vụ.",
            )
        )
    elif nature == "unknown":
        issues.append(
            ReconstructionIssue(
                severity="warning",
                code="document_nature_unknown",
                message="Chưa xác định được chứng từ hàng hóa hay dịch vụ.",
                source_rows=[row.source_row for row in rows],
                fix_hint="Chọn loại chứng từ trước khi export.",
            )
        )
    if direction == "unknown":
        severity = "blocker" if direction_trust == "conflict" else "warning"
        issues.append(
            ReconstructionIssue(
                severity=severity,
                code="document_direction_unknown",
                message="Chưa xác định được đây là chứng từ mua vào hay bán ra.",
                source_rows=[row.source_row for row in rows],
                fix_hint="Chọn chiều chứng từ hoặc cấu hình MST doanh nghiệp.",
            )
        )
    elif direction_trust == "suggested":
        issues.append(
            ReconstructionIssue(
                severity="warning",
                code="document_direction_suggested",
                message="Chiều mua/bán đang được suy luận từ tên cột dữ liệu.",
                source_rows=[row.source_row for row in rows],
                fix_hint="Xác nhận đây là chứng từ mua vào hay bán ra trước khi export.",
            )
        )
    if nature not in {"mixed", "unknown"} and nature_trust == "suggested":
        issues.append(
            ReconstructionIssue(
                severity="warning",
                code="document_nature_suggested",
                message="Loại hàng hóa/dịch vụ đang được suy luận từ dữ liệu chi tiết.",
                source_rows=[row.source_row for row in rows],
                fix_hint="Xác nhận loại chứng từ và template MISA trước khi export.",
            )
        )

    for line in lines:
        issues.extend(line.issues)
    totals = _totals(lines)
    status = _status(issues, nature_trust=nature_trust, direction_trust=direction_trust)
    source_rows = [row.source_row for row in rows]
    draft_id = stable_draft_id(table.sheet_name or "", group_key, source_rows)
    return VoucherDraft(
        id=draft_id,
        direction=direction,
        direction_trust=direction_trust,
        nature=nature,
        nature_trust=nature_trust,
        document_kind=f"{direction}_{nature}" if direction != "unknown" else "unknown",
        template_id=_template_for(
            direction,
            nature,
            requested_template_id=requested_template_id,
            template_routing=template_routing,
        ),
        status=status,
        header=header,
        lines=lines,
        totals=totals,
        source_rows=source_rows,
        issues=issues,
    )


def _build_header(
    table: InputTable,
    detected: dict[str, str],
    rows: list[PreparedRow],
    issues: list[ReconstructionIssue],
) -> dict[str, VoucherField]:
    header: dict[str, VoucherField] = {}
    for canonical, semantic in HEADER_FIELDS.items():
        source_header = detected.get(semantic)
        values = [row.direct.get(semantic) for row in rows if not is_blank(row.direct.get(semantic))]
        normalized_values = {_comparable(value) for value in values}
        if len(normalized_values) > 1:
            header[canonical] = VoucherField(
                value=values[0],
                trust="conflict",
                provenance=[],
            )
            issues.append(
                ReconstructionIssue(
                    severity="blocker",
                    code="invoice_header_conflict",
                    message=f"Thông tin header '{canonical}' không nhất quán trong cùng chứng từ.",
                    field=canonical,
                    source_rows=[row.source_row for row in rows],
                    actual=values,
                    fix_hint="Tách chứng từ hoặc chọn lại giá trị header đúng.",
                )
            )
            continue
        selected = next(
            (
                (row, row.effective.get(semantic), semantic in row.filled_fields)
                for row in rows
                if not is_blank(row.effective.get(semantic))
            ),
            None,
        )
        if not selected:
            header[canonical] = VoucherField(value=None, trust="missing")
            continue
        row, value, filled = selected
        header[canonical] = source_field(
            _normalized_value(canonical, value),
            sheet=table.sheet_name or "",
            row=row.source_row,
            header=source_header,
            filled_down=filled,
        )
    return header


def _build_line(
    table: InputTable,
    detected: dict[str, str],
    row: PreparedRow,
    sequence: int,
) -> VoucherLineDraft:
    fields: dict[str, VoucherField] = {}
    for canonical, semantic in LINE_FIELDS.items():
        value = row.direct.get(semantic)
        if canonical in MONEY_FIELDS:
            value = _decimal_text(value)
        fields[canonical] = source_field(
            value,
            sheet=table.sheet_name or "",
            row=row.source_row,
            header=detected.get(semantic),
        )

    quantity = _decimal(fields["quantity"].value)
    unit_price = _decimal(fields["unit_price"].value)
    actual_amount = _decimal(fields["amount"].value)
    discount = _decimal(fields["discount_amount"].value) or Decimal("0")
    issues: list[ReconstructionIssue] = []
    if actual_amount is None and quantity is not None and unit_price is not None:
        actual_amount = _money(quantity * unit_price - discount)
        fields["amount"] = derived_field(
            _decimal_text(actual_amount),
            note="Số lượng x Đơn giá - Chiết khấu dòng",
        )
    elif actual_amount is not None and quantity is not None and unit_price is not None:
        expected = _money(quantity * unit_price - discount)
        if abs(actual_amount - expected) > Decimal("1"):
            issues.append(
                ReconstructionIssue(
                    severity="blocker",
                    code="line_amount_mismatch",
                    message="Thành tiền không khớp số lượng × đơn giá - chiết khấu.",
                    field="amount",
                    source_rows=[row.source_row],
                    expected=_decimal_text(expected),
                    actual=_decimal_text(actual_amount),
                    fix_hint="Kiểm tra số lượng, đơn giá, chiết khấu hoặc thành tiền.",
                )
            )
    if actual_amount is not None and actual_amount < 0:
        issues.append(
            ReconstructionIssue(
                severity="warning",
                code="negative_amount_context_unclear",
                message="Dòng có giá trị âm và cần kiểm tra ngữ cảnh điều chỉnh/trả lại.",
                source_rows=[row.source_row],
                actual=_decimal_text(actual_amount),
            )
        )

    nature, nature_trust = classify_line_nature(
        row.direct.get("item_type"),
        item_code=row.direct.get("item_code"),
        quantity=row.direct.get("quantity"),
        unit=row.direct.get("unit"),
        item_name=row.direct.get("item_name"),
    )
    line_payload = json.dumps(
        {"row": row.source_row, "item": _text(row.direct.get("item_code"))},
        ensure_ascii=False,
        sort_keys=True,
    )
    line_id = hashlib.sha256(line_payload.encode("utf-8")).hexdigest()[:20]
    return VoucherLineDraft(
        id=line_id,
        sequence=sequence,
        nature=nature,
        nature_trust=nature_trust,
        fields=fields,
        source_rows=[row.source_row],
        issues=issues,
    )


def _totals(lines: list[VoucherLineDraft]) -> VoucherTotals:
    amount = sum((_decimal(line.fields["amount"].value) or Decimal("0") for line in lines), Decimal("0"))
    discount = sum(
        (_decimal(line.fields["discount_amount"].value) or Decimal("0") for line in lines),
        Decimal("0"),
    )
    vat = sum((_decimal(line.fields["vat_amount"].value) or Decimal("0") for line in lines), Decimal("0"))
    payment = amount + vat
    return VoucherTotals(
        amount=_decimal_text(amount),
        discount=_decimal_text(discount),
        vat=_decimal_text(vat),
        payment=_decimal_text(payment),
    )


def _status(
    issues: list[ReconstructionIssue],
    *,
    nature_trust: str,
    direction_trust: str,
) -> str:
    if any(issue.severity == "blocker" for issue in issues):
        return "blocked"
    if any(issue.severity == "warning" for issue in issues):
        return "needs_review"
    if nature_trust not in {"verified", "supported"} or direction_trust not in {
        "verified",
        "supported",
    }:
        return "needs_review"
    return "ready"


def _template_for(
    direction: str,
    nature: str,
    *,
    requested_template_id: str | None,
    template_routing: dict[str, str] | None,
) -> str | None:
    if requested_template_id:
        return requested_template_id
    routed = (template_routing or {}).get(nature)
    if routed:
        return str(routed)
    return {
        ("purchase", "goods"): "misa_purchase_domestic",
        ("purchase", "service"): "purchase_service",
        ("sales", "goods"): "bsn_sales",
        ("sales", "service"): "sales_service",
    }.get((direction, nature))


def _summary(drafts: list[VoucherDraft]) -> ReconstructionSummary:
    statuses = Counter(draft.status for draft in drafts)
    kinds = Counter((draft.direction, draft.nature) for draft in drafts)
    return ReconstructionSummary(
        draft_count=len(drafts),
        ready=statuses["ready"],
        needs_review=statuses["needs_review"],
        blocked=statuses["blocked"],
        purchase_goods=kinds[("purchase", "goods")],
        purchase_services=kinds[("purchase", "service")],
        sales_goods=kinds[("sales", "goods")],
        sales_services=kinds[("sales", "service")],
        mixed=sum(1 for draft in drafts if draft.nature == "mixed"),
        unknown=sum(
            1
            for draft in drafts
            if draft.nature == "unknown" or draft.direction == "unknown"
        ),
    )


def _first_value(rows: list[PreparedRow], semantic: str) -> Any:
    return next(
        (row.effective.get(semantic) for row in rows if not is_blank(row.effective.get(semantic))),
        None,
    )


def _signature(table: InputTable) -> str:
    payload = json.dumps(
        {
            "sheet": normalize_header(table.sheet_name or ""),
            "headers": [normalize_header(header) for header in table.headers],
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _normalized_value(field: str, value: Any) -> Any:
    if field in {"invoice_date", "posting_date"}:
        parsed = parse_date(value)
        if isinstance(parsed, (datetime, date)):
            return parsed.date().isoformat()
    return _text(value)


def _comparable(value: Any) -> str:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return _text(value).casefold()


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return Decimal(int(value))
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    text = str(value).strip().replace("\u00a0", "").replace(" ", "")
    if not text or text == "-":
        return None
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    text = text.replace("₫", "").replace("VND", "").replace("VNĐ", "")
    comma = text.rfind(",")
    dot = text.rfind(".")
    if comma >= 0 and dot >= 0:
        decimal_separator = "," if comma > dot else "."
        thousands_separator = "." if decimal_separator == "," else ","
        text = text.replace(thousands_separator, "").replace(decimal_separator, ".")
    elif text.count(",") > 1 or text.count(".") > 1:
        text = text.replace(",", "").replace(".", "")
    elif "," in text:
        before, after = text.split(",", 1)
        text = before + after if len(after) == 3 else before + "." + after
    elif "." in text:
        before, after = text.split(".", 1)
        text = before + after if len(after) == 3 else text
    try:
        result = Decimal(text)
    except InvalidOperation:
        return None
    return -result if negative else result


def _decimal_text(value: Any) -> str | None:
    number = _decimal(value)
    if number is None:
        return None
    normalized = number.normalize()
    if normalized == normalized.to_integral():
        return str(normalized.quantize(Decimal("1")))
    return format(normalized, "f")


def _money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()
