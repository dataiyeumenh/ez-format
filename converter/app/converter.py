from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from typing import Any

from app.calculation_rules import (
    allow_calculation_warnings,
    check_calculation_rules,
    has_calculation_warnings,
    line_discount_total,
)
from app.conversion_types import ConversionTypeDefinition, get_conversion_type
from app.excel_io import InputReadError, read_input_table, read_template, write_xls_from_template
from app.field_detection import apply_column_mapping, detect_columns, semantic_value
from app.models import JsonDict, ReportIssue, ValidationReport
from app.normalization import is_blank
from app.parsing import parse_date, parse_number


def validate_file(
    input_path: Path,
    conversion_type: str,
    options: JsonDict | None = None,
) -> ValidationReport:
    definition = get_conversion_type(conversion_type)
    options = options or {}
    try:
        table = read_input_table(input_path)
    except InputReadError as exc:
        return ValidationReport.build(
            input_rows=0,
            output_rows=0,
            errors=[
                ReportIssue(
                    row=None,
                    field="file",
                    code=exc.code,
                    message=exc.message,
                )
            ],
            warnings=[],
            detected_columns={},
        )
    detected_columns = detect_columns(table.headers)

    errors: list[ReportIssue] = []
    warnings: list[ReportIssue] = []
    detected_columns, mapping_errors = apply_column_mapping(
        detected_columns,
        table.headers,
        options.get("column_mapping"),
    )
    errors.extend(
        ReportIssue(
            field=error["field"],
            code=error["code"],
            message=error["message"],
        )
        for error in mapping_errors
    )

    for field in definition.required_source_fields:
        if field not in detected_columns:
            errors.append(
                ReportIssue(
                    field=field,
                    code="missing_required_column",
                    message=f"Missing required source column for semantic field '{field}'.",
                )
            )

    if errors:
        return ValidationReport.build(
            input_rows=len(table.rows),
            output_rows=0,
            errors=errors,
            warnings=warnings,
            detected_columns=detected_columns,
        )

    first_data_row = table.header_row_index + 2
    seen_invoice_item: set[tuple[str, str]] = set()
    for index, row in enumerate(table.rows, start=first_data_row):
        invoice = semantic_value(row, detected_columns, "invoice")
        item_code = semantic_value(row, detected_columns, "item_code")

        if not is_blank(invoice) and not is_blank(item_code):
            key = (str(invoice).strip(), str(item_code).strip())
            if key in seen_invoice_item:
                warnings.append(
                    ReportIssue(
                        row=index,
                        field="invoice_item",
                        code="duplicate_invoice_item",
                        message=f"Duplicate invoice/item pair {key[0]} / {key[1]}.",
                    )
                )
            seen_invoice_item.add(key)

        for field in definition.required_source_fields:
            value = semantic_value(row, detected_columns, field)
            if is_blank(value):
                errors.append(
                    ReportIssue(
                        row=index,
                        field=field,
                        code="missing_required_value",
                        message=f"Missing value for required field '{field}'.",
                    )
                )

        date_value = semantic_value(row, detected_columns, "date")
        if not is_blank(date_value) and parse_date(date_value) is None:
            errors.append(
                ReportIssue(
                    row=index,
                    field="date",
                    code="invalid_date",
                    message=f"Cannot parse date value '{date_value}'.",
                )
            )

        for numeric_field in ("quantity", "unit_price", "discount_amount"):
            value = semantic_value(row, detected_columns, numeric_field)
            if not is_blank(value) and parse_number(value) is None:
                errors.append(
                    ReportIssue(
                        row=index,
                        field=numeric_field,
                        code="invalid_number",
                        message=f"Cannot parse numeric value '{value}'.",
                    )
                )

    if not errors:
        warnings.extend(
            check_calculation_rules(
                table.rows,
                detected_columns,
                options,
                headers=table.headers,
                first_data_row=first_data_row,
            )
        )

    return ValidationReport.build(
        input_rows=len(table.rows),
        output_rows=len(table.rows),
        errors=errors,
        warnings=warnings,
        detected_columns=detected_columns,
    )


def preview_file(
    input_path: Path,
    conversion_type: str,
    options: JsonDict | None = None,
) -> tuple[list[str], list[dict[str, Any]], ValidationReport]:
    """Map source Excel to MISA rows for UI preview (JSON)."""
    options = options or {}
    report = validate_file(input_path, conversion_type, options)
    if not report.ok:
        return [], [], report
    if has_calculation_warnings(report) and not allow_calculation_warnings(options):
        return [], [], report

    definition = get_conversion_type(conversion_type)
    table = read_input_table(input_path)
    detected_columns = report.detected_columns
    output_rows = [
        _serialize_preview_row(_map_row(row, detected_columns, definition, options))
        for row in table.rows
    ]
    template = read_template(definition.template_path)
    headers = [header for header in template.headers if header]
    return headers, output_rows, report


def export_rows(
    conversion_type: str,
    rows: list[dict[str, Any]],
    output_path: Path,
    options: JsonDict | None = None,
) -> None:
    """Write edited preview rows to a MISA template .xls file."""
    if not rows:
        raise ValueError("No rows to export.")
    definition = get_conversion_type(conversion_type)
    template = read_template(definition.template_path)
    write_xls_from_template(template, rows, output_path)


