from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from app.excel_io import InputTable
from app.student_queries import answer_question, validate_answer_evidence


BENCHMARK_PATH = Path(__file__).parent / "fixtures" / "student_question_benchmark.json"
SUPPORTED_INTENTS = {
    "file_summary",
    "locate_column",
    "locate_rows",
    "explain_mapping",
    "explain_issue",
    "aggregate_amount",
    "count_documents",
    "find_duplicates",
    "find_vat_mismatches",
    "required_actions_before_export",
    "concept_explanation",
    "unsupported_legal_or_business_judgment",
}


def _sales_state() -> dict:
    table = InputTable(
        headers=[
            "Mã hóa đơn",
            "Ngày hóa đơn",
            "Tên khách hàng",
            "Số lượng",
            "Đơn giá",
            "Thành tiền",
            "Thuế suất",
            "Tiền thuế GTGT",
            "Tổng thanh toán",
        ],
        rows=[
            {
                "Mã hóa đơn": "HD001",
                "Ngày hóa đơn": "01/01/2026",
                "Tên khách hàng": "Khách A",
                "Số lượng": 2,
                "Đơn giá": 100000,
                "Thành tiền": 200000,
                "Thuế suất": "10%",
                "Tiền thuế GTGT": 20000,
                "Tổng thanh toán": 220000,
            },
            {
                "Mã hóa đơn": "HD001",
                "Ngày hóa đơn": "01/01/2026",
                "Tên khách hàng": "Khách A",
                "Số lượng": 1,
                "Đơn giá": 50000,
                "Thành tiền": 50000,
                "Thuế suất": "10%",
                "Tiền thuế GTGT": 5000,
                "Tổng thanh toán": 55000,
            },
            {
                "Mã hóa đơn": "HD002",
                "Ngày hóa đơn": "02/01/2026",
                "Tên khách hàng": "Khách B",
                "Số lượng": 3,
                "Đơn giá": 40000,
                "Thành tiền": 120000,
                "Thuế suất": "8%",
                "Tiền thuế GTGT": 8000,
                "Tổng thanh toán": 128000,
            },
            {
                "Mã hóa đơn": "HD003",
                "Ngày hóa đơn": "03/01/2026",
                "Tên khách hàng": "Khách C",
                "Số lượng": 1,
                "Đơn giá": 300000,
                "Thành tiền": 300000,
                "Thuế suất": "10%",
                "Tiền thuế GTGT": 30000,
                "Tổng thanh toán": 330000,
            },
            {
                "Mã hóa đơn": "HD003",
                "Ngày hóa đơn": "04/01/2026",
                "Tên khách hàng": "Khách D",
                "Số lượng": 1,
                "Đơn giá": 25000,
                "Thành tiền": 25000,
                "Thuế suất": "10%",
                "Tiền thuế GTGT": 2500,
                "Tổng thanh toán": 27500,
            },
        ],
        sheet_name="Sales",
        header_row_index=0,
    )
    mapping = {
        "Mã hóa đơn": "Số chứng từ (*)",
        "Ngày hóa đơn": "Ngày chứng từ (*)",
        "Tên khách hàng": "Tên khách hàng",
        "Số lượng": "Số lượng",
        "Đơn giá": "Đơn giá",
        "Thành tiền": "Thành tiền",
        "Thuế suất": "% thuế GTGT",
        "Tiền thuế GTGT": "Tiền thuế GTGT",
        "Tổng thanh toán": "Tổng tiền thanh toán",
    }
    return {
        "session_id": "session-sales",
        "upload_id": "upload-sales",
        "state_hash": "state-sales",
        "target_template_id": "bsn_sales",
        "target_headers": list(mapping.values()),
        "table": table,
        "mapping": mapping,
        "defaults": {},
        "formulas": {},
        "summary": {
            "data_row_count": 5,
            "document_count": 3,
            "recognized_columns": 9,
            "unresolved_columns": 0,
            "issue_counts": {"blocker": 3, "warning": 1, "info": 0},
        },
        "readiness": {
            "status": "blocked",
            "summary": {"blocker": 3, "warning": 1, "info": 0},
            "issues": [
                {
                    "severity": "blocker",
                    "category": "tax",
                    "code": "vat_amount_mismatch",
                    "row": 3,
                    "field": "Tiền thuế GTGT",
                    "actual": "8000",
                    "expected": "9600",
                    "delta": "-1600",
                    "message": "Tiền thuế GTGT không khớp.",
                    "fix_hint": "Kiểm tra thành tiền, thuế suất hoặc tiền thuế.",
                },
                {
                    "severity": "blocker",
                    "category": "document",
                    "code": "duplicate_document_key",
                    "row": 5,
                    "field": "Số chứng từ/Số hóa đơn",
                    "invoice": "HD003",
                    "actual": "Dòng 5 khác thông tin",
                    "expected": "Khớp với dòng 4",
                    "message": "Chứng từ HD003 bị trùng nhưng thông tin không thống nhất.",
                    "fix_hint": "Kiểm tra số hóa đơn hoặc tách chứng từ.",
                },
                {
                    "severity": "blocker",
                    "category": "template",
                    "code": "required_value_blank",
                    "row": 4,
                    "field": "Tên khách hàng",
                    "actual": "",
                    "expected": "Có giá trị",
                    "message": "Tên khách hàng cần được rà soát.",
                    "fix_hint": "Bổ sung giá trị theo chứng từ nguồn.",
                },
                {
                    "severity": "warning",
                    "category": "review",
                    "code": "master_data_unverified",
                    "row": 2,
                    "field": "Tên khách hàng",
                    "actual": "Khách A",
                    "expected": "Đã đối chiếu danh mục",
                    "message": "Khách hàng chưa được đối chiếu danh mục.",
                    "fix_hint": "Đối chiếu hồ sơ doanh nghiệp trước khi import.",
                },
            ],
        },
        "ai_available": False,
    }


