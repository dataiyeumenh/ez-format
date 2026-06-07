from __future__ import annotations

from pathlib import Path
from typing import Any

from app.accounting_rules import (
    AUTO_PROFILE,
    check_accounting_rules,
    resolve_accounting_profile,
)
from app.ai_assistant import explain_validation_report, suggest_mapping_for_file
from app.conversion_types import get_conversion_type
from app.converter import validate_file
from app.excel_io import read_input_table
from app.field_detection import apply_column_mapping, detect_columns
from app.models import (
    ErrorCheckIssue,
    ErrorCheckReport,
    ErrorCheckSummary,
    JsonDict,
    ReportIssue,
)

AUTO_APPLY_MAPPING_CONFIDENCE = 0.8


def check_file_for_errors(
    input_path: Path,
    conversion_type: str,
    options: JsonDict | None = None,
) -> ErrorCheckReport:
    options = dict(options or {})
    definition = get_conversion_type(conversion_type)
    table = read_input_table(input_path)

    suggested_mapping: dict[str, str] = {}
    suggestion = suggest_mapping_for_file(input_path, conversion_type, options)
    if suggestion.ok:
        suggested_mapping = dict(suggestion.suggested_mapping)

    if "column_mapping" not in options and suggested_mapping:
        trusted_mapping = _trusted_suggested_mapping(
            suggestion.suggestions,
            minimum_confidence=float(options.get("ai_mapping_confidence_threshold", AUTO_APPLY_MAPPING_CONFIDENCE)),
        )
        if trusted_mapping:
            options["column_mapping"] = trusted_mapping

    validation = validate_file(input_path, conversion_type, options)
    detected_columns = dict(validation.detected_columns)
    if not detected_columns:
        detected_columns = detect_columns(table.headers)
        detected_columns, _ = apply_column_mapping(
            detected_columns,
            table.headers,
            options.get("column_mapping"),
        )

    accounting_profile = (
        str(options.get("accounting_profile")).strip().lower()
        if options.get("accounting_profile")
        else AUTO_PROFILE
    )
    if accounting_profile == AUTO_PROFILE:
        accounting_profile = resolve_accounting_profile(table.rows, detected_columns, options)

    issues: list[ErrorCheckIssue] = []
    issues.extend(_validation_issues(validation.errors, severity="error"))
    issues.extend(_validation_issues(validation.warnings, severity="warning"))
    issues.extend(check_accounting_rules(table.rows, detected_columns, definition, options))
    strict = bool(options.get("strict"))
    blocking_issues = _strict_blocking_issues(issues, options) if strict else []

    ai_explanation: str | None = None
    explanation = explain_validation_report(validation, options)
    if explanation.ok:
        accounting_count = sum(1 for issue in issues if issue.category == "accounting")
        ai_explanation = (
            f"{explanation.summary} Công cụ cũng phát hiện "
            f"{accounting_count} vấn đề hạch toán cần rà soát."
        )
    elif explanation.summary:
        ai_explanation = explanation.summary

    return ErrorCheckReport(
        ok=not any(issue.severity == "error" for issue in issues) and not blocking_issues,
        accounting_profile=accounting_profile,
        summary=_summary(table.rows, issues),
        issues=issues,
        strict_blocked=bool(blocking_issues),
        blocking_issues=blocking_issues,
        remediation=_remediation(blocking_issues) if blocking_issues else None,
        detected_columns=detected_columns,
        suggested_mapping=suggested_mapping,
        ai_explanation=ai_explanation,
    )


def _validation_issues(
    issues: list[ReportIssue],
    *,
    severity: str,
) -> list[ErrorCheckIssue]:
    output: list[ErrorCheckIssue] = []
    for issue in issues:
        category = "calculation" if issue.code.startswith("calculation_") else "format"
        output.append(
            ErrorCheckIssue(
                row=issue.row,
                severity=severity,
                category=category,
                code=issue.code,
                field=issue.field,
                message=issue.message,
                invoice=issue.invoice,
                expected=issue.expected,
                actual=issue.actual,
                source_header=issue.source_header,
                column_index=issue.column_index,
                cell=issue.cell,
            )
        )
    return output


def _trusted_suggested_mapping(suggestions: list[Any], *, minimum_confidence: float) -> dict[str, str]:
    trusted: dict[str, str] = {}
    for suggestion in suggestions:
        confidence = getattr(suggestion, "confidence", 0.0)
        field = getattr(suggestion, "field", "")
        header = getattr(suggestion, "source_header", "")
        if confidence >= minimum_confidence and field and header:
            trusted[str(field)] = str(header)
    return trusted


def _strict_blocking_issues(
    issues: list[ErrorCheckIssue],
    options: JsonDict,
) -> list[ErrorCheckIssue]:
    reviewed_codes = options.get("reviewed_issue_codes", [])
    if not isinstance(reviewed_codes, list):
        reviewed_codes = []
    reviewed = {str(code) for code in reviewed_codes}
    blocking: list[ErrorCheckIssue] = []
    for issue in issues:
        if issue.severity == "error":
            blocking.append(issue)
        elif issue.severity == "warning" and issue.code not in reviewed:
            blocking.append(issue)
    return blocking


def _remediation(blocking_issues: list[ErrorCheckIssue]) -> str:
    return (
        "Strict mode đang chặn xử lý. Hãy sửa các lỗi/cảnh báo trong blocking_issues; "
        "chỉ thêm mã cảnh báo vào options.reviewed_issue_codes sau khi kế toán đã rà soát."
    )


def _summary(rows: list[dict[str, Any]], issues: list[ErrorCheckIssue]) -> ErrorCheckSummary:
    return ErrorCheckSummary(
        input_rows=len(rows),
        error_count=sum(1 for issue in issues if issue.severity == "error"),
        warning_count=sum(1 for issue in issues if issue.severity == "warning"),
        format_issue_count=sum(1 for issue in issues if issue.category == "format"),
        calculation_issue_count=sum(1 for issue in issues if issue.category == "calculation"),
        accounting_issue_count=sum(1 for issue in issues if issue.category == "accounting"),
    )