def convert_file(
    input_path: Path,
    conversion_type: str,
    output_path: Path,
    options: JsonDict | None = None,
) -> ValidationReport:
    options = options or {}
    report = validate_file(input_path, conversion_type, options)
    if not report.ok:
        return report
    if has_calculation_warnings(report) and not allow_calculation_warnings(options):
        return report

    definition = get_conversion_type(conversion_type)
    table = read_input_table(input_path)
    detected_columns = report.detected_columns
    template = read_template(definition.template_path)
    output_rows = [_map_row(row, detected_columns, definition, options) for row in table.rows]
    write_xls_from_template(template, output_rows, output_path)
    return report


def _map_row(
    row: dict[str, Any],
    detected_columns: dict[str, str],
    definition: ConversionTypeDefinition,
    options: JsonDict,
) -> dict[str, Any]:
    if definition.kind.startswith("sales"):
        return _map_sales_row(row, detected_columns, definition, options)
    return _map_purchase_row(row, detected_columns, definition, options)


def _merged_defaults(definition: ConversionTypeDefinition, options: JsonDict) -> dict[str, Any]:
    defaults = dict(definition.defaults)
    option_defaults = options.get("defaults", {}) if isinstance(options, dict) else {}
    if isinstance(option_defaults, dict):
        defaults.update(option_defaults)
    return defaults


def _map_sales_row(
    row: dict[str, Any],
    detected_columns: dict[str, str],
    definition: ConversionTypeDefinition,
    options: JsonDict,
) -> dict[str, Any]:
    defaults = _merged_defaults(definition, options)
    invoice = _text(semantic_value(row, detected_columns, "invoice"))
    customer_code = _text(semantic_value(row, detected_columns, "customer_code"))
    customer_name = _text(semantic_value(row, detected_columns, "customer_name"))
    item_code = _text(semantic_value(row, detected_columns, "item_code"))
    item_name = _text(semantic_value(row, detected_columns, "item_name"))
    unit = _text(semantic_value(row, detected_columns, "unit")) or str(defaults.get("ĐVT", ""))
    quantity = parse_number(semantic_value(row, detected_columns, "quantity")) or 0
    unit_price = parse_number(semantic_value(row, detected_columns, "unit_price")) or 0
    discount_amount = line_discount_total(row, detected_columns) or 0
    date_value = parse_date(semantic_value(row, detected_columns, "date"))
    customer_address = _text(semantic_value(row, detected_columns, "customer_address"))

    output: dict[str, Any] = dict(defaults)
    output.update(
        {
            "Ngày hạch toán (*)": date_value,
            "Ngày chứng từ (*)": date_value,
            "Số chứng từ (*)": invoice,
            "Số phiếu xuất": f"XK_{invoice}" if invoice else "",
            "Mã khách hàng": customer_code,
            "Tên khách hàng": customer_name,
            "Địa chỉ": customer_address,
            "Diễn giải/Lý do nộp": f"Bán hàng cho {customer_name}" if customer_name else "",
            "Lý do xuất": f"Xuất kho bán hàng cho {customer_name}" if customer_name else "",
            "Mã hàng (*)": item_code,
            "Tên hàng": item_name,
            "Mã dịch vụ (*)": item_code,
            "Tên dịch vụ": item_name,
            "ĐVT": unit,
            "Số lượng": quantity,
            "Đơn giá": unit_price,
            "Thành tiền": _multiply(unit_price, quantity),
            "Tiền chiết khấu": discount_amount,
        }
    )
    return output


def _map_purchase_row(
    row: dict[str, Any],
    detected_columns: dict[str, str],
    definition: ConversionTypeDefinition,
    options: JsonDict,
) -> dict[str, Any]:
    defaults = _merged_defaults(definition, options)
    receipt = _text(semantic_value(row, detected_columns, "purchase_receipt"))
    supplier_code = _text(semantic_value(row, detected_columns, "supplier_code"))
    supplier_name = _text(semantic_value(row, detected_columns, "supplier_name"))
    item_code = _text(semantic_value(row, detected_columns, "item_code"))
    item_name = _text(semantic_value(row, detected_columns, "item_name"))
    quantity = parse_number(semantic_value(row, detected_columns, "quantity")) or 0
    unit_price = parse_number(semantic_value(row, detected_columns, "unit_price")) or 0
    date_value = parse_date(semantic_value(row, detected_columns, "date"))

    output: dict[str, Any] = dict(defaults)
    output.update(
        {
            "Ngày hạch toán (*)": date_value,
            "Ngày chứng từ (*)": date_value,
            "Số phiếu nhập (*)": receipt,
            "Số chứng từ (*)": receipt,
            "Mã nhà cung cấp": supplier_code,
            "Nhà cung cấp": supplier_code,
            "Tên nhà cung cấp": supplier_name,
            "Tên NCC": supplier_name,
            "Mã hàng (*)": item_code,
            "Tên hàng": item_name,
            "Mã dịch vụ (*)": item_code,
            "Tên dịch vụ": item_name,
            "Số lượng": quantity,
            "Đơn giá": unit_price,
            "Thành tiền": _multiply(unit_price, quantity),
        }
    )
    return output


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _multiply(left: float | int, right: float | int) -> float | int:
    result = left * right
    return int(result) if isinstance(result, float) and result.is_integer() else result


def _serialize_preview_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: _serialize_preview_value(value) for key, value in row.items()}


def _serialize_preview_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.strftime("%d/%m/%Y")
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    return value
