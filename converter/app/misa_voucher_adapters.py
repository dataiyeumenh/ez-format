from __future__ import annotations

import io
import json
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from app.conversion_types import CONVERSION_TYPES
from app.excel_io import InputTable, write_xls_from_template
from app.master_data_resolver import resolve_master_data
from app.misa_readiness import add_master_data_resolutions, build_readiness_report
from app.misa_templates import get_misa_template
from app.voucher_models import VoucherDraft


HEADER_TARGETS = {
    "invoice_number": ("Số hóa đơn", "Số chứng từ (*)", "Số phiếu nhập (*)"),
    "invoice_symbol": ("Ký hiệu HĐ",),
    "invoice_date": ("Ngày hóa đơn",),
    "posting_date": ("Ngày hạch toán (*)", "Ngày chứng từ (*)"),
    "purchase_receipt": ("Số phiếu nhập (*)", "Số chứng từ (*)"),
    "supplier_code": ("Mã nhà cung cấp",),
    "supplier_tax_code": ("Mã số thuế", "Mã nhà cung cấp"),
    "supplier_name": ("Tên nhà cung cấp",),
    "customer_code": ("Mã khách hàng",),
    "customer_tax_code": ("Mã số thuế",),
    "customer_name": ("Tên khách hàng",),
    "payment_method": ("Phương thức thanh toán",),
}

LINE_TARGETS = {
    "item_code": ("Mã hàng (*)", "Mã dịch vụ (*)"),
    "item_name": ("Tên hàng", "Tên dịch vụ"),
    "unit": ("ĐVT",),
    "quantity": ("Số lượng",),
    "unit_price": ("Đơn giá",),
    "amount": ("Thành tiền",),
    "discount_rate": ("Tỷ lệ CK (%)",),
    "discount_amount": ("Tiền chiết khấu",),
    "vat_rate": ("% thuế GTGT", "Thuế suất GTGT"),
    "vat_amount": ("Tiền thuế GTGT",),
    "inventory_account": ("TK kho/TK chi phí (*)", "TK Kho"),
    "payable_account": ("TK công nợ/TK tiền (*)",),
    "debit_account": ("TK Tiền/Chi phí/Nợ (*)",),
    "credit_account": ("TK Doanh thu/Có (*)", "TK công nợ/TK tiền (*)"),
}

NUMERIC_CANONICAL_FIELDS = {
    "quantity",
    "unit_price",
    "amount",
    "discount_rate",
    "discount_amount",
    "vat_rate",
    "vat_amount",
}


def drafts_to_template_rows(
    drafts: list[VoucherDraft],
) -> dict[str, list[dict[str, Any]]]:
    output: dict[str, list[dict[str, Any]]] = {}
    for draft in drafts:
        if not draft.template_id:
            continue
        template = get_misa_template(draft.template_id)
        defaults = CONVERSION_TYPES[draft.template_id].defaults
        rows = output.setdefault(draft.template_id, [])
        for line in draft.lines:
            record = {
                header: defaults.get(header, "")
                for header in template.headers
                if header
            }
            _apply_fields(record, draft.header, HEADER_TARGETS)
            _apply_fields(record, line.fields, LINE_TARGETS)
            _apply_document_type(record, draft)
            rows.append(record)
    return output


def validate_template_rows(
    template_rows: dict[str, list[dict[str, Any]]],
    *,
    master_data_context: dict[str, Any] | None,
    context_status: str,
    context_message: str | None,
) -> dict[str, Any]:
    reports: dict[str, Any] = {}
    total_blockers = 0
    total_warnings = 0
    total_info = 0
    for template_id, rows in template_rows.items():
        template = get_misa_template(template_id)
        resolution = resolve_master_data(rows, master_data_context, source_system="reconstruction")
        resolved_rows = resolution.rows
        identity_mapping = {header: header for header in template.headers if header}
        table = InputTable(
            headers=template.headers,
            rows=resolved_rows,
            sheet_name=template.sheet_name,
            header_row_index=template.header_row - 1,
        )
        report = build_readiness_report(
            table,
            template_id,
            identity_mapping,
            {},
            {},
            edited_rows=resolved_rows,
        )
        report = add_master_data_resolutions(
            report,
            resolution.resolutions,
            context_status=context_status,
            context_message=context_message,
        )
        payload = report.model_dump(mode="json")
        payload["issues"] = [
            issue
            for issue in payload.get("issues") or []
            if issue.get("code") != "duplicate_document_key"
        ]
        payload["summary"] = {
            severity: sum(
                issue.get("severity") == severity for issue in payload["issues"]
            )
            for severity in ("blocker", "warning", "info")
        }
        payload["status"] = (
            "blocked"
            if payload["summary"]["blocker"]
            else "needs_review"
            if payload["summary"]["warning"]
            else "ready"
        )
        payload["ok"] = payload["summary"]["blocker"] == 0
        payload["rows"] = resolved_rows
        reports[template_id] = payload
        total_blockers += payload["summary"]["blocker"]
        total_warnings += payload["summary"]["warning"]
        total_info += payload["summary"]["info"]
    return {
        "status": "blocked" if total_blockers else "needs_review" if total_warnings else "ready",
        "summary": {
            "blocker": total_blockers,
            "warning": total_warnings,
            "info": total_info,
        },
        "templates": reports,
    }


