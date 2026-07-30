from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


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
    sheet_name: str | None = None


class ExportManifestRow(BaseModel):
    model_config = ConfigDict(frozen=True)

    export_row_id: str
    output_row_number: int
    document_group_id: str
    raw_row_ids: list[str]
    locator: dict[str, str | None]
    line_fingerprint: str


class ExportManifestV1(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = 1
    conversion_id: str
    export_batch_id: str
    misa_product: Literal["SME"] = "SME"
    misa_version: str | None = None
    target_template_id: str
    template_hash: str
    raw_file_hash: str
    mapping_profile_id: str
    mapping_profile_version: int
    mapping_profile_state_hash: str | None = None
    validation_ruleset_version: str
    rows: list[ExportManifestRow]
    document_groups: list[dict[str, Any]]


ReadinessSeverity = Literal["blocker", "warning", "info"]
ReadinessStatus = Literal["ready", "needs_review", "blocked"]


class MisaReadinessIssue(BaseModel):
    severity: ReadinessSeverity
    category: str
    code: str
    message: str
    row: int | None = None
    field: str | None = None
    invoice: str | None = None
    expected: Any = None
    actual: Any = None
    delta: Any = None
    fix_hint: str | None = None
    source_url: str | None = None


class MisaReadinessSummary(BaseModel):
    blocker: int = 0
    warning: int = 0
    info: int = 0


class MisaReconciliationReport(BaseModel):
    input_rows: int
    output_rows: int
    invoice_count: int | None = None
    sum_amount: str | None = None
    sum_vat: str | None = None
    sum_total: str | None = None
    unmapped_source_columns: list[str] = Field(default_factory=list)


class MisaReadinessReport(BaseModel):
    ok: bool
    status: ReadinessStatus
    score: int
    summary: MisaReadinessSummary
    issues: list[MisaReadinessIssue]
    reconciliation: MisaReconciliationReport
    disclaimer: str
    master_data: dict[str, Any] | None = None
