from __future__ import annotations

from decimal import Decimal

from app.student_reconciliation import reconcile_session


def _item(report, code):
    return next(item for item in report.items if item.code == code)


def _state(*, invoice_vat="15", payment_total="165", issues=None):
    return {
        "rows": [
            {
                "Số hóa đơn": "HD001",
                "Mã số thuế": "0101",
                "Thành tiền": "100",
                "Tổng tiền hàng": "150",
                "Tiền thuế GTGT": "10",
                "Tổng tiền thuế GTGT": invoice_vat,
                "Tổng tiền thanh toán": payment_total,
            },
            {
                "Số hóa đơn": "HD001",
                "Mã số thuế": "0101",
                "Thành tiền": "50",
                "Tổng tiền hàng": "150",
                "Tiền thuế GTGT": "5",
                "Tổng tiền thuế GTGT": invoice_vat,
                "Tổng tiền thanh toán": payment_total,
            },
        ],
        "readiness": {
            "reconciliation": {"input_rows": 2, "output_rows": 2},
            "issues": issues or [],
        },
    }


def test_reconciles_matching_totals_with_source_evidence():
    report = reconcile_session(_state())

    assert _item(report, "input_row_count_vs_output_row_count").status == "match"
    assert _item(report, "detail_amount_vs_invoice_subtotal").status == "match"
    payment = _item(report, "subtotal_plus_vat_vs_payment_total")
    assert payment.status == "match"
    assert payment.delta == Decimal("0")
    assert payment.evidence[0]["source"] == "rows"
    assert _item(report, "line_vat_vs_invoice_vat").status == "match"
    assert _item(report, "duplicate_document_keys").status == "match"


def test_reports_deterministic_total_mismatch_with_fix_hint():
    report = reconcile_session(_state(payment_total="170"))

    item = _item(report, "subtotal_plus_vat_vs_payment_total")
    assert item.status == "mismatch"
    assert item.delta == Decimal("-5")
    assert item.deterministic is True
    assert item.possible_reasons_vi
    assert item.fix_hint_vi


def test_accepts_declared_decimal_tolerance_for_invoice_vat():
    report = reconcile_session(_state(invoice_vat="16"))

    item = _item(report, "line_vat_vs_invoice_vat")
    assert item.status == "match"
    assert item.delta == Decimal("-1")
    assert item.tolerance == Decimal("1")


def test_surfaces_duplicate_readiness_issue_with_its_existing_code():
    report = reconcile_session(
        _state(
            issues=[
                {
                    "code": "duplicate_document_key",
                    "row": 2,
                    "message": "Conflicting duplicate document.",
                }
            ]
        )
    )

    item = _item(report, "duplicate_document_keys")
    assert item.status == "mismatch"
    assert item.readiness_issue_code == "duplicate_document_key"
    assert item.evidence[0]["issue_code"] == "duplicate_document_key"


def test_marks_financial_and_optional_summaries_insufficient_without_source_data():
    report = reconcile_session(
        {"readiness": {"reconciliation": {"input_rows": 2, "output_rows": 2}}}
    )

    assert _item(report, "detail_amount_vs_invoice_subtotal").status == "insufficient_data"
    assert _item(report, "duplicate_document_keys").status == "insufficient_data"
    assert _item(report, "customer_receivable_summary_when_supported").status == "insufficient_data"
    assert _item(report, "supplier_payable_summary_when_supported").status == "insufficient_data"
    assert _item(report, "inventory_quantity_summary_when_supported").status == "insufficient_data"


def test_reconciliation_preserves_high_precision_and_blank_vs_zero():
    state = _state(invoice_vat="", payment_total="9007199254740993.0000000001")
    state["rows"][0]["Thành tiền"] = "9007199254740993.0000000001"
    state["rows"][1]["Thành tiền"] = "0"
    state["rows"][0]["Tổng tiền hàng"] = "9007199254740993.0000000001"
    state["rows"][1]["Tổng tiền hàng"] = "9007199254740993.0000000001"
    state["rows"][0]["Tiền thuế GTGT"] = ""
    state["rows"][1]["Tiền thuế GTGT"] = "0"

    report = reconcile_session(state)

    detail = _item(report, "detail_amount_vs_invoice_subtotal")
    assert detail.status == "match"
    assert detail.left["value"] == Decimal("9007199254740993.0000000001")
    assert detail.delta == Decimal("0")
    assert _item(report, "line_vat_vs_invoice_vat").status == "insufficient_data"