def _purchase_state() -> dict:
    table = InputTable(
        headers=[
            "Số hóa đơn",
            "Ngày hóa đơn",
            "Tên nhà cung cấp",
            "Mã hàng",
            "Số lượng",
            "Đơn giá",
            "Thành tiền",
            "Thuế suất GTGT",
            "Tiền thuế GTGT",
        ],
        rows=[
            {
                "Số hóa đơn": "MH001",
                "Ngày hóa đơn": "05/01/2026",
                "Tên nhà cung cấp": "NCC A",
                "Mã hàng": "VT001",
                "Số lượng": 10,
                "Đơn giá": 20000,
                "Thành tiền": 200000,
                "Thuế suất GTGT": "10%",
                "Tiền thuế GTGT": 20000,
            },
            {
                "Số hóa đơn": "MH002",
                "Ngày hóa đơn": "06/01/2026",
                "Tên nhà cung cấp": "NCC B",
                "Mã hàng": "VT002",
                "Số lượng": 5,
                "Đơn giá": 30000,
                "Thành tiền": 150000,
                "Thuế suất GTGT": "8%",
                "Tiền thuế GTGT": 10000,
            },
            {
                "Số hóa đơn": "MH003",
                "Ngày hóa đơn": "07/01/2026",
                "Tên nhà cung cấp": "NCC C",
                "Mã hàng": "VT003",
                "Số lượng": 2,
                "Đơn giá": 50000,
                "Thành tiền": 100000,
                "Thuế suất GTGT": "10%",
                "Tiền thuế GTGT": 10000,
            },
            {
                "Số hóa đơn": "MH003",
                "Ngày hóa đơn": "08/01/2026",
                "Tên nhà cung cấp": "NCC D",
                "Mã hàng": "VT003",
                "Số lượng": 1,
                "Đơn giá": 50000,
                "Thành tiền": 50000,
                "Thuế suất GTGT": "10%",
                "Tiền thuế GTGT": 5000,
            },
        ],
        sheet_name="Purchase",
        header_row_index=1,
    )
    mapping = {
        "Số hóa đơn": "Số hóa đơn",
        "Ngày hóa đơn": "Ngày hóa đơn",
        "Tên nhà cung cấp": "Tên nhà cung cấp",
        "Mã hàng": "Mã hàng (*)",
        "Số lượng": "Số lượng",
        "Đơn giá": "Đơn giá",
        "Thành tiền": "Thành tiền",
        "Thuế suất GTGT": "% thuế GTGT",
        "Tiền thuế GTGT": "Tiền thuế GTGT",
    }
    return {
        "session_id": "session-purchase",
        "upload_id": "upload-purchase",
        "state_hash": "state-purchase",
        "target_template_id": "bsn_purchase",
        "target_headers": list(mapping.values()),
        "table": table,
        "mapping": mapping,
        "defaults": {},
        "formulas": {},
        "summary": {
            "data_row_count": 4,
            "document_count": 3,
            "recognized_columns": 9,
            "unresolved_columns": 0,
            "issue_counts": {"blocker": 2, "warning": 0, "info": 0},
        },
        "readiness": {
            "status": "blocked",
            "summary": {"blocker": 2, "warning": 0, "info": 0},
            "issues": [
                {
                    "severity": "blocker",
                    "category": "tax",
                    "code": "vat_amount_mismatch",
                    "row": 2,
                    "field": "Tiền thuế GTGT",
                    "actual": "10000",
                    "expected": "12000",
                    "delta": "-2000",
                    "message": "Tiền thuế GTGT không khớp.",
                    "fix_hint": "Kiểm tra thuế suất hoặc tiền thuế.",
                },
                {
                    "severity": "blocker",
                    "category": "document",
                    "code": "duplicate_document_key",
                    "row": 4,
                    "field": "Số chứng từ/Số hóa đơn",
                    "invoice": "MH003",
                    "actual": "Dòng 4 khác thông tin",
                    "expected": "Khớp với dòng 3",
                    "message": "Chứng từ MH003 bị trùng nhưng thông tin không thống nhất.",
                    "fix_hint": "Kiểm tra lại hóa đơn mua hàng.",
                },
            ],
        },
        "ai_available": False,
    }


