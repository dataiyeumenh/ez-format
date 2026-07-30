from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from app.parsing import parse_decimal


@dataclass(frozen=True)
class DocumentTotalsReport:
    document_count: int
    sum_total: str | None
    status: Literal["complete", "needs_review", "blocked"]
    issues: list[str]
    contributing_rows: list[int] = field(default_factory=list)


def aggregate_document_totals(
    rows: list[dict[str, object]],
    *,
    document_key_fields: list[str],
    line_amount_field: str | None,
    document_total_field: str | None,
) -> DocumentTotalsReport:
    """Aggregate line amounts and count repeated document totals once per key."""
    requires_document_key = document_total_field is not None
    if requires_document_key and not document_key_fields:
        return DocumentTotalsReport(0, None, "needs_review", ["missing_document_key"])

    issues: list[str] = []
    keys: dict[str, int] = {}
    document_totals: dict[str, Decimal] = {}
    line_total = Decimal("0")
    line_seen = False
    contributing_rows: list[int] = []

    for row_number, row in enumerate(rows, start=1):
        key: str | None = None
        if document_key_fields:
            key_parts = [str(row.get(field) or "").strip() for field in document_key_fields]
            if any(not part for part in key_parts):
                if "missing_document_key" not in issues:
                    issues.append("missing_document_key")
                if requires_document_key:
                    continue
            else:
                key = "|".join(key_parts).casefold()
                keys.setdefault(key, len(keys) + 1)

        if line_amount_field:
            raw_line = row.get(line_amount_field)
            if raw_line is not None and str(raw_line).strip() != "":
                amount = parse_decimal(raw_line)
                if amount is None:
                    if "invalid_line_amount" not in issues:
                        issues.append("invalid_line_amount")
                else:
                    line_total += amount
                    line_seen = True

        if document_total_field and key is not None:
            raw_total = row.get(document_total_field)
            if raw_total is None or str(raw_total).strip() == "":
                continue
            total = parse_decimal(raw_total)
            if total is None:
                if "invalid_document_total" not in issues:
                    issues.append("invalid_document_total")
                continue
            previous = document_totals.get(key)
            if previous is not None and previous != total:
                if "conflicting_document_total" not in issues:
                    issues.append("conflicting_document_total")
                contributing_rows.append(row_number)
            elif previous is None:
                document_totals[key] = total
                contributing_rows.append(row_number)

    if any(
        issue in issues
        for issue in (
            "conflicting_document_total",
            "invalid_line_amount",
            "invalid_document_total",
        )
    ):
        status = "blocked"
    elif "missing_document_key" in issues:
        status = "needs_review"
    else:
        status = "complete"

    if status != "complete":
        total_value = None
    elif line_amount_field and line_seen:
        total_value = line_total
    elif document_total_field and document_totals:
        total_value = sum(document_totals.values(), Decimal("0"))
    else:
        total_value = None

    if line_amount_field and line_seen:
        contributing_rows = [
            row_number
            for row_number, row in enumerate(rows, start=1)
            if parse_decimal(row.get(line_amount_field)) is not None
        ]

    return DocumentTotalsReport(
        document_count=len(keys),
        sum_total=str(total_value) if total_value is not None else None,
        status=status,
        issues=issues,
        contributing_rows=contributing_rows,
    )
