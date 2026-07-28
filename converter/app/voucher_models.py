from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


FieldTrust = Literal["verified", "supported", "suggested", "missing", "conflict"]
IssueSeverity = Literal["blocker", "warning", "info"]
DraftStatus = Literal["ready", "needs_review", "blocked"]
VoucherDirection = Literal["purchase", "sales", "unknown"]
VoucherNature = Literal["goods", "service", "mixed", "unknown"]


class SourceReference(BaseModel):
    sheet: str
    row: int
    column: str | None = None
    header: str | None = None


class FieldProvenance(BaseModel):
    source: Literal[
        "source_direct",
        "source_fill_down",
        "workspace_master_data",
        "confirmed_alias",
        "approved_profile",
        "deterministic_derived",
        "ai_suggestion",
        "manual",
    ]
    references: list[SourceReference] = Field(default_factory=list)
    note: str | None = None


class VoucherField(BaseModel):
    value: Any = None
    trust: FieldTrust = "missing"
    provenance: list[FieldProvenance] = Field(default_factory=list)


class ReconstructionIssue(BaseModel):
    severity: IssueSeverity
    code: str
    message: str
    field: str | None = None
    source_rows: list[int] = Field(default_factory=list)
    expected: Any = None
    actual: Any = None
    fix_hint: str | None = None


class VoucherLineDraft(BaseModel):
    id: str
    sequence: int
    nature: VoucherNature
    nature_trust: FieldTrust
    fields: dict[str, VoucherField]
    source_rows: list[int]
    issues: list[ReconstructionIssue] = Field(default_factory=list)


class VoucherTotals(BaseModel):
    amount: str = "0"
    discount: str = "0"
    vat: str = "0"
    payment: str = "0"


class VoucherDraft(BaseModel):
    id: str
    revision: int = 1
    direction: VoucherDirection
    direction_trust: FieldTrust
    nature: VoucherNature
    nature_trust: FieldTrust
    document_kind: str
    template_id: str | None = None
    status: DraftStatus
    header: dict[str, VoucherField]
    lines: list[VoucherLineDraft]
    totals: VoucherTotals
    source_rows: list[int]
    issues: list[ReconstructionIssue] = Field(default_factory=list)


class RowConservation(BaseModel):
    source_rows: int
    assigned_rows: int
    ignored_rows: int = 0
    unresolved_rows: int = 0


class ReconstructionSummary(BaseModel):
    draft_count: int
    ready: int
    needs_review: int
    blocked: int
    purchase_goods: int = 0
    purchase_services: int = 0
    sales_goods: int = 0
    sales_services: int = 0
    mixed: int = 0
    unknown: int = 0


class VoucherReconstructionReport(BaseModel):
    source_signature_hash: str
    sheet_name: str
    detected_columns: dict[str, str]
    drafts: list[VoucherDraft]
    summary: ReconstructionSummary
    row_conservation: RowConservation
    issues: list[ReconstructionIssue] = Field(default_factory=list)
    engine_version: str = "phase3-v1"
    disclaimer: str = (
        "Hệ thống tái tạo chứng từ từ dữ liệu nguồn và rule xác định. "
        "Các gợi ý nghiệp vụ vẫn cần kế toán kiểm tra trước khi import MISA."
    )
