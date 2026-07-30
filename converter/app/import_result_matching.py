from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.import_result_models import NormalizedImportIssue
from app.models import ExportManifestRow, ExportManifestV1


_BUSINESS_FIELDS = (
    "document_number",
    "invoice_number",
    "document_date",
    "partner_code",
    "item_code",
    "amount",
)
_PRIMARY_BUSINESS_FIELDS = {"document_number", "invoice_number"}
_FINGERPRINT_FIELD = "line_fingerprint"
_MAX_CANDIDATES = 5


class MatchCandidate(BaseModel):
    export_row_id: str
    output_row_number: int
    document_group_id: str
    locator: dict[str, str | None]
    matched_fields: list[str] = Field(default_factory=list)
    mismatched_fields: list[str] = Field(default_factory=list)


class MatchSuggestion(BaseModel):
    status: Literal["suggested", "ambiguous", "unmatched"]
    method: Literal["exact_fingerprint", "exact_business_key", "none"]
    requires_user_confirmation: Literal[True] = True
    candidates: list[MatchCandidate] = Field(default_factory=list, max_length=_MAX_CANDIDATES)


def suggest_issue_matches(
    issue: NormalizedImportIssue,
    manifest: ExportManifestV1,
) -> MatchSuggestion:
    fingerprint = issue.locator.get(_FINGERPRINT_FIELD)
    if _has_value(fingerprint):
        matches = [
            row
            for row in manifest.rows
            if row.line_fingerprint == fingerprint
        ]
        return _suggestion(
            method="exact_fingerprint",
            rows=matches,
            issue_locator=issue.locator,
            matched_fields=[_FINGERPRINT_FIELD],
        )

    business_fields = _business_fields(issue.locator)
    if not business_fields or not _PRIMARY_BUSINESS_FIELDS.intersection(business_fields):
        return _unmatched()

    matches = [
        row
        for row in manifest.rows
        if all(row.locator.get(name) == value for name, value in business_fields.items())
    ]
    return _suggestion(
        method="exact_business_key",
        rows=matches,
        issue_locator=issue.locator,
        matched_fields=list(business_fields),
    )


def _business_fields(locator: dict[str, str | int | None]) -> dict[str, str | int]:
    fields: dict[str, str | int] = {}
    for name in _BUSINESS_FIELDS:
        value = locator.get(name)
        if _has_value(value):
            fields[name] = value
    return fields


def _has_value(value: object) -> bool:
    return value is not None and value != ""


def _suggestion(
    *,
    method: Literal["exact_fingerprint", "exact_business_key"],
    rows: list[ExportManifestRow],
    issue_locator: dict[str, str | int | None],
    matched_fields: list[str],
) -> MatchSuggestion:
    if not rows:
        return _unmatched()
    status: Literal["suggested", "ambiguous"] = (
        "suggested" if len(rows) == 1 else "ambiguous"
    )
    return MatchSuggestion(
        status=status,
        method=method,
        candidates=[
            _candidate(row, issue_locator, matched_fields)
            for row in rows[:_MAX_CANDIDATES]
        ],
    )


def _candidate(
    row: ExportManifestRow,
    issue_locator: dict[str, str | int | None],
    matched_fields: list[str],
) -> MatchCandidate:
    mismatched_fields = [
        name
        for name in _BUSINESS_FIELDS
        if _has_value(issue_locator.get(name))
        and issue_locator.get(name) != row.locator.get(name)
    ]
    return MatchCandidate(
        export_row_id=row.export_row_id,
        output_row_number=row.output_row_number,
        document_group_id=row.document_group_id,
        locator=row.locator,
        matched_fields=matched_fields,
        mismatched_fields=mismatched_fields,
    )


def _unmatched() -> MatchSuggestion:
    return MatchSuggestion(status="unmatched", method="none")
