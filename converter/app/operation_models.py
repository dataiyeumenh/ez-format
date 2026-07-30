from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


ValidationSeverity = Literal["fatal", "blocker", "warning", "info"]
BlockingScope = Literal["system", "reconciliation", "export", "none"]
CorrectionEligibility = Literal["safe", "review_required", "forbidden"]


class DerivedRevision(BaseModel):
    revision: int
    parent_revision: int | None = None
    patch_set_id: str | None = None
    state_hash: str
    overlays: dict[str, dict[str, Any]] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
    created_by: str
    created_at: datetime


class NormalizedSession(BaseModel):
    session_id: str
    upload_id: str
    user_id: str | None = None
    workspace_id: str | None = None
    owner_scope: str
    target_template_id: str
    target_template_version: str
    source_signature: dict[str, Any] = Field(default_factory=dict)
    primary_table_id: str
    active_revision: int
    state_hash: str
    raw_sha256: str
    created_at: datetime
    expires_at: datetime
    revisions: list[DerivedRevision] = Field(default_factory=list)
    audit_events: list[dict[str, Any]] = Field(default_factory=list)


class ValidationIssueV2(BaseModel):
    id: str
    rule_id: str
    severity: ValidationSeverity
    blocking_scope: BlockingScope
    deterministic: bool
    row_id: str | None = None
    row: int | None = None
    field: str | None = None
    actual: Any = None
    expected: Any = None
    evidence_ids: list[str] = Field(default_factory=list)
    correction_eligibility: CorrectionEligibility = "forbidden"
    message: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvidenceItem(BaseModel):
    evidence_id: str
    type: Literal[
        "file_cell", "calculation", "misa_document", "legal_source", "ai_suggestion"
    ]
    label: str
    locator: dict[str, Any] | None = None
    value: Any = None
    operands: list[dict[str, Any]] = Field(default_factory=list)
    source_url: str | None = None
    effective_from: str | None = None
    effective_to: str | None = None


class EvidencePacket(BaseModel):
    packet_id: str
    session_id: str
    owner_scope: str
    revision: int
    state_hash: str
    expires_at: datetime
    items: list[EvidenceItem] = Field(default_factory=list)
    seal: str


class ReconciliationSummaryV2(BaseModel):
    matched: int = 0
    missing_primary: int = 0
    missing_comparison: int = 0
    conflicts: int = 0
    candidates_need_review: int = 0
    rejected_candidates: int = 0
    deferred_candidates: int = 0


class ReconciliationReportV2(BaseModel):
    report_id: str
    session_id: str
    revision: int
    status: Literal[
        "not_run", "partial", "complete", "insufficient_evidence", "conflict"
    ]
    roles_present: list[str] = Field(default_factory=list)
    summary: ReconciliationSummaryV2 = Field(default_factory=ReconciliationSummaryV2)
    totals: list[dict[str, Any]] = Field(default_factory=list)
    records: list[dict[str, Any]] = Field(default_factory=list)
    tolerances: dict[str, Any] = Field(default_factory=dict)
    usable_evidence: bool = False
    state_hash: str
