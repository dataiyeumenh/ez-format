import pytest

from app.student_reports import (
    ReportValidationError,
    build_internship_markdown_report,
)


def _signed_session_metadata():
    return {
        "activities": [
            {
                "id": "activity-1",
                "event_type": "analysis_completed",
                "skill": "Excel mapping",
                "summary": "Mapped the invoice columns with evidence.",
                "evidence_count": 4,
                "resolved_issues": ["Missing tax code mapping"],
            }
        ]
    }


def test_report_contains_only_selected_verified_activity_and_approved_note():
    report = build_internship_markdown_report(
        file_metadata={"filename": "student.xlsx", "sheet_count": 2, "row_count": 8},
        signed_session_metadata=_signed_session_metadata(),
        activity_ids=["activity-1"],
        approved_notes=["Reviewed the mapping with the supervisor."],
        confidential_values={},
    )

    assert "# Internship Handoff Report" in report
    assert "## File metadata" in report
    assert "## Verified actions" in report
    assert "Mapped the invoice columns with evidence." in report
    assert "## Resolved issues" in report
    assert "## Skills" in report
    assert "## Handoff checklist" in report
    assert "Reviewed the mapping with the supervisor." in report


def test_report_rejects_activity_not_in_signed_session_metadata():
    with pytest.raises(ReportValidationError, match="activity-2"):
        build_internship_markdown_report(
            file_metadata={"filename": "student.xlsx"},
            signed_session_metadata=_signed_session_metadata(),
            activity_ids=["activity-2"],
            approved_notes=[],
            confidential_values={},
        )


def test_report_rejects_unsafe_approved_note():
    with pytest.raises(ReportValidationError, match="approved note"):
        build_internship_markdown_report(
            file_metadata={"filename": "student.xlsx"},
            signed_session_metadata=_signed_session_metadata(),
            activity_ids=["activity-1"],
            approved_notes=["<script>alert(1)</script>"],
            confidential_values={},
        )


def test_report_rejects_confidential_values_before_rendering_markdown():
    with pytest.raises(ReportValidationError, match="company"):
        build_internship_markdown_report(
            file_metadata={"filename": "student.xlsx"},
            signed_session_metadata=_signed_session_metadata(),
            activity_ids=["activity-1"],
            approved_notes=["Công ty TNHH Sao Mai"],
            confidential_values={"company": ["Công ty TNHH Sao Mai"]},
        )


def test_report_sanitizes_filename_and_sheet_metadata_by_default():
    report = build_internship_markdown_report(
        file_metadata={
            "filename": "Khach Hang Tuyet Mat.xlsx",
            "sheet_name": "Cong ty Sao Mai",
            "row_count": 8,
        },
        signed_session_metadata=_signed_session_metadata(),
        activity_ids=["activity-1"],
        approved_notes=[],
        confidential_values={},
    )

    assert "Khach Hang Tuyet Mat" not in report
    assert "Cong ty Sao Mai" not in report
    assert "student-workbook.xlsx" in report
    assert "Worksheet" in report
