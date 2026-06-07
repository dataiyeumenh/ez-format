from app.accounting_rules import (
    RULE_REGISTRY,
    TT200_PROFILE,
    TT99_PROFILE,
    check_accounting_rules,
    resolve_accounting_profile,
    validate_rule_registry,
)
from app.conversion_types import get_conversion_type


SALES_DETECTED = {
    "invoice": "Số HĐ",
    "date": "Ngày CT",
    "vat_rate": "VAT %",
    "debit_account": "TK Nợ",
    "revenue_account": "TK doanh thu",
    "vat_account": "TK thuế bán",
    "cogs_account": "TK giá vốn",
    "inventory_account": "TK kho",
    "payment_method": "PT thanh toán",
    "discount_amount": "Tiền CK",
    "discount_account": "TK CK",
}

PURCHASE_DETECTED = {
    "purchase_receipt": "Số PN",
    "date": "Ngày CT",
    "vat_rate": "VAT %",
    "inventory_account": "TK kho/chi phí",
    "payable_account": "TK công nợ/tiền",
    "input_vat_account": "TK thuế mua",
    "payment_method": "PT thanh toán",
    "revenue_account": "TK doanh thu",
}


def test_auto_accounting_profile_uses_tt99_from_2026_document_date():
    rows = [{"Ngày CT": "02/01/2026"}]

    assert resolve_accounting_profile(rows, {"date": "Ngày CT"}) == TT99_PROFILE


def test_auto_accounting_profile_uses_legacy_before_2026_document_date():
    rows = [{"Ngày CT": "31/12/2025"}]

    assert resolve_accounting_profile(rows, {"date": "Ngày CT"}) == TT200_PROFILE


def test_rule_registry_entries_have_sources_effective_dates_and_expected_accounts():
    errors = validate_rule_registry(RULE_REGISTRY)

    assert errors == []


def test_sales_goods_correct_accounts_have_no_accounting_issues():
    rows = [
        {
            "Số HĐ": "HD001",
            "Ngày CT": "2026-01-02",
            "VAT %": "10%",
            "TK Nợ": "131",
            "TK doanh thu": "5111",
            "TK thuế bán": "33311",
            "TK giá vốn": "632",
            "TK kho": "1561",
            "PT thanh toán": "Chưa thu tiền",
        }
    ]

    issues = check_accounting_rules(
        rows,
        SALES_DETECTED,
        get_conversion_type("sales_goods"),
        {},
    )

    assert issues == []


def test_sales_wrong_revenue_and_vat_accounts_are_errors():
    rows = [
        {
            "Số HĐ": "HD002",
            "Ngày CT": "2026-01-02",
            "VAT %": "10%",
            "TK Nợ": "331",
            "TK doanh thu": "331",
            "TK thuế bán": "1331",
            "TK giá vốn": "1561",
            "TK kho": "632",
        }
    ]

    issues = check_accounting_rules(
        rows,
        SALES_DETECTED,
        get_conversion_type("sales_goods"),
        {},
    )

    codes = {issue.code for issue in issues}
    assert {
        "accounting_wrong_sales_debit_account",
        "accounting_wrong_sales_revenue_account",
        "accounting_wrong_output_vat_account",
        "accounting_wrong_cogs_account",
        "accounting_wrong_sales_inventory_account",
    }.issubset(codes)


def test_purchase_wrong_accounts_and_payment_method_are_detected():
    rows = [
        {
            "Số PN": "PN001",
            "Ngày CT": "2026-01-02",
            "VAT %": "10%",
            "TK kho/chi phí": "5111",
            "TK công nợ/tiền": "131",
            "TK thuế mua": "33311",
            "PT thanh toán": "Chưa thanh toán",
            "TK doanh thu": "5111",
        }
    ]

    issues = check_accounting_rules(
        rows,
        PURCHASE_DETECTED,
        get_conversion_type("purchase_goods"),
        {},
    )

    codes = {issue.code for issue in issues}
    assert {
        "accounting_wrong_purchase_cost_account",
        "accounting_wrong_purchase_payable_account",
        "accounting_wrong_input_vat_account",
        "accounting_purchase_uses_revenue_account",
        "accounting_payment_method_account_mismatch",
    }.issubset(codes)


def test_tt133_warns_when_discount_uses_521_account():
    rows = [
        {
            "Số HĐ": "HD003",
            "Ngày CT": "2025-12-02",
            "VAT %": "10%",
            "TK Nợ": "131",
            "TK doanh thu": "5111",
            "TK thuế bán": "33311",
            "TK giá vốn": "632",
            "TK kho": "1561",
            "Tiền CK": 1000,
            "TK CK": "5211",
        }
    ]

    issues = check_accounting_rules(
        rows,
        SALES_DETECTED,
        get_conversion_type("sales_goods"),
        {"accounting_profile": "tt133_sme"},
    )

    assert any(issue.code == "accounting_tt133_uses_521_discount_account" for issue in issues)
