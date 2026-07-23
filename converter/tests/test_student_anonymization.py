from pathlib import Path
from io import BytesIO

import pytest
from openpyxl import Workbook, load_workbook
import xlrd
import xlwt

from app.student_anonymization import (
    AnonymizationSession,
    AnonymizationExportError,
    anonymize_workbook_bytes,
    scan_confidential_values,
)


ROOT = Path(__file__).resolve().parents[2]
FEATURE_FLAGS = {
    "STUDENT_ASSISTANT_ENABLED",
    "STUDENT_FILE_EXPLAIN_ENABLED",
    "STUDENT_FILE_QA_ENABLED",
    "STUDENT_CHECK_WORK_ENABLED",
    "STUDENT_ACCOUNTING_MAP_ENABLED",
    "STUDENT_RECONCILIATION_ENABLED",
    "STUDENT_INTERNSHIP_ENABLED",
}


def test_anonymization_is_stable_within_the_same_session_and_category():
    first = AnonymizationSession("session-1", "secret")
    second = AnonymizationSession("session-1", "secret")

    replacement = first.replace("company", "Công ty TNHH Sao Mai")

    assert replacement == first.replace("company", "Công ty TNHH Sao Mai")
    assert replacement == second.replace("company", "Công ty TNHH Sao Mai")
    assert replacement != AnonymizationSession("session-2", "secret").replace(
        "company", "Công ty TNHH Sao Mai"
    )


def test_anonymization_categories_do_not_collide_for_the_same_source_value():
    session = AnonymizationSession("session-1", "secret")

    replacements = {
        category: session.replace(category, "0012345678")
        for category in (
            "company",
            "counterparty",
            "tax_code",
            "address",
            "email",
            "phone",
            "bank_account",
            "document_number",
        )
    }

    assert len(set(replacements.values())) == len(replacements)


def test_anonymization_preserves_blanks_and_numeric_identifiers_as_text():
    session = AnonymizationSession("session-1", "secret")

    assert session.replace("company", None) is None
    assert session.replace("company", "") == ""
    assert session.replace("company", "   ") == "   "
    tax_code = session.replace("tax_code", "0012345678")

    assert isinstance(tax_code, str)
    assert tax_code.startswith("TAX-00")


def test_anonymization_rejects_unknown_categories():
    session = AnonymizationSession("session-1", "secret")

    with pytest.raises(ValueError, match="category"):
        session.replace("password", "secret")


def test_confidential_scanner_reports_categories_without_returning_raw_values():
    matches = scan_confidential_values(
        {
            "summary": "Công ty TNHH Sao Mai",
            "rows": [{"tax_code": "0012345678"}, {"note": "safe"}],
        },
        {
            "company": ["Công ty TNHH Sao Mai"],
            "tax_code": ["0012345678"],
            "phone": ["0900000000"],
        },
    )

    assert matches == ("company", "tax_code")
    assert "Công ty TNHH Sao Mai" not in matches
    assert "0012345678" not in matches


def test_anonymize_xlsx_returns_a_scanned_copy_without_mutating_original_bytes():
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(["Company"])
    worksheet.append(["Công ty TNHH Sao Mai"])
    original_stream = BytesIO()
    workbook.save(original_stream)
    original = original_stream.getvalue()

    exported = anonymize_workbook_bytes(
        filename="student.xlsx",
        content=original,
        session=AnonymizationSession("session-1", "secret"),
        confidential_values={"company": ["Công ty TNHH Sao Mai"]},
    )

    anonymized = load_workbook(BytesIO(exported.content), data_only=False)
    assert original == original_stream.getvalue()
    assert anonymized.active["A2"].value != "Công ty TNHH Sao Mai"
    assert exported.replaced_categories == ("company",)


def test_anonymize_xlsx_refuses_export_when_a_confidential_formula_remains():
    workbook = Workbook()
    worksheet = workbook.active
    worksheet["A1"] = '=CONCAT("Công ty TNHH Sao Mai")'
    stream = BytesIO()
    workbook.save(stream)

    with pytest.raises(AnonymizationExportError, match="company"):
        anonymize_workbook_bytes(
            filename="student.xlsx",
            content=stream.getvalue(),
            session=AnonymizationSession("session-1", "secret"),
            confidential_values={"company": ["Công ty TNHH Sao Mai"]},
        )


