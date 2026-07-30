import pytest

import app.student_reports as reports_module
from app.student_anonymization import AnonymizationSession
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


def _anonymization_session():
    return AnonymizationSession("student-report-session", "student-report-secret")


def test_report_contains_only_selected_verified_activity_and_approved_note():
    report = build_internship_markdown_report(
        file_metadata={"filename": "student.xlsx", "sheet_count": 2, "row_count": 8},
        signed_session_metadata=_signed_session_metadata(),
        activity_ids=["activity-1"],
        approved_notes=["Reviewed the mapping with the supervisor."],
        confidential_values={},
        anonymization_session=_anonymization_session(),
    )

    assert "# Internship Handoff Report" in report
    assert "## File metadata" in report
    assert "## Verified actions" in report
    assert "Mapped the invoice columns with evidence." not in report
    assert "## Resolved issues" in report
    assert "## Skills" in report
    assert "## Handoff checklist" in report
    assert "Reviewed the mapping with the supervisor." not in report
    assert "TEXT-" in report


def test_report_rejects_activity_not_in_signed_session_metadata():
    with pytest.raises(ReportValidationError, match="activity-2"):
        build_internship_markdown_report(
            file_metadata={"filename": "student.xlsx"},
            signed_session_metadata=_signed_session_metadata(),
            activity_ids=["activity-2"],
            approved_notes=[],
            confidential_values={},
            anonymization_session=_anonymization_session(),
        )


def test_report_rejects_unsafe_approved_note():
    with pytest.raises(ReportValidationError, match="approved note"):
        build_internship_markdown_report(
            file_metadata={"filename": "student.xlsx"},
            signed_session_metadata=_signed_session_metadata(),
            activity_ids=["activity-1"],
            approved_notes=["<script>alert(1)</script>"],
            confidential_values={},
            anonymization_session=_anonymization_session(),
        )


def test_report_redacts_confidential_values_before_rendering_markdown():
    report = build_internship_markdown_report(
        file_metadata={"filename": "student.xlsx"},
        signed_session_metadata=_signed_session_metadata(),
        activity_ids=["activity-1"],
        approved_notes=["Công ty TNHH Sao Mai"],
        confidential_values={"company": ["Công ty TNHH Sao Mai"]},
        anonymization_session=_anonymization_session(),
    )

    assert "Công ty TNHH Sao Mai" not in report
    assert "COMPANY-" in report


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
        anonymization_session=_anonymization_session(),
    )

    assert "Khach Hang Tuyet Mat" not in report
    assert "Cong ty Sao Mai" not in report
    assert "student-workbook.xlsx" in report
    assert "Worksheet" in report


def test_report_conservatively_redacts_names_cccd_addresses_and_unknown_text():
    signed = _signed_session_metadata()
    signed["activities"][0].update(
        {
            "summary": "Đinh Thị Thu Hương reviewed 079203001234",
            "resolved_issues": ["Visit 12 Nguyen Trai"],
        }
    )
    sensitive = (
        "Đinh Thị Thu Hương",
        "079203001234",
        "12 Nguyen Trai",
        "Nguyễn Văn An",
    )

    report = build_internship_markdown_report(
        file_metadata={"filename": "student.xlsx", "row_count": 12},
        signed_session_metadata=signed,
        activity_ids=["activity-1"],
        approved_notes=["Nguyễn Văn An lives at 12 Nguyen Trai"],
        confidential_values={},
        anonymization_session=_anonymization_session(),
    )

    assert all(value.casefold() not in report.casefold() for value in sensitive)
    assert "TEXT-" in report


def test_report_independent_post_scan_rejects_primary_redaction_regression(monkeypatch):
    signed = _signed_session_metadata()
    signed["activities"][0]["summary"] = (
        "Nguyễn Văn An - 079203001234 - 12 Nguyen Trai"
    )
    monkeypatch.setattr(
        reports_module,
        "_sanitize_report_text",
        lambda value, *_args, **_kwargs: str(value),
    )

    with pytest.raises(ReportValidationError, match="post-scan"):
        build_internship_markdown_report(
            file_metadata={"filename": "student.xlsx"},
            signed_session_metadata=signed,
            activity_ids=["activity-1"],
            approved_notes=[],
            confidential_values={},
            anonymization_session=_anonymization_session(),
        )
