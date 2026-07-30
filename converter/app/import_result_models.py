from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ImportResultSchemaError(ValueError):
    """Raised when a generic import-result workbook cannot be safely mapped."""


class ImportResultAdapter(BaseModel):
    id: Literal["manual_excel_v1"] = "manual_excel_v1"
    verified: Literal[False] = False


class ImportResultColumnRoles(BaseModel):
    technical_message: str = Field(min_length=1, max_length=256)
    source_row_number: str | None = Field(default=None, max_length=256)
    document_number: str | None = Field(default=None, max_length=256)
    invoice_number: str | None = Field(default=None, max_length=256)
    document_date: str | None = Field(default=None, max_length=256)
    partner_code: str | None = Field(default=None, max_length=256)
    item_code: str | None = Field(default=None, max_length=256)
    amount: str | None = Field(default=None, max_length=256)


class ImportResultColumnMapping(BaseModel):
    sheet_name: str = Field(min_length=1, max_length=128)
    header_row: int = Field(ge=1)
    columns: ImportResultColumnRoles


class NormalizedImportIssue(BaseModel):
    issue_key: str
    artifact_row_number: int
    technical_message: str
    locator: dict[str, str | int | None]
    category: str = "unclassified"
    severity: Literal["blocker", "warning", "info"] = "warning"
    import_status: Literal["unknown", "match"] = "unknown"
    retry_blocked: bool = True


class ImportResultSelectionCandidate(BaseModel):
    sheet_name: str
    header_row: int = Field(ge=1)
    headers: list[str]


class ImportResultInspection(BaseModel):
    adapter: ImportResultAdapter = Field(default_factory=ImportResultAdapter)
    status: Literal["needs_schema_mapping"] = "needs_schema_mapping"
    artifact_type: Literal["unknown"] = "unknown"
    sheet_name: str
    header_row: int = Field(ge=1)
    headers: list[str]
    sample_rows: list[dict[str, str]] = Field(default_factory=list, max_length=20)
    warnings: list[dict[str, str]] = Field(default_factory=list)
    candidates: list[ImportResultSelectionCandidate] = Field(default_factory=list)
    selection_ambiguous: bool = False