def test_anonymize_xlsx_replaces_confidential_tokens_case_insensitively():
    workbook = Workbook()
    worksheet = workbook.active
    worksheet["A1"] = "CÔNG TY TNHH SAO MAI"
    stream = BytesIO()
    workbook.save(stream)

    exported = anonymize_workbook_bytes(
        filename="student.xlsx",
        content=stream.getvalue(),
        session=AnonymizationSession("session-1", "secret"),
        confidential_values={"company": ["Công ty TNHH Sao Mai"]},
    )

    assert "công ty tnhh sao mai" not in str(
        load_workbook(BytesIO(exported.content)).active["A1"].value
    ).casefold()


def test_anonymize_xlsx_accepts_a_single_confidential_string_value():
    workbook = Workbook()
    worksheet = workbook.active
    worksheet["A1"] = "Công ty TNHH Sao Mai"
    stream = BytesIO()
    workbook.save(stream)

    exported = anonymize_workbook_bytes(
        filename="student.xlsx",
        content=stream.getvalue(),
        session=AnonymizationSession("session-1", "secret"),
        confidential_values={"company": "Công ty TNHH Sao Mai"},
    )

    assert exported.replaced_categories == ("company",)


def test_anonymize_xls_preserves_cell_format_and_replaces_all_sensitive_categories():
    source = xlwt.Workbook()
    worksheet = source.add_sheet("Students")
    values = {
        "company": "Công ty TNHH Sao Mai",
        "counterparty": "Nhà cung cấp Sao Mai",
        "tax_code": "0012345678",
        "address": "1 Đường Mới",
        "email": "mai@example.com",
        "phone": "0900000000",
        "bank_account": "0011223344",
        "document_number": "HD-001",
    }
    style = xlwt.easyxf("font: bold on")
    for column_index, value in enumerate(values.values()):
        worksheet.write(0, column_index, value, style)
    original_stream = BytesIO()
    source.save(original_stream)
    original = original_stream.getvalue()
    original_xf = xlrd.open_workbook(
        file_contents=original, formatting_info=True
    ).sheet_by_index(0).cell(0, 0).xf_index

    exported = anonymize_workbook_bytes(
        filename="student.xls",
        content=original,
        session=AnonymizationSession("session-1", "secret"),
        confidential_values={category: [value] for category, value in values.items()},
        full_document_numbers=True,
    )

    anonymized = xlrd.open_workbook(file_contents=exported.content, formatting_info=True)
    row = anonymized.sheet_by_index(0).row_values(0)
    assert original == original_stream.getvalue()
    assert not set(values.values()).intersection(row)
    assert anonymized.sheet_by_index(0).cell(0, 0).xf_index == original_xf
    assert exported.replaced_categories == tuple(values)
    assert exported.warnings


def test_student_feature_flags_and_retention_values_are_documented():
    root_env = (ROOT / ".env.example").read_text(encoding="utf-8")
    converter_env = (ROOT / "converter" / ".env.example").read_text(encoding="utf-8")
    frontend_env = (ROOT / "frontend" / ".env.example").read_text(encoding="utf-8")

    for flag in FEATURE_FLAGS:
        assert f"{flag}=false" in root_env
        assert f"{flag}=false" in converter_env
        assert f"VITE_{flag}=false" in frontend_env
    assert "CONVERSION_CONTEXT_SECRET=" in root_env
    assert "CONVERSION_CONTEXT_SECRET=" in converter_env
    assert "STUDENT_UPLOAD_RETENTION_SECONDS=86400" in root_env
    assert "STUDENT_UPLOAD_RETENTION_SECONDS=86400" in converter_env
    assert "STUDENT_UPLOAD_CLEANUP_INTERVAL_SECONDS=300" in converter_env
    assert "LOCAL_MAPPING_OWNER_SCOPE=local:default" in converter_env
