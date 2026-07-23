from __future__ import annotations

import pytest

from app.misa_templates import list_misa_templates
from app.student_field_dictionary import field_definition
from app.student_explanations import explanation_state_hash, stable_explanation_id
from app.student_models import StudentEvidence, StudentExplanation, StudentFileSummary


EXPECTED_TEMPLATE_IDS = {
    "bsn_sales",
    "bsn_purchase",
    "misa_purchase_domestic",
    "sales_goods",
    "sales_service",
    "purchase_goods",
    "purchase_service",
}


def test_field_dictionary_covers_every_header_in_all_student_templates():
    templates = list_misa_templates()
    assert {template.id for template in templates} == EXPECTED_TEMPLATE_IDS

    for template in templates:
        for header in template.headers:
            definition = field_definition(template.id, header)
            assert definition["header"] == header
            assert definition["meaning_vi"].strip()
            assert definition["fix_hint_vi"].strip()
            assert definition["source"]["rule_id"].strip()
            assert definition["source"]["source_ref"].strip()

            if "(*)" in header:
                assert definition["required"] is True
                assert definition["required_source"] == "template_marker"
                assert definition["specific"] is True
                assert "trường tùy chọn" not in definition["meaning_vi"].lower()


def test_optional_unknown_field_uses_safe_generic_definition():
    definition = field_definition("bsn_sales", "Trường tham chiếu nội bộ")

    assert definition["required"] is False
    assert definition["specific"] is False
    assert "trường tùy chọn" in definition["meaning_vi"].lower()
    assert "theo tên cột" in definition["fix_hint_vi"].lower()
    assert "pháp luật" not in definition["meaning_vi"].lower()
    assert definition["source"]["source_url"] is None
    assert definition["source"]["rule_id"] == "student_optional_field_safe_fallback_v1"


def test_optional_template_fallback_uses_template_and_internal_rule_evidence():
    definition = field_definition("bsn_sales", "Hình thức bán hàng")

    assert definition["specific"] is False
    assert definition["source"]["source_ref"] == "template:bsn_sales:Hình thức bán hàng"
    assert definition["source"]["source_url"] is None


def test_student_explanation_rejects_deterministic_claim_without_evidence():
    with pytest.raises(ValueError, match="evidence"):
        StudentExplanation(
            id="explanation-1",
            kind="mapping",
            severity="none",
            deterministic=True,
            target_field="Ngày hạch toán (*)",
            title="Ngày hạch toán",
            meaning_vi="Ngày nghiệp vụ được ghi nhận vào sổ kế toán.",
            reason_vi="Cột nguồn được nhận diện theo tên và kiểu dữ liệu.",
            fix_hint_vi="Đối chiếu cột ngày trong file nguồn.",
            evidence=[],
        )


def test_student_contract_serializes_source_and_rule_evidence():
    explanation = StudentExplanation(
        id="explanation-1",
        kind="mapping",
        severity="none",
        deterministic=True,
        target_field="Ngày hạch toán (*)",
        title="Ngày hạch toán",
        meaning_vi="Ngày nghiệp vụ được ghi nhận vào sổ kế toán.",
        reason_vi="Cột Thời gian được dùng làm ngày hạch toán.",
        fix_hint_vi="Đối chiếu ngày trên chứng từ nguồn.",
        evidence=[
            StudentEvidence(
                kind="source_column",
                sheet="Data",
                column="Thời gian",
                source_ref="Data!Thời gian",
            ),
            StudentEvidence(
                kind="rule",
                rule_id="posting_date_mapping",
                source_ref="urn:ezformat:student-rule:posting-date-mapping:v1",
            ),
        ],
    )
    summary = StudentFileSummary(
        session_id="session-1",
        upload_id="upload-1",
        file_name="sales.xlsx",
        target_template_id="bsn_sales",
        sheet_name="Data",
        header_row=1,
        data_row_count=2,
        recognized_columns=1,
        unresolved_columns=0,
        mapping_counts={"mapped": 1, "default": 0, "formula": 0, "unresolved": 0},
        issue_counts={"blocker": 0, "warning": 0, "info": 0},
        master_data_status="not_configured",
        explanation_count=1,
    )

    payload = explanation.model_dump(mode="json")
    assert payload["evidence"][0]["sheet"] == "Data"
    assert payload["evidence"][1]["rule_id"] == "posting_date_mapping"
    assert summary.model_dump(mode="json")["mapping_counts"]["mapped"] == 1


def test_explanation_ids_are_stable_for_the_same_session_upload_field_and_rule():
    first = stable_explanation_id(
        session_id="session-1",
        upload_id="upload-1",
        kind="mapping",
        target_field="Ngày hạch toán (*)",
        rule_id="mapping:Thời gian",
    )
    second = stable_explanation_id(
        session_id="session-1",
        upload_id="upload-1",
        kind="mapping",
        target_field="Ngày hạch toán (*)",
        rule_id="mapping:Thời gian",
    )

    assert first == second
    assert first != stable_explanation_id(
        session_id="session-1",
        upload_id="upload-2",
        kind="mapping",
        target_field="Ngày hạch toán (*)",
        rule_id="mapping:Thời gian",
    )


def test_explanation_state_hash_includes_mapping_source_and_profile_identity():
    common = {
        "session_id": "session-1",
        "upload_id": "upload-1",
        "target_template_id": "bsn_sales",
        "source_signature_hash": "signature-1",
        "mapping": {"Thời gian": "Ngày hạch toán (*)"},
        "defaults": {},
        "formulas": {},
    }

    heuristic = explanation_state_hash(
        **common,
        mapping_source="heuristic",
        mapping_identity="heuristic",
    )
    confirmed = explanation_state_hash(
        **common,
        mapping_source="confirmed",
        mapping_identity="profile-1",
    )
    another_profile = explanation_state_hash(
        **common,
        mapping_source="confirmed",
        mapping_identity="profile-2",
    )

    assert heuristic != confirmed
    assert confirmed != another_profile
