from __future__ import annotations

import pytest

from app.import_result_models import ImportResultSchemaError
from app.import_result_parser import inspect_import_result, normalize_import_result
from tests.helpers.import_result_workbooks import (
    add_xlsx_external_link,
    add_xlsx_zip_payload,
    build_import_result_xls,
    build_import_result_xlsx,
    build_import_result_xlsx_sheets,
)


def test_unknown_workbook_requires_manual_schema_mapping():
    content = build_import_result_xlsx(
        headers=["Dong loi", "So CT", "Thong tin ky thuat"],
        rows=[[12, "MH0001", "Ma nha cung cap khong ton tai"]],
    )

    result = inspect_import_result(content, "synthetic.xlsx")

    assert result.adapter.id == "manual_excel_v1"
    assert result.adapter.verified is False
    assert result.status == "needs_schema_mapping"
    assert result.sample_rows == [
        {
            "Dong loi": "12",
            "So CT": "MH0001",
            "Thong tin ky thuat": "Ma nha cung cap khong ton tai",
        }
    ]


def test_normalizer_requires_technical_message_column():
    with pytest.raises(ImportResultSchemaError, match="technical_message"):
        normalize_import_result(content=b"...", mapping={"document_number": "So CT"})


@pytest.mark.parametrize(
    ("filename", "builder"),
    [
        ("result.xlsx", build_import_result_xlsx),
        ("result.xls", build_import_result_xls),
    ],
)
def test_inspection_supports_excel_formats(filename, builder):
    content = builder(headers=["Message"], rows=[["Rejected"]])

    result = inspect_import_result(content, filename)

    assert result.sheet_name == "Import result"
    assert result.headers == ["Message"]
    assert result.adapter.verified is False


def test_inspection_rejects_invalid_magic_bytes():
    with pytest.raises(ImportResultSchemaError, match="ZIP/OpenXML"):
        inspect_import_result(b"not-an-xlsx", "result.xlsx")


def test_inspection_rejects_duplicate_headers():
    content = build_import_result_xlsx(
        headers=["So CT", " so ct "],
        rows=[["A", "B"]],
    )

    with pytest.raises(ImportResultSchemaError, match="Duplicate normalized header"):
        inspect_import_result(content, "result.xlsx")


def test_inspection_exposes_formula_and_hidden_row_warnings_and_limits_samples():
    content = build_import_result_xlsx(
        headers=["Message"],
        rows=[[f"issue-{index}"] for index in range(25)],
        hidden_rows=(3,),
        formula_cells={"B2": "=1+1"},
    )

    result = inspect_import_result(content, "result.xlsx")

    assert len(result.sample_rows) == 20
    assert {warning["code"] for warning in result.warnings} >= {
        "formula_cells_detected",
        "hidden_rows_or_columns_detected",
    }


def test_normalizer_preserves_user_selected_values_without_matching_or_repairing():
    content = build_import_result_xlsx(
        headers=["Message", "So CT", "So hoa don", "Ngay CT", "So tien"],
        rows=[
            ["", "0007", "000001", "not-a-date", "1.234,56"],
            ["Tai khoan khong ton tai", "0008", "000002", "32/13/2026", "1.234,56"],
        ],
    )

    issues = normalize_import_result(
        content,
        {
            "sheet_name": "Import result",
            "header_row": 1,
            "columns": {
                "technical_message": "Message",
                "document_number": "So CT",
                "invoice_number": "So hoa don",
                "document_date": "Ngay CT",
                "amount": "So tien",
            },
        },
    )

    assert len(issues) == 1
    assert issues[0].artifact_row_number == 3
    assert issues[0].technical_message == "Tai khoan khong ton tai"
    assert issues[0].locator == {
        "sheet_name": "Import result",
        "document_number": "0008",
        "invoice_number": "000002",
        "document_date": "32/13/2026",
        "amount": "1.234,56",
    }
    assert issues[0].category == "unclassified"
    assert issues[0].severity == "warning"
    assert issues[0].import_status == "unknown"
    assert issues[0].retry_blocked is True


def test_normalizer_bounds_oversized_technical_message():
    content = build_import_result_xlsx(
        headers=["Message"],
        rows=[["x" * 5000]],
    )

    issues = normalize_import_result(
        content,
        {
            "sheet_name": "Import result",
            "header_row": 1,
            "columns": {"technical_message": "Message"},
        },
    )

    assert len(issues[0].technical_message) == 2000


def test_normalizer_detects_xls_content_when_filename_is_not_available():
    content = build_import_result_xls(
        headers=["Message"],
        rows=[["Rejected"]],
    )

    issues = normalize_import_result(
        content,
        {
            "sheet_name": "Import result",
            "header_row": 1,
            "columns": {"technical_message": "Message"},
        },
    )

    assert issues[0].technical_message == "Rejected"