@pytest.fixture
def states() -> dict[str, dict]:
    return {"sales": _sales_state(), "purchase": _purchase_state()}


def test_question_benchmark_has_at_least_fifty_cases_and_all_intent_families(states):
    cases = json.loads(BENCHMARK_PATH.read_text(encoding="utf-8"))

    assert len(cases) >= 50
    assert {case["expected_intent"] for case in cases} == SUPPORTED_INTENTS

    for case in cases:
        answer = answer_question(case["question"], states[case["state"]])
        assert answer.intent == case["expected_intent"], case
        assert answer.outcome == case["expected_outcome"], case
        if case["expected_outcome"] == "supported":
            assert answer.evidence, case
            validate_answer_evidence(answer, states[case["state"]])
        else:
            assert answer.evidence == [], case
            assert answer.unsupported_reason, case
        if case.get("answer_contains"):
            assert case["answer_contains"].casefold() in answer.answer.casefold(), case


def test_document_count_uses_mapping_when_raw_header_is_opaque():
    state = _purchase_state()
    table = state["table"]
    state["table"] = InputTable(
        headers=["SO_HD" if header == "Số hóa đơn" else header for header in table.headers],
        rows=[
            {
                ("SO_HD" if key == "Số hóa đơn" else key): value
                for key, value in row.items()
            }
            for row in table.rows
        ],
        sheet_name=table.sheet_name,
        header_row_index=table.header_row_index,
    )
    state["mapping"] = {
        ("SO_HD" if source == "Số hóa đơn" else source): target
        for source, target in state["mapping"].items()
    }

    answer = answer_question("File mua có bao nhiêu hóa đơn?", state)

    assert answer.outcome == "supported"
    assert "3 chứng từ" in answer.answer
    assert all(item.field == "SO_HD" for item in answer.evidence)


def test_answer_evidence_is_bounded_and_uses_stable_unique_ids(states):
    answer = answer_question("Những dòng nào có hóa đơn HD001?", states["sales"])

    assert answer.intent == "locate_rows"
    assert 1 <= len(answer.evidence) <= 20
    assert len({item.id for item in answer.evidence}) == len(answer.evidence)
    validate_answer_evidence(answer, states["sales"])


@pytest.mark.parametrize(
    "mutation",
    [
        lambda evidence: setattr(evidence, "row", 999),
        lambda evidence: setattr(evidence, "field", "Cột không tồn tại"),
        lambda evidence: setattr(evidence, "actual", "giá trị bịa"),
    ],
)
def test_evidence_validator_rejects_invented_rows_fields_and_values(states, mutation):
    answer = answer_question("Những dòng nào có hóa đơn HD001?", states["sales"])
    tampered = answer.model_copy(deep=True)
    mutation(tampered.evidence[0])

    with pytest.raises(ValueError, match="evidence"):
        validate_answer_evidence(tampered, states["sales"])


