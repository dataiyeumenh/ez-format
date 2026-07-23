from decimal import Decimal

import pytest

from app.student_scoring import hint_for, score_attempt


def _expected_state():
    return {
        "mapping": {"Mã hóa đơn": "Số hóa đơn", "Thời gian": "Ngày hóa đơn"},
        "required_completeness": {
            "Số hóa đơn": True,
            "Ngày hóa đơn": True,
        },
        "date_number": {"Ngày hóa đơn": "2026-01-01"},
        "vat_amount": {"Thành tiền": "250000", "Tiền thuế GTGT": "25000"},
        "classification": "sales_goods",
        "correction_after_hints": True,
    }


def test_score_attempt_returns_exact_full_partial_and_zero_scores():
    expected = _expected_state()
    full = score_attempt("mapping_attempt", expected, expected)
    partial = score_attempt(
        "mapping_attempt",
        {
            "mapping": {"Mã hóa đơn": "Số hóa đơn", "Thời gian": "Sai"},
            "required_completeness": {
                "Số hóa đơn": True,
                "Ngày hóa đơn": False,
            },
            "date_number": {"Ngày hóa đơn": "2026-01-01"},
            "vat_amount": {"Thành tiền": "0", "Tiền thuế GTGT": "0"},
            "classification": "sales_goods",
            "correction_after_hints": False,
        },
        expected,
    )
    zero = score_attempt(
        "mapping_attempt",
        {
            "mapping": {},
            "required_completeness": {},
            "date_number": {},
            "vat_amount": {},
            "classification": "purchase_service",
            "correction_after_hints": False,
        },
        expected,
    )

    assert full.score == Decimal("100")
    assert full.issues == []
    assert partial.score == Decimal("50")
    assert zero.score == Decimal("0")


def test_score_attempt_is_deterministic_and_hashes_canonical_state():
    expected = _expected_state()
    reordered = {
        "correction_after_hints": True,
        "classification": "sales_goods",
        "vat_amount": {"Tiền thuế GTGT": "25000.00", "Thành tiền": 250000},
        "date_number": {"Ngày hóa đơn": "2026-01-01"},
        "required_completeness": {
            "Ngày hóa đơn": True,
            "Số hóa đơn": True,
        },
        "mapping": {"Thời gian": "Ngày hóa đơn", "Mã hóa đơn": "Số hóa đơn"},
    }

    first = score_attempt("mapping_attempt", reordered, expected)
    second = score_attempt("mapping_attempt", reordered, expected)

    assert first == second
    assert first.submitted_state_hash == second.submitted_state_hash
    assert first.score == Decimal("100")


def test_hint_for_reveals_only_the_requested_progressive_level():
    expected = _expected_state()
    evaluation = score_attempt(
        "mapping_attempt",
        {**expected, "classification": "purchase_goods"},
        expected,
    )
    issue = evaluation.issues[0]

    public = evaluation.public_payload()
    assert "expected" not in public
    assert "hints" not in public
    assert all("expected" not in item and "hints" not in item for item in public["issues"])
    assert set(public["issues"][0]) == {"id", "category", "label_vi"}

    level_two = hint_for(evaluation, issue.id, 2)
    assert level_two.model_dump() == {
        "issue_id": issue.id,
        "level": 2,
        "text_vi": "Nhóm cần kiểm tra: phân loại chứng từ.",
    }
    assert "sales_goods" not in level_two.text_vi

    level_four = hint_for(evaluation, issue.id, 4)
    assert "sales_goods" in level_four.text_vi
    assert level_four.level == 4


def test_hint_for_rejects_unknown_issues_and_out_of_range_levels():
    evaluation = score_attempt(
        "mapping_attempt",
        {**_expected_state(), "classification": "purchase_goods"},
        _expected_state(),
    )

    with pytest.raises(KeyError):
        hint_for(evaluation, "missing", 1)
    with pytest.raises(ValueError, match="0.*4"):
        hint_for(evaluation, evaluation.issues[0].id, 5)