def test_inspection_rejects_xlsx_zip_expansion_before_parsing(monkeypatch):
    content = add_xlsx_zip_payload(
        build_import_result_xlsx(headers=["Message"], rows=[["Rejected"]]),
        name="xl/security-padding.bin",
        payload=b"x" * 4096,
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_EXPANDED_BYTES", "1024")

    with pytest.raises(ImportResultSchemaError, match="expanded ZIP"):
        inspect_import_result(content, "result.xlsx")


def test_inspection_enforces_import_result_row_budget(monkeypatch):
    content = build_import_result_xlsx(
        headers=["Message"],
        rows=[["one"], ["two"]],
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_ROWS", "2")

    with pytest.raises(ImportResultSchemaError, match="gioi han 2 dong"):
        inspect_import_result(content, "result.xlsx")


def test_inspection_enforces_import_result_cell_budget(monkeypatch):
    content = build_import_result_xlsx(
        headers=["Message", "Document"],
        rows=[["Rejected", "0007"]],
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_CELLS", "3")

    with pytest.raises(ImportResultSchemaError, match="gioi han 3 o"):
        inspect_import_result(content, "result.xlsx")


def test_inspection_rejects_xlsx_external_link_relationship_before_parsing():
    content = add_xlsx_external_link(
        build_import_result_xlsx(headers=["Message"], rows=[["Rejected"]])
    )

    with pytest.raises(ImportResultSchemaError, match="external links"):
        inspect_import_result(content, "result.xlsx")


def test_xls_inspection_discloses_external_link_detection_policy():
    content = build_import_result_xls(headers=["Message"], rows=[["Rejected"]])

    result = inspect_import_result(content, "result.xls")

    assert {warning["code"] for warning in result.warnings} >= {
        "xls_external_link_detection_unavailable"
    }


def test_normalizer_keeps_physical_workbook_rows_across_blank_separators():
    content = build_import_result_xlsx(
        headers=["Message"],
        rows=[["first issue"], [], ["second issue"]],
    )

    issues = normalize_import_result(
        content,
        {
            "sheet_name": "Import result",
            "header_row": 1,
            "columns": {"technical_message": "Message"},
        },
    )

    assert [issue.artifact_row_number for issue in issues] == [2, 4]


def test_normalizer_rejects_more_than_the_bounded_issue_limit(monkeypatch):
    content = build_import_result_xlsx(
        headers=["Message"],
        rows=[["one"], ["two"], ["three"]],
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_ISSUES", "2")

    with pytest.raises(ImportResultSchemaError, match="gioi han 2 issue"):
        normalize_import_result(
            content,
            {
                "sheet_name": "Import result",
                "header_row": 1,
                "columns": {"technical_message": "Message"},
            },
        )


def test_normalizer_rejects_aggregate_decoded_text_budget(monkeypatch):
    content = build_import_result_xlsx(
        headers=["Message", "Document"],
        rows=[["x" * 32, "BH0001"], ["y" * 32, "BH0002"]],
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_DECODED_TEXT_BYTES", "48")

    with pytest.raises(ImportResultSchemaError, match="decoded text 48 bytes"):
        normalize_import_result(
            content,
            {
                "sheet_name": "Import result",
                "header_row": 1,
                "columns": {
                    "technical_message": "Message",
                    "document_number": "Document",
                },
            },
        )


def test_analysis_exposes_candidates_and_normalizer_uses_selected_sheet_and_header():
    content = build_import_result_xlsx_sheets(
        [
            ("Summary", [["Message", "Doc"], ["summary issue", "S-1"]]),
            (
                "Detailed",
                [
                    ["MISA import result"],
                    [],
                    ["Message", "Doc"],
                    ["detailed issue", "D-1"],
                ],
            ),
        ]
    )

    inspection = inspect_import_result(content, "result.xlsx")
    candidates = {
        (candidate.sheet_name, candidate.header_row, tuple(candidate.headers))
        for candidate in inspection.candidates
    }
    issues = normalize_import_result(
        content,
        {
            "sheet_name": "Detailed",
            "header_row": 3,
            "columns": {
                "technical_message": "Message",
                "document_number": "Doc",
            },
        },
    )

    assert ("Summary", 1, ("Message", "Doc")) in candidates
    assert ("Detailed", 3, ("Message", "Doc")) in candidates
    assert inspection.selection_ambiguous is True
    assert [
        (issue.artifact_row_number, issue.locator["document_number"])
        for issue in issues
    ] == [(4, "D-1")]
