from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


EvidenceKind = Literal["source_cell", "source_column", "rule", "template"]
ExplanationKind = Literal[
    "mapping",
    "field",
    "normalization",
    "issue",
    "calculation",
    "master_data",
    "unsupported",
]
ExplanationSeverity = Literal["blocker", "warning", "info", "none"]
QuestionIntent = Literal[
    "file_summary",
    "locate_column",
    "locate_rows",
    "explain_mapping",
    "explain_issue",
    "aggregate_amount",
    "count_documents",
    "find_duplicates",
    "find_vat_mismatches",
    "required_actions_before_export",
    "concept_explanation",
    "unsupported_legal_or_business_judgment",
]
QuestionOutcome = Literal["supported", "unsupported", "ai_unavailable"]
QuestionEvidenceKind = Literal["source_cell", "source_column", "issue", "template"]

class StudentEvidence(BaseModel):
    kind: EvidenceKind
    source_ref: str = Field(min_length=1)
    sheet: str | None = None
    row: int | None = Field(default=None, ge=1)
    column: str | None = None
    raw_value: Any = None
    rule_id: str | None = None
    source_url: str | None = None
    checked_at: str | None = None
    effective_from: str | None = None
    effective_to: str | None = None


class StudentExplanation(BaseModel):
    id: str = Field(min_length=1)
    kind: ExplanationKind
    severity: ExplanationSeverity = "none"
    deterministic: bool = True
    target_field: str | None = None
    title: str = Field(min_length=1)
    meaning_vi: str = Field(min_length=1)
    reason_vi: str = Field(min_length=1)
    impact_vi: str | None = None
    fix_hint_vi: str = Field(min_length=1)
    normalized_value: Any = None
    evidence: list[StudentEvidence] = Field(default_factory=list)
    claim_sources: list[str] = Field(default_factory=list)
    preview_row: int | None = Field(default=None, ge=1)
    issue_code: str | None = None
    issue_row: int | None = Field(default=None, ge=1)
    state_hash: str = ""
    stale: bool = False

    @model_validator(mode="after")
    def deterministic_explanations_require_evidence(self) -> "StudentExplanation":
        if self.deterministic and not self.evidence:
            raise ValueError("Deterministic student explanation requires evidence")
        return self


class StudentFileSummary(BaseModel):
    session_id: str = Field(min_length=1)
    upload_id: str = Field(min_length=1)
    file_name: str = ""
    target_template_id: str = Field(min_length=1)
    sheet_name: str = ""
    header_row: int = Field(ge=1)
    data_row_count: int = Field(ge=0)
    document_count: int | None = Field(default=None, ge=0)
    recognized_columns: int = Field(ge=0)
    unresolved_columns: int = Field(ge=0)
    mapping_counts: dict[str, int] = Field(default_factory=dict)
    issue_counts: dict[str, int] = Field(default_factory=dict)
    master_data_status: str = "not_configured"
    reconcilable_totals: dict[str, Any] = Field(default_factory=dict)
    explanation_count: int = Field(default=0, ge=0)
    state_hash: str = ""
    stale: bool = False


class StudentAnswerEvidence(BaseModel):
    id: str = Field(min_length=1)
    kind: QuestionEvidenceKind
    sheet: str | None = None
    row: int | None = Field(default=None, ge=1)
    field: str | None = None
    target_field: str | None = None
    actual: Any = None
    expected: Any = None
    issue_code: str | None = None


class StudentAnswer(BaseModel):
    answer: str = Field(min_length=1)
    intent: QuestionIntent
    answer_type: Literal[
        "deterministic_file_query",
        "deterministic_explanation",
        "unsupported",
    ]
    confidence: Literal["verified", "not_available"]
    evidence: list[StudentAnswerEvidence] = Field(default_factory=list)
    evidence_count: int = Field(default=0, ge=0)
    rule_sources: list[str] = Field(default_factory=list)
    needs_professional_review: bool = False
    unsupported_reason: str | None = None
    outcome: QuestionOutcome

    @model_validator(mode="after")
    def supported_answers_require_evidence(self) -> "StudentAnswer":
        if self.outcome == "supported" and not self.evidence:
            raise ValueError("Supported student answer requires evidence")
        if self.outcome != "supported" and self.evidence:
            raise ValueError("Unsupported student answer cannot contain evidence")
        if self.evidence_count < len(self.evidence):
            raise ValueError("Student answer evidence_count is smaller than evidence")
        return self


class StudentQuestionRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)


class StudentAnonymizationRequest(BaseModel):
    full_document_numbers: bool = False


class StudentInternshipReportRequest(BaseModel):
    activity_ids: list[str] = Field(min_length=1, max_length=100)
    approved_notes: list[str] = Field(default_factory=list, max_length=50)
