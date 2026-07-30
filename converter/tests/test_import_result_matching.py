from __future__ import annotations

from app.export_manifest import build_export_manifest
from app.import_result_matching import suggest_issue_matches
from app.import_result_models import NormalizedImportIssue
from app.import_result_workflow import suggest_bound_issue_matches


def _manifest(*, output_rows, row_origins=None):
    return build_export_manifest(
        conversion_id="run-1",
        export_batch_id="batch-1",
        target_template_id="bsn_sales",
        template_hash="a" * 64,
        raw_file_hash="b" * 64,
        mapping_profile_id="profile-1",
        mapping_profile_version=1,
        validation_ruleset_version="misa-readiness-v1",
        output_rows=output_rows,
        row_origins=row_origins
        or [{"raw_sheet": "Raw", "raw_rows": [index + 2]} for index in range(len(output_rows))],
    )


def _issue(locator):
    return NormalizedImportIssue(
        issue_key="manual_excel_v1:issue-1",
        artifact_row_number=2,
        technical_message="Synthetic import error",
        locator=locator,
    )


def test_duplicate_business_key_is_ambiguous():
    manifest = _manifest(
        output_rows=[
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH01"},
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH02"},
        ]
    )

    result = suggest_issue_matches(_issue({"document_number": "BH0001"}), manifest)

    assert result.status == "ambiguous"
    assert result.method == "exact_business_key"
    assert len(result.candidates) == 2
    assert all(candidate.document_group_id == manifest.rows[0].document_group_id for candidate in result.candidates)


def test_invoice_symbol_disambiguates_same_supplier_and_invoice_number():
    manifest = _manifest(
        output_rows=[
            {
                "Số chứng từ (*)": "BH0001",
                "Mã khách hàng": "KH01",
                "Số hóa đơn": "000123",
                "Ký hiệu HĐ": "AA/26E",
            },
            {
                "Số chứng từ (*)": "BH0002",
                "Mã khách hàng": "KH01",
                "Số hóa đơn": "000123",
                "Ký hiệu HĐ": "BB/26E",
            },
        ]
    )

    result = suggest_issue_matches(
        _issue({
            "invoice_number": "000123",
            "invoice_symbol": "BB/26E",
            "partner_code": "KH01",
        }),
        manifest,
    )

    assert result.status == "suggested"
    assert result.candidates[0].document_group_id == manifest.rows[1].document_group_id
    assert result.candidates[0].matched_fields == [
        "invoice_number",
        "invoice_symbol",
        "partner_code",
    ]


def test_unique_fingerprint_is_still_only_suggested_in_phase_one():
    manifest = _manifest(output_rows=[{"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH01"}])
    issue = _issue({"line_fingerprint": manifest.rows[0].line_fingerprint})

    result = suggest_issue_matches(issue, manifest)

    assert result.status == "suggested"
    assert result.method == "exact_fingerprint"
    assert result.requires_user_confirmation is True
    assert result.candidates[0].matched_fields == ["line_fingerprint"]
    assert result.candidates[0].mismatched_fields == []
    assert "confirmed" not in result.model_dump()


def test_duplicate_line_fingerprint_is_ambiguous_and_capped():
    manifest = _manifest(
        output_rows=[
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH01", "Thành tiền": "100"},
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH01", "Thành tiền": "100"},
        ]
    )
    issue = _issue({"line_fingerprint": manifest.rows[0].line_fingerprint})

    result = suggest_issue_matches(issue, manifest)

    assert manifest.rows[0].line_fingerprint == manifest.rows[1].line_fingerprint
    assert result.status == "ambiguous"
    assert result.method == "exact_fingerprint"
    assert result.requires_user_confirmation is True
    assert len(result.candidates) == 2
    assert len(result.candidates) <= 5


def test_exact_business_key_preserves_leading_zeroes_and_returns_minimal_evidence():
    manifest = _manifest(
        output_rows=[
            {"Số chứng từ (*)": "0007", "Mã hàng (*)": "HH01", "Thành tiền": "0"},
            {"Số chứng từ (*)": "7", "Mã hàng (*)": "HH01", "Thành tiền": "0"},
        ]
    )

    result = suggest_issue_matches(
        _issue({"document_number": "0007", "item_code": "HH01", "amount": "0"}),
        manifest,
    )

    assert result.status == "suggested"
    assert result.method == "exact_business_key"
    assert result.candidates[0].locator == {
        "document_number": "0007",
        "invoice_number": None,
        "invoice_symbol": None,
        "document_date": None,
        "invoice_date": None,
        "partner_code": None,
        "item_code": "HH01",
        "amount": "0",
    }
    assert result.candidates[0].matched_fields == ["document_number", "item_code", "amount"]
    assert result.candidates[0].mismatched_fields == []
    assert "raw_row_ids" not in result.candidates[0].model_dump()