def test_no_evidence_produces_unsupported_instead_of_file_specific_claim(states):
    state = deepcopy(states["sales"])
    state["table"] = InputTable(
        headers=state["table"].headers,
        rows=[],
        sheet_name="Sales",
        header_row_index=0,
    )
    state["summary"] = {**state["summary"], "data_row_count": 0, "document_count": 0}

    answer = answer_question("File này có bao nhiêu dòng?", state)

    assert answer.outcome == "unsupported"
    assert answer.evidence == []
    assert answer.unsupported_reason == "no_evidence"


def test_unknown_question_reports_ai_unavailable_without_inventing_values(states):
    answer = answer_question("Hãy suy luận tự do điều gì đáng chú ý nhất", states["sales"])

    assert answer.outcome == "ai_unavailable"
    assert answer.answer_type == "unsupported"
    assert answer.evidence == []
    assert answer.unsupported_reason == "ai_unavailable"


def test_aggregate_amount_preserves_high_precision_and_ignores_blanks(states):
    state = deepcopy(states["sales"])
    state["table"] = InputTable(
        headers=["Thành tiền"],
        rows=[
            {"Thành tiền": "9007199254740993.0000000001"},
            {"Thành tiền": ""},
            {"Thành tiền": "0"},
        ],
        sheet_name="Sales",
        header_row_index=0,
    )
    state["mapping"] = {"Thành tiền": "Thành tiền"}
    state["target_headers"] = ["Thành tiền"]

    answer = answer_question("Tổng thành tiền là bao nhiêu?", state)

    assert answer.outcome == "supported"
    assert "9007199254740993.0000000001" in answer.answer
    assert answer.evidence_count == 2


def test_aggregate_document_totals_counts_repeated_invoice_total_once():
    state = {
        "state_hash": "document-total-state",
        "table": InputTable(
            headers=["Số hóa đơn", "Tổng thanh toán"],
            rows=[
                {"Số hóa đơn": "HD001", "Tổng thanh toán": "108000"},
                {"Số hóa đơn": "HD001", "Tổng thanh toán": "108000"},
                {"Số hóa đơn": "HD002", "Tổng thanh toán": "50000"},
            ],
            sheet_name="Sales",
            header_row_index=0,
        ),
        "mapping": {},
        "target_headers": ["Số hóa đơn", "Tổng thanh toán"],
    }

    answer = answer_question("Tổng thanh toán là bao nhiêu?", state)

    assert answer.outcome == "supported"
    assert "158000" in answer.answer
    assert answer.evidence_count == 2
    assert [item.row for item in answer.evidence] == [2, 4]


def test_aggregate_document_totals_rejects_conflicting_repeated_values():
    state = {
        "state_hash": "conflicting-document-total-state",
        "table": InputTable(
            headers=["Số hóa đơn", "Tổng thanh toán"],
            rows=[
                {"Số hóa đơn": "HD001", "Tổng thanh toán": "108000"},
                {"Số hóa đơn": "HD001", "Tổng thanh toán": "109000"},
            ],
            sheet_name="Sales",
            header_row_index=0,
        ),
        "mapping": {},
        "target_headers": ["Số hóa đơn", "Tổng thanh toán"],
    }

    answer = answer_question("Tổng thanh toán là bao nhiêu?", state)

    assert answer.outcome == "supported"
    assert answer.needs_professional_review is True
    assert "không thể kết luận tổng" in answer.answer.casefold()
    assert answer.evidence_count == 2


def test_aggregate_document_totals_resolves_soct_alias():
    state = {
        "state_hash": "opaque-document-key-state",
        "table": InputTable(
            headers=["SOCT", "Tổng tiền"],
            rows=[
                {"SOCT": "HD001", "Tổng tiền": "108000"},
                {"SOCT": "HD001", "Tổng tiền": "108000"},
            ],
            sheet_name="Sales",
            header_row_index=0,
        ),
        "mapping": {},
        "target_headers": ["SOCT", "Tổng tiền"],
    }

    answer = answer_question("Tổng tiền là bao nhiêu?", state)

    assert answer.outcome == "supported"
    assert "108000" in answer.answer
    assert answer.evidence_count == 1