def export_template_rows(
    validation: dict[str, Any],
    *,
    reconstruction_id: str,
    acknowledged_warnings: bool = False,
) -> tuple[bytes, str, str]:
    template_payloads = validation.get("templates") or {}
    rendered: list[tuple[str, bytes, str]] = []
    with tempfile.TemporaryDirectory(prefix="ezformat-reconstruction-") as temp:
        root = Path(temp)
        for template_id, payload in template_payloads.items():
            template = get_misa_template(template_id)
            filename = f"Import MISA {template_id} {reconstruction_id[:8]}.xls"
            path = root / filename
            write_xls_from_template(template.workbook, payload.get("rows") or [], path)
            rendered.append((filename, path.read_bytes(), template_id))

    if len(rendered) == 1:
        filename, content, _ = rendered[0]
        return content, filename, "application/vnd.ms-excel"

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        manifest = {
            "reconstruction_id": reconstruction_id,
            "acknowledged_warnings": bool(acknowledged_warnings),
            "summary": validation.get("summary") or {},
            "files": [],
        }
        for filename, content, template_id in rendered:
            archive.writestr(filename, content)
            template_payload = template_payloads[template_id]
            manifest["files"].append(
                {
                    "filename": filename,
                    "template_id": template_id,
                    "row_count": len(template_payload.get("rows") or []),
                    "reconciliation": template_payload.get("reconciliation") or {},
                    "issues": [
                        {
                            "severity": issue.get("severity"),
                            "code": issue.get("code"),
                            "field": issue.get("field"),
                        }
                        for issue in (template_payload.get("issues") or [])
                    ],
                }
            )
        archive.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )
    return (
        buffer.getvalue(),
        f"Import MISA {reconstruction_id[:8]}.zip",
        "application/zip",
    )


def _apply_fields(
    record: dict[str, Any],
    fields: dict[str, Any],
    targets: dict[str, tuple[str, ...]],
) -> None:
    for canonical, candidates in targets.items():
        field = fields.get(canonical)
        value = field.value if field is not None else None
        if value in (None, ""):
            continue
        for target in candidates:
            if target in record:
                record[target] = (
                    _number_or_text(value)
                    if canonical in NUMERIC_CANONICAL_FIELDS
                    else value
                )


def _apply_document_type(record: dict[str, Any], draft: VoucherDraft) -> None:
    if "Hình thức mua hàng" in record:
        record["Hình thức mua hàng"] = (
            "Mua hàng trong nước nhập kho"
            if draft.nature == "goods"
            else "Mua hàng trong nước không qua kho"
        )
    if "TK kho/TK chi phí (*)" in record and not record["TK kho/TK chi phí (*)"]:
        record["TK kho/TK chi phí (*)"] = "1561" if draft.nature == "goods" else "6428"
    if "Hình thức bán hàng" in record and draft.nature == "service":
        record["Hình thức bán hàng"] = "Bán hàng dịch vụ trong nước"
    if draft.direction == "purchase" and draft.nature == "service":
        if "Số phiếu nhập (*)" in record:
            record["Số phiếu nhập (*)"] = ""
        if "Số chứng từ ghi nợ/Số chứng từ thanh toán" in record:
            invoice = draft.header.get("invoice_number")
            record["Số chứng từ ghi nợ/Số chứng từ thanh toán"] = (
                invoice.value if invoice else ""
            )


def _number_or_text(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        try:
            if text and all(character in "-0123456789." for character in text):
                number = float(text)
                return int(number) if number.is_integer() else number
        except ValueError:
            pass
    return value