def test_blank_value_does_not_match_zero_value():
    manifest = _manifest(
        output_rows=[
            {"Số chứng từ (*)": "BH0001", "Thành tiền": ""},
            {"Số chứng từ (*)": "BH0001", "Thành tiền": "0"},
        ]
    )

    result = suggest_issue_matches(
        _issue({"document_number": "BH0001", "amount": "0"}), manifest
    )

    assert result.status == "suggested"
    assert len(result.candidates) == 1
    assert result.candidates[0].locator["amount"] == "0"


def test_duplicate_invoice_numbers_are_ambiguous():
    manifest = _manifest(
        output_rows=[
            {"Số hóa đơn": "000123", "Mã hàng (*)": "HH01"},
            {"Số hóa đơn": "000123", "Mã hàng (*)": "HH02"},
        ]
    )

    result = suggest_issue_matches(_issue({"invoice_number": "000123"}), manifest)

    assert result.status == "ambiguous"
    assert result.method == "exact_business_key"
    assert len(result.candidates) == 2


def test_two_line_voucher_matches_specific_line_but_suggests_its_document_group():
    manifest = _manifest(
        output_rows=[
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH01"},
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH02"},
        ]
    )

    result = suggest_issue_matches(
        _issue({"document_number": "BH0001", "item_code": "HH02"}), manifest
    )

    assert result.status == "suggested"
    assert result.candidates[0].document_group_id == manifest.rows[1].document_group_id
    assert result.candidates[0].output_row_number == 2


def test_provenance_shapes_do_not_change_matching_or_leak_raw_locators():
    one_raw_to_many = _manifest(
        output_rows=[
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH01"},
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH02"},
        ],
        row_origins=[
            {"raw_sheet": "Raw", "raw_rows": [2]},
            {"raw_sheet": "Raw", "raw_rows": [2]},
        ],
    )
    many_raw_to_one = _manifest(
        output_rows=[{"Số chứng từ (*)": "BH0002", "Mã hàng (*)": "HH03"}],
        row_origins=[{"raw_sheet": "Raw", "raw_rows": [3, 4]}],
    )

    one_raw_result = suggest_issue_matches(
        _issue({"document_number": "BH0001", "item_code": "HH02"}), one_raw_to_many
    )
    many_raw_result = suggest_issue_matches(
        _issue({"document_number": "BH0002", "item_code": "HH03"}), many_raw_to_one
    )

    assert one_raw_result.status == many_raw_result.status == "suggested"
    assert "raw_row_ids" not in one_raw_result.candidates[0].model_dump()
    assert "raw_row_ids" not in many_raw_result.candidates[0].model_dump()


def test_missing_locators_and_source_row_number_never_select_candidates():
    manifest = _manifest(output_rows=[{"Số chứng từ (*)": "BH0001"}])

    missing = suggest_issue_matches(_issue({"sheet_name": "Import result"}), manifest)
    source_row_only = suggest_issue_matches(
        _issue({"source_row_number": "1"}), manifest
    )

    assert missing.status == source_row_only.status == "unmatched"
    assert missing.method == source_row_only.method == "none"
    assert missing.candidates == source_row_only.candidates == []


def test_source_row_number_is_ignored_when_business_key_is_unique():
    manifest = _manifest(output_rows=[{"Số chứng từ (*)": "BH0001"}])

    result = suggest_issue_matches(
        _issue({"source_row_number": "9999", "document_number": "BH0001"}), manifest
    )

    assert result.status == "suggested"
    assert result.candidates[0].matched_fields == ["document_number"]


def test_ambiguous_candidates_are_capped_at_five():
    manifest = _manifest(
        output_rows=[{"Số chứng từ (*)": "BH0001", "Mã hàng (*)": f"HH{index}"} for index in range(6)]
    )

    result = suggest_issue_matches(_issue({"document_number": "BH0001"}), manifest)

    assert result.status == "ambiguous"
    assert len(result.candidates) == 5


def test_workflow_delegates_safe_match_suggestions():
    manifest = _manifest(output_rows=[{"Số chứng từ (*)": "BH0001"}])

    result = suggest_bound_issue_matches(
        issue=_issue({"document_number": "BH0001"}), manifest=manifest
    )

    assert result.status == "suggested"
