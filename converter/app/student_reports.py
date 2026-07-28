from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from app.student_anonymization import scan_confidential_values


class ReportValidationError(ValueError):
    """Raised when report inputs cannot safely be rendered as Markdown."""


_FILE_METADATA_FIELDS = (
    ("filename", "Filename"),
    ("sheet_name", "Worksheet"),
    ("sheet_count", "Worksheet count"),
    ("row_count", "Row count"),
    ("template_id", "Target template"),
)
_UNSAFE_NOTE_MARKERS = ("<", ">", "[", "]", "`", "http://", "https://")


def build_internship_markdown_report(
    *,
    file_metadata: Mapping[str, Any],
    signed_session_metadata: Mapping[str, Any],
    activity_ids: Iterable[str],
    approved_notes: Iterable[str],
    confidential_values: Mapping[str, Iterable[Any]],
) -> str:
    """Render a report solely from trusted activities and explicitly approved notes."""
    selected_activities = _select_verified_activities(
        signed_session_metadata,
        activity_ids,
    )
    metadata = _safe_file_metadata(file_metadata)
    notes = _approved_notes(approved_notes)
    render_payload = {
        "file_metadata": metadata,
        "activities": selected_activities,
        "approved_notes": notes,
    }
    _reject_confidential_values(render_payload, confidential_values)

    lines = ["# Internship Handoff Report", "", "## File metadata"]
    lines.extend(f"- {label}: {_markdown_text(value)}" for label, value in metadata.items())

    lines.extend(["", "## Verified actions"])
    for activity in selected_activities:
        lines.append(
            "- "
            f"{_markdown_text(activity['skill'])} "
            f"({_markdown_text(activity['event_type'])}; evidence: {activity['evidence_count']}): "
            f"{_markdown_text(activity['summary'])}"
        )

    lines.extend(["", "## Resolved issues"])
    resolved_issues = [
        issue for activity in selected_activities for issue in activity["resolved_issues"]
    ]
    lines.extend(f"- {_markdown_text(issue)}" for issue in resolved_issues)
    if not resolved_issues:
        lines.append("- No verified resolved issues were supplied.")

    lines.extend(["", "## Skills"])
    skills = _skill_summary(selected_activities)
    lines.extend(
        f"- {_markdown_text(skill)}: {count} verified action(s), {evidence} evidence item(s)"
        for skill, (count, evidence) in skills.items()
    )

    if notes:
        lines.extend(["", "## Approved notes"])
        lines.extend(f"- {_markdown_text(note)}" for note in notes)

    lines.extend(
        [
            "",
            "## Handoff checklist",
            "- [ ] Confirm the anonymized workbook has been reviewed before sharing.",
            "- [ ] Verify the selected actions match the signed session history.",
            "- [ ] Confirm any remaining follow-up work with the supervisor.",
        ]
    )
    report = "\n".join(lines) + "\n"
    _reject_confidential_values(report, confidential_values)
    return report


def _select_verified_activities(
    signed_session_metadata: Mapping[str, Any],
    activity_ids: Iterable[str],
) -> list[dict[str, Any]]:
    if not isinstance(signed_session_metadata, Mapping):
        raise ReportValidationError("signed session metadata is required")
    supplied = signed_session_metadata.get("activities")
    if not isinstance(supplied, list):
        raise ReportValidationError("signed session metadata must contain activities")
    verified = {}
    for activity in supplied:
        if not isinstance(activity, Mapping):
            raise ReportValidationError("signed activity must be an object")
        normalized = _normalize_activity(activity)
        if normalized["id"] in verified:
            raise ReportValidationError(f"duplicate signed activity id: {normalized['id']}")
        verified[normalized["id"]] = normalized

    requested = [str(activity_id or "").strip() for activity_id in activity_ids]
    if not requested or any(not activity_id for activity_id in requested):
        raise ReportValidationError("at least one verified activity id is required")
    if len(set(requested)) != len(requested):
        raise ReportValidationError("activity ids must not be repeated")
    missing = [activity_id for activity_id in requested if activity_id not in verified]
    if missing:
        raise ReportValidationError(
            "activity ids are not present in signed session metadata: " + ", ".join(missing)
        )
    return [verified[activity_id] for activity_id in requested]


def _normalize_activity(activity: Mapping[str, Any]) -> dict[str, Any]:
    activity_id = _required_text(activity.get("id"), "signed activity id")
    event_type = _required_text(activity.get("event_type"), "signed activity event type")
    skill = _required_text(activity.get("skill"), "signed activity skill")
    summary = _required_text(activity.get("summary"), "signed activity summary")
    try:
        evidence_count = int(activity.get("evidence_count", 0))
    except (TypeError, ValueError) as exc:
        raise ReportValidationError("signed activity evidence count must be an integer") from exc
    if evidence_count < 0:
        raise ReportValidationError("signed activity evidence count must not be negative")
    resolved_issues = activity.get("resolved_issues") or []
    if not isinstance(resolved_issues, list):
        raise ReportValidationError("signed activity resolved issues must be a list")
    return {
        "id": activity_id,
        "event_type": event_type,
        "skill": skill,
        "summary": summary,
        "evidence_count": evidence_count,
        "resolved_issues": [
            _required_text(issue, "signed activity resolved issue")
            for issue in resolved_issues
        ],
    }


def _safe_file_metadata(file_metadata: Mapping[str, Any]) -> dict[str, str]:
    if not isinstance(file_metadata, Mapping):
        raise ReportValidationError("file metadata is required")
    metadata: dict[str, str] = {}
    for key, label in _FILE_METADATA_FIELDS:
        if key not in file_metadata or file_metadata[key] is None:
            continue
        if key == "filename":
            suffix = Path(_required_text(file_metadata[key], "file metadata filename")).suffix.lower()
            metadata[label] = f"student-workbook{suffix if suffix in {'.xls', '.xlsx'} else ''}"
        elif key == "sheet_name":
            _required_text(file_metadata[key], "file metadata sheet_name")
            metadata[label] = "Worksheet"
        else:
            metadata[label] = _required_text(file_metadata[key], f"file metadata {key}")
    if not metadata:
        raise ReportValidationError("at least one file metadata field is required")
    return metadata


def _approved_notes(notes: Iterable[str]) -> list[str]:
    approved = []
    for note in notes:
        value = _required_text(note, "approved note")
        if "\n" in value or any(marker in value.casefold() for marker in _UNSAFE_NOTE_MARKERS):
            raise ReportValidationError("approved note contains unsafe Markdown content")
        approved.append(value)
    return approved


def _skill_summary(activities: Iterable[Mapping[str, Any]]) -> dict[str, tuple[int, int]]:
    summary: dict[str, tuple[int, int]] = {}
    for activity in activities:
        skill = str(activity["skill"])
        count, evidence = summary.get(skill, (0, 0))
        summary[skill] = (count + 1, evidence + int(activity["evidence_count"]))
    return summary


def _reject_confidential_values(
    payload: Any,
    confidential_values: Mapping[str, Iterable[Any]],
) -> None:
    matches = scan_confidential_values(payload, confidential_values)
    if matches:
        raise ReportValidationError(
            "report contains confidential values in: " + ", ".join(matches)
        )


def _required_text(value: Any, label: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ReportValidationError(f"{label} is required")
    return normalized


def _markdown_text(value: Any) -> str:
    return str(value).replace("\\", "\\\\").replace("*", "\\*").replace("_", "\\_")
