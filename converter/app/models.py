from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ReportIssue(BaseModel):
    row: int | None = None
    field: str
    code: str
    message: str
    invoice: str | None = None
    expected: float | int | None = None
    actual: float | int | None = None
    delta: float | int | None = None
    tolerance: float | int | None = None
    source_header: str | None = None
    column_index: int | None = None
    cell: str | None = None


class ValidationSummary(BaseModel):
    input_rows: int = 0
    output_rows: int = 0
    error_count: int = 0
    warning_count: int = 0


class ValidationReport(BaseModel):
    ok: bool
    summary: ValidationSummary
    errors: list[ReportIssue] = Field(default_factory=list)
    warnings: list[ReportIssue] = Field(default_factory=list)
    detected_columns: dict[str, str] = Field(default_factory=dict)

    @classmethod
    def build(
        cls,
        *,
        input_rows: int,
        output_rows: int,
        errors: list[ReportIssue] | None = None,
        warnings: list[ReportIssue] | None = None,
        detected_columns: dict[str, str] | None = None,
    ) -> "ValidationReport":
        errors = errors or []
        warnings = warnings or []
        return cls(
            ok=not errors,
            summary=ValidationSummary(
                input_rows=input_rows,
                output_rows=output_rows if not errors else 0,
                error_count=len(errors),
                warning_count=len(warnings),
            ),
            errors=errors,
            warnings=warnings,
            detected_columns=detected_columns or {},
        )


class ErrorCheckIssue(BaseModel):
    row: int | None = None
    severity: str
    category: str
    code: str
    field: str
    message: str
    invoice: str | None = None
    expected: str | float | int | None = None
    actual: str | float | int | None = None
    source: str | None = None
    source_header: str | None = None
    column_index: int | None = None
    cell: str | None = None


class ErrorCheckSummary(BaseModel):
    input_rows: int = 0
    error_count: int = 0
    warning_count: int = 0
    format_issue_count: int = 0
    calculation_issue_count: int = 0
    accounting_issue_count: int = 0


class ErrorCheckReport(BaseModel):
    ok: bool
    tool_name: str = "Kiểm tra lỗi bằng AI"
    accounting_profile: str
    summary: ErrorCheckSummary
    issues: list[ErrorCheckIssue] = Field(default_factory=list)
    strict_blocked: bool = False
    blocking_issues: list[ErrorCheckIssue] = Field(default_factory=list)
    remediation: str | None = None
    detected_columns: dict[str, str] = Field(default_factory=dict)
    suggested_mapping: dict[str, str] = Field(default_factory=dict)
    ai_explanation: str | None = None
    deterministic_disclaimer: str = (
        "Kết luận được tạo bởi rules engine; AI chỉ giải thích và gợi ý, "
        "không thay đổi severity/code/expected/actual."
    )
    misa_certification_status: str = "not_certified"
    production_ready: bool = False


JsonDict = dict[str, Any]


class PreviewResponse(BaseModel):
    headers: list[str]
    rows: list[dict[str, Any]]
    report: ValidationReport


class ExportRowsRequest(BaseModel):
    conversion_type: str
    rows: list[dict[str, Any]]
    options: JsonDict | None = None


ValidationSeverity = Literal["fatal", "blocker", "warning", "info"]
ValidationStatus = Literal["ready", "needs_review", "blocked", "fatal"]
AccountingRegime = Literal["TT99", "TT200", "TT133"]


class RuleSource(BaseModel):
    title: str
    url: str
    effective_from: str | None = None
    effective_to: str | None = None
    verified_at: str


class IssueExplanation(BaseModel):
    why: str
    impact: str
    fix: str
    example: str | None = None


class MisaValidationIssue(BaseModel):
    severity: ValidationSeverity
    category: str
    code: str
    message: str
    row: int | None = None
    field: str | None = None
    invoice: str | None = None
    expected: Any = None
    actual: Any = None
    delta: Any = None
    source_url: str | None = None
    explanation: IssueExplanation | None = None


class MisaValidationSummary(BaseModel):
    fatal: int = 0
    blocker: int = 0
    warning: int = 0
    info: int = 0


class ReconciliationReport(BaseModel):
    input_rows: int
    output_rows: int
    invoice_count: int | None = None
    sum_amount: str | None = None
    sum_vat: str | None = None
    sum_total: str | None = None
    unmapped_columns: list[str] = Field(default_factory=list)


class MisaReadinessReport(BaseModel):
    validation_run_id: str
    ok: bool
    status: ValidationStatus
    score: int
    summary: MisaValidationSummary
    issues: list[MisaValidationIssue]
    reconciliation: ReconciliationReport
    legal_disclaimer: str


class VatPolicy(BaseModel):
    allow_8_percent: bool = True
    effective_from: str = "2025-07-01"
    effective_to: str = "2026-12-31"


class MappingValidateRequest(BaseModel):
    upload_id: str
    target_template_id: str
    mapping: dict[str, Any] = Field(default_factory=dict)
    defaults: dict[str, Any] = Field(default_factory=dict)
    formulas: dict[str, str] = Field(default_factory=dict)
    accounting_regime: AccountingRegime | None = None
    fiscal_year_start: str | None = None
    vat_policy: VatPolicy | None = None


class ExportConfirmedProfileRequest(BaseModel):
    upload_id: str
    profile_id: str
    acknowledge_warnings: bool = False
    validation_run_id: str | None = None
    accounting_regime: AccountingRegime | None = None
    fiscal_year_start: str | None = None
    vat_policy: VatPolicy | None = None