def test_aggregate_document_totals_uses_mapping_target_for_opaque_total_column(states):
    state = deepcopy(states["sales"])
    state["table"] = InputTable(
        headers=["SOCT", "TTVND"],
        rows=[
            {"SOCT": "HD001", "TTVND": "108000"},
            {"SOCT": "HD001", "TTVND": "108000"},
        ],
        sheet_name="Sales",
        header_row_index=0,
    )
    state["mapping"] = {
        "SOCT": "Số chứng từ (*)",
        "TTVND": "Tổng tiền thanh toán",
    }
    state["target_headers"] = list(state["mapping"].values())

    answer = answer_question("Tổng tiền thanh toán là bao nhiêu?", state)

    assert answer.outcome == "supported"
    assert "108000" in answer.answer
    assert answer.evidence_count == 1


def test_aggregate_document_totals_requires_document_key():
    state = {
        "state_hash": "missing-document-key-state",
        "table": InputTable(
            headers=["Tổng thanh toán"],
            rows=[{"Tổng thanh toán": "108000"}],
            sheet_name="Sales",
            header_row_index=0,
        ),
        "mapping": {},
        "target_headers": ["Tổng thanh toán"],
    }

    answer = answer_question("Tổng thanh toán là bao nhiêu?", state)

    assert answer.outcome == "unsupported"
    assert answer.unsupported_reason == "missing_document_key"
    assert answer.evidence == []


@pytest.mark.parametrize(
    ("question", "issue_code", "expected_intent"),
    [
        ("Có hóa đơn trùng không?", "duplicate_document_key", "find_duplicates"),
        ("Dòng nào lệch tiền thuế GTGT?", "vat_amount_mismatch", "find_vat_mismatches"),
    ],
)
def test_duplicate_and_vat_handlers_return_unsupported_when_issue_evidence_is_invalid(
    states,
    question,
    issue_code,
    expected_intent,
):
    state = deepcopy(states["sales"])
    state["readiness"]["issues"] = [
        {
            **next(
                issue
                for issue in state["readiness"]["issues"]
                if issue["code"] == issue_code
            ),
            "row": 999,
        }
    ]

    answer = answer_question(question, state)

    assert answer.intent == expected_intent
    assert answer.outcome == "unsupported"
    assert answer.unsupported_reason == "no_evidence"
    assert answer.evidence == []


@pytest.mark.parametrize(
    ("question", "issue_code"),
    [
        ("Có hóa đơn trùng không?", "duplicate_document_key"),
        ("Dòng nào lệch tiền thuế GTGT?", "vat_amount_mismatch"),
    ],
)
def test_duplicate_and_vat_handlers_do_not_call_supported_without_evidence(
    states,
    monkeypatch,
    question,
    issue_code,
):
    state = deepcopy(states["sales"])
    state["readiness"]["issues"] = [
        {
            **next(
                issue
                for issue in state["readiness"]["issues"]
                if issue["code"] == issue_code
            ),
            "row": 999,
        }
    ]

    def forbidden_supported(*args, **kwargs):
        raise AssertionError("handler must branch to unsupported before _supported")

    monkeypatch.setattr("app.student_queries._supported", forbidden_supported)

    answer = answer_question(question, state)

    assert answer.outcome == "unsupported"
    assert answer.unsupported_reason == "no_evidence"


def test_requested_row_is_one_based_worksheet_row_with_non_first_header(states):
    answer = answer_question("Vì sao dòng 4 bị lỗi thuế?", states["purchase"])

    assert answer.intent == "explain_issue"
    assert answer.outcome == "supported"
    assert len(answer.evidence) == 1
    assert answer.evidence[0].row == 4
    assert answer.evidence[0].issue_code == "vat_amount_mismatch"


@pytest.mark.parametrize("question", ["Giải thích lỗi ở dòng 2", "Giải thích lỗi ở dòng 99"])
def test_requested_header_or_out_of_range_worksheet_row_is_unsupported(states, question):
    answer = answer_question(question, states["purchase"])

    assert answer.intent == "explain_issue"
    assert answer.outcome == "unsupported"
    assert answer.unsupported_reason == "row_out_of_range"
    assert answer.evidence == []
