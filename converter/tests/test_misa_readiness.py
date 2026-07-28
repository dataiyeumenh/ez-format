from __future__ import annotations

import pytest

from app.excel_io import InputTable
from app.models import MisaReadinessIssue, MisaReadinessReport, MisaReadinessSummary
from app.misa_readiness import build_readiness_report


def _table(headers: list[str], rows: list[dict]) -> InputTable:
    return InputTable(headers=headers, rows=rows, sheet_name="Sheet1", header_row_index=0)


def test_readiness_report_serializes_issue_contract():
    report = MisaReadinessReport(
        ok=False,
        status="blocked",
        score=75,
        summary=MisaReadinessSummary(blocker=1, warning=0, info=0),
        issues=[
            MisaReadinessIssue(
                severity="blocker",
                category="template",
                code="required_value_blank",
                row=2,
                field="Mã hàng (*)",
                message="Cột bắt buộc Mã hàng (*) đang trống.",
                expected="Có giá trị",
                actual="",
                fix_hint="Bổ sung mã hàng.",
                source_url="https://helpact.misa.vn/kb/html_10050000/",
            )
        ],
        reconciliation={"input_rows": 1, "output_rows": 1},
        disclaimer="Kế toán cần rà soát.",
    )

    payload = report.model_dump(mode="json")

    assert payload["ok"] is False
    assert payload["status"] == "blocked"
    assert payload["summary"]["blocker"] == 1
    assert payload["issues"][0]["code"] == "required_value_blank"
    assert payload["issues"][0]["source_url"].startswith("https://helpact.misa.vn/")


def test_readiness_blocks_missing_required_mapping():
    report = build_readiness_report(
        _table(["Mã hóa đơn"], [{"Mã hóa đơn": "HD001"}]),
        "bsn_sales",
        mapping={"Mã hóa đơn": "Số chứng từ (*)"},
        defaults={},
        formulas={},
    )

    codes = {issue.code for issue in report.issues}

    assert report.status == "blocked"
    assert "required_mapping_missing" in codes
    assert any(issue.field == "Ngày hạch toán (*)" for issue in report.issues)


def test_readiness_blocks_blank_required_value_after_mapping():
    report = build_readiness_report(
        _table(
            ["Mã hóa đơn", "Thời gian", "Mã hàng"],
            [{"Mã hóa đơn": "HD001", "Thời gian": "01/01/2026", "Mã hàng": ""}],
        ),
        "bsn_sales",
        mapping={
            "Mã hóa đơn": "Số chứng từ (*)",
            "Thời gian": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
            "Mã hàng": "Mã hàng (*)",
        },
        defaults={
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
        },
        formulas={},
    )

    assert report.status == "blocked"
    assert any(
        issue.code == "required_value_blank" and issue.field == "Mã hàng (*)"
        for issue in report.issues
    )


def test_readiness_blocks_unparseable_date_and_number():
    report = build_readiness_report(
        _table(
            ["Mã hóa đơn", "Thời gian", "Mã hàng", "Số lượng", "Đơn giá"],
            [
                {
                    "Mã hóa đơn": "HD001",
                    "Thời gian": "not-a-date",
                    "Mã hàng": "SP01",
                    "Số lượng": "abc",
                    "Đơn giá": "1000",
                }
            ],
        ),
        "bsn_sales",
        mapping={
            "Mã hóa đơn": "Số chứng từ (*)",
            "Thời gian": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
            "Mã hàng": "Mã hàng (*)",
            "Số lượng": "Số lượng",
            "Đơn giá": "Đơn giá",
        },
        defaults={
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
        },
        formulas={},
    )

    codes = {issue.code for issue in report.issues}

    assert "date_unparseable" in codes
    assert "number_unparseable" in codes


@pytest.mark.parametrize("quantity", ["", "khong-phai-so"])
def test_readiness_blocks_blank_or_invalid_multiply_formula_operand(quantity):
    report = build_readiness_report(
        _table(
            ["Mã hóa đơn", "Thời gian", "Mã hàng", "Số lượng", "Đơn giá"],
            [
                {
                    "Mã hóa đơn": "HD001",
                    "Thời gian": "01/01/2026",
                    "Mã hàng": "SP01",
                    "Số lượng": quantity,
                    "Đơn giá": 1000,
                }
            ],
        ),
        "bsn_sales",
        mapping={
            "Mã hóa đơn": "Số chứng từ (*)",
            "Thời gian": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
            "Mã hàng": "Mã hàng (*)",
            "Số lượng": "Số lượng",
            "Đơn giá": "Đơn giá",
        },
        defaults={
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
        },
        formulas={"Thành tiền": "${Số lượng} * ${Đơn giá}"},
    )

    assert any(
        issue.code == "formula_operand_invalid"
        and issue.field == "Thành tiền"
        and issue.severity == "blocker"
        and issue.deterministic
        for issue in report.issues
    )


def test_readiness_blocks_amount_and_vat_mismatch():
    rows = [
        {
            "Số chứng từ (*)": "HD001",
            "Ngày hạch toán (*)": "01/01/2026",
            "Ngày chứng từ (*)": "01/01/2026",
            "Ký hiệu HĐ": "AA/26E",
            "Số hóa đơn": "000001",
            "Mã số thuế": "0100101",
            "Mã hàng (*)": "SP01",
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
            "Số lượng": 2,
            "Đơn giá": 1000,
            "Thành tiền": 5000,
            "% thuế GTGT": 10,
            "Tiền thuế GTGT": 999,
        }
    ]

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=rows,
    )

    codes = {issue.code for issue in report.issues}

    assert "line_amount_mismatch" in codes
    assert "vat_amount_mismatch" in codes


def test_readiness_validates_numeric_zero_vat_rate():
    row = {
        "Số chứng từ (*)": "HD001",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Mã hàng (*)": "SP01",
        "Hình thức bán hàng": "Bán hàng hóa trong nước",
        "Phương thức thanh toán": "Chưa thu tiền",
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
        "Thành tiền": 1000,
        "% thuế GTGT": 0,
        "Tiền thuế GTGT": 100,
    }

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
    )

    assert any(issue.code == "vat_amount_mismatch" for issue in report.issues)


def test_readiness_warns_when_discount_vat_basis_is_not_explicit():
    row = {
        "Số chứng từ (*)": "HD-BASIS",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Mã hàng (*)": "SP01",
        "Hình thức bán hàng": "Bán hàng hóa trong nước",
        "Phương thức thanh toán": "Chưa thu tiền",
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
        "Thành tiền": 1000,
        "Tiền chiết khấu": 100,
        "% thuế GTGT": 10,
        "Tiền thuế GTGT": 90,
    }

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
    )

    assert any(issue.code == "vat_basis_ambiguous" and issue.severity == "warning" for issue in report.issues)
    assert not any(issue.code == "vat_amount_mismatch" for issue in report.issues)


def test_readiness_reconciles_discounted_vat_without_explicit_basis():
    row = {
        "Số chứng từ (*)": "HD-BASIS-RECONCILED",
        "Thành tiền": 90,
        "Tiền chiết khấu": 10,
        "% thuế GTGT": 10,
        "Tiền thuế GTGT": 9,
    }

    report = build_readiness_report(
        _table(list(row), [row]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
    )

    assert not any(issue.code == "vat_basis_ambiguous" for issue in report.issues)
    assert not any(issue.code == "vat_amount_mismatch" for issue in report.issues)


def test_readiness_skips_unknown_basis_ambiguity_without_discount():
    row = {
        "Số chứng từ (*)": "HD-BASIS-NO-DISCOUNT",
        "Thành tiền": 90,
        "Tiền chiết khấu": 0,
        "% thuế GTGT": 10,
        "Tiền thuế GTGT": 9,
    }

    report = build_readiness_report(
        _table(list(row), [row]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
        vat_basis="invoice_taxable_base",
    )

    assert not any(issue.code == "vat_basis_ambiguous" for issue in report.issues)
    assert not any(issue.code == "vat_amount_mismatch" for issue in report.issues)


def test_readiness_skips_unknown_basis_ambiguity_for_zero_vat():
    row = {
        "Số chứng từ (*)": "HD-BASIS-ZERO",
        "Thành tiền": 90,
        "Tiền chiết khấu": 10,
        "% thuế GTGT": 10,
        "Tiền thuế GTGT": 0,
    }

    report = build_readiness_report(
        _table(list(row), [row]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
        vat_basis="invoice_taxable_base",
    )

    assert not any(issue.code == "vat_basis_ambiguous" for issue in report.issues)


def test_readiness_validates_nonzero_vat_when_rate_zero_and_basis_unknown():
    row = {
        "Số chứng từ (*)": "HD-BASIS-ZERO-RATE",
        "Thành tiền": 90,
        "Tiền chiết khấu": 10,
        "% thuế GTGT": 0,
        "Tiền thuế GTGT": 5,
    }

    report = build_readiness_report(
        _table(list(row), [row]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
        vat_basis="invoice_taxable_base",
    )

    assert not any(issue.code == "vat_basis_ambiguous" for issue in report.issues)
    mismatch = next(issue for issue in report.issues if issue.code == "vat_amount_mismatch")
    assert mismatch.expected == "0"


def test_readiness_uses_selected_vat_basis_and_blocks_mismatch():
    row = {
        "Số chứng từ (*)": "HD-BASIS-2",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Mã hàng (*)": "SP01",
        "Hình thức bán hàng": "Bán hàng hóa trong nước",
        "Phương thức thanh toán": "Chưa thu tiền",
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
        "Thành tiền": 1000,
        "Tiền chiết khấu": 100,
        "% thuế GTGT": 10,
        "Tiền thuế GTGT": 90,
    }

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
        vat_basis="line_before_discount",
    )

    assert any(issue.code == "vat_amount_mismatch" and issue.severity == "blocker" for issue in report.issues)
    assert not any(issue.code == "vat_basis_ambiguous" for issue in report.issues)


@pytest.mark.parametrize("vat_rate", ["7", "12"])
def test_readiness_blocks_unsupported_vat_rate(vat_rate):
    row = {
        "Số chứng từ (*)": "HD-RATE",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Mã hàng (*)": "SP01",
        "Hình thức bán hàng": "Bán hàng hóa trong nước",
        "Phương thức thanh toán": "Chưa thu tiền",
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
        "Thành tiền": 1000,
        "% thuế GTGT": vat_rate,
        "Tiền thuế GTGT": 70 if vat_rate == "7" else 120,
    }

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
    )

    assert any(issue.code == "vat_rate_unsupported" for issue in report.issues)


@pytest.mark.parametrize("transaction_date", ["01/01/2027", 46388])
def test_readiness_flags_vat_8_eligibility_outside_policy_window(transaction_date):
    row = {
        "Số chứng từ (*)": "HD-8",
        "Ngày hạch toán (*)": transaction_date,
        "Ngày chứng từ (*)": transaction_date,
        "Mã hàng (*)": "SP01",
        "Hình thức bán hàng": "Bán hàng hóa trong nước",
        "Phương thức thanh toán": "Chưa thu tiền",
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
        "Thành tiền": 1000,
        "% thuế GTGT": 8,
        "Tiền thuế GTGT": 80,
    }

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
    )

    assert any(issue.code == "vat_8_outside_policy" for issue in report.issues)


def test_readiness_keeps_vat_8_eligibility_as_review_warning_inside_policy_window():
    row = {
        "Số chứng từ (*)": "HD-8",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Mã hàng (*)": "SP01",
        "Hình thức bán hàng": "Bán hàng hóa trong nước",
        "Phương thức thanh toán": "Chưa thu tiền",
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
        "Thành tiền": 1000,
        "% thuế GTGT": 8,
        "Tiền thuế GTGT": 80,
    }

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
    )

    assert any(issue.code == "vat_8_eligibility_uncertain" for issue in report.issues)
    assert not any(issue.code == "vat_8_outside_policy" for issue in report.issues)


def test_readiness_blocks_conflicting_duplicate_document_key():
    rows = [
        {
            "Số chứng từ (*)": "HD001",
            "Ngày hạch toán (*)": "01/01/2026",
            "Ngày chứng từ (*)": "01/01/2026",
            "Ký hiệu HĐ": "AA/26E",
            "Số hóa đơn": "000001",
            "Mã số thuế": "0100101",
            "Mã hàng (*)": "SP01",
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
            "Thành tiền": 1000,
            "Tổng tiền thanh toán": 3000,
        },
        {
            "Số chứng từ (*)": "HD001",
            "Ngày hạch toán (*)": "02/01/2026",
            "Ngày chứng từ (*)": "02/01/2026",
            "Ký hiệu HĐ": "AA/26E",
            "Số hóa đơn": "000001",
            "Mã số thuế": "0100101",
            "Mã hàng (*)": "SP02",
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
            "Thành tiền": 2000,
            "Tổng tiền thanh toán": "",
        },
    ]

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}, {"dummy": "y"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=rows,
    )

    assert any(issue.code == "duplicate_document_key" for issue in report.issues)


def test_readiness_allows_multiple_detail_lines_for_the_same_invoice():
    rows = [
        {
            "Số chứng từ (*)": "HD001",
            "Ngày hạch toán (*)": "01/01/2026",
            "Ngày chứng từ (*)": "01/01/2026",
            "Ngày hóa đơn": "01/01/2026",
            "Ký hiệu HĐ": "AA/26E",
            "Số hóa đơn": "000001",
            "Mã số thuế": "0100101",
            "Mã hàng (*)": "SP01",
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
            "Thành tiền": 1000,
            "Tổng tiền thanh toán": 3000,
        },
        {
            "Số chứng từ (*)": "HD001",
            "Ngày hạch toán (*)": "01/01/2026",
            "Ngày chứng từ (*)": "01/01/2026",
            "Ngày hóa đơn": "01/01/2026",
            "Ký hiệu HĐ": "AA/26E",
            "Số hóa đơn": "000001",
            "Mã số thuế": "0100101",
            "Mã hàng (*)": "SP02",
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
            "Thành tiền": 2000,
            "Tổng tiền thanh toán": "",
        },
    ]

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}, {"dummy": "y"}]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=rows,
    )

    assert not any(issue.code == "duplicate_document_key" for issue in report.issues)


def test_reconciliation_deduplicates_repeated_document_total_and_counts_soct():
    rows = [
        {"Số chứng từ (*)": "HD001", "Thành tiền": 1000, "Tiền thuế GTGT": 100, "Tổng tiền thanh toán": 1100},
        {"Số chứng từ (*)": "HD001", "Thành tiền": 2000, "Tiền thuế GTGT": 200, "Tổng tiền thanh toán": 1100},
    ]

    report = build_readiness_report(
        _table(list(rows[0]), rows),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=rows,
    )

    assert report.reconciliation.invoice_count == 1
    assert report.reconciliation.sum_total == "1100"


def test_reconciliation_does_not_invent_total_when_repeated_document_totals_conflict():
    rows = [
        {"Số chứng từ (*)": "HD001", "Tổng tiền thanh toán": 1100},
        {"Số chứng từ (*)": "HD001", "Tổng tiền thanh toán": 1200},
    ]

    report = build_readiness_report(
        _table(list(rows[0]), rows),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=rows,
    )

    assert report.reconciliation.sum_total is None


def test_readiness_uses_one_vat_basis_definition_for_discounted_lines():
    row = {
        "Số chứng từ (*)": "HD-BASIS-CONSISTENT",
        "Thành tiền": 90,
        "Tiền chiết khấu": 10,
        "% thuế GTGT": 10,
        "Tiền thuế GTGT": 8,
    }

    after_discount = build_readiness_report(
        _table(list(row), [row]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
        vat_basis="line_after_discount",
    )
    before_discount = build_readiness_report(
        _table(list(row), [row]),
        "bsn_sales",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
        vat_basis="line_before_discount",
    )

    assert not any(issue.code == "vat_amount_mismatch" for issue in after_discount.issues)
    assert any(issue.code == "vat_amount_mismatch" for issue in before_discount.issues)


def test_readiness_accepts_misa_non_taxable_vat_markers():
    base = {
        "Số phiếu nhập (*)": "PN001",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Mã hàng (*)": "DV01",
        "Hình thức mua hàng": "Mua hàng trong nước không qua kho",
        "Phương thức thanh toán": "Chưa thanh toán",
        "TK kho/TK chi phí (*)": "6428",
        "TK công nợ/TK tiền (*)": "331",
        "Thành tiền": 1000,
        "Tiền thuế GTGT": 0,
    }
    rows = [
        {**base, "% thuế GTGT": "KCT"},
        {**base, "Số phiếu nhập (*)": "PN002", "% thuế GTGT": "KKKNT"},
    ]

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}, {"dummy": "y"}]),
        "misa_purchase_domestic",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=rows,
    )

    assert not any(issue.code == "number_unparseable" for issue in report.issues)
    assert not any(issue.code == "vat_amount_mismatch" for issue in report.issues)


def test_readiness_accepts_amount_explained_by_unit_price_rounding():
    row = {
        "Số phiếu nhập (*)": "PN001",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Mã hàng (*)": "HH01",
        "Hình thức mua hàng": "Mua hàng trong nước nhập kho",
        "Phương thức thanh toán": "Chưa thanh toán",
        "TK kho/TK chi phí (*)": "1561",
        "TK công nợ/TK tiền (*)": "331",
        "Số lượng": 1500,
        "Đơn giá": 213.33,
        "Thành tiền": 320000,
    }

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "misa_purchase_domestic",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=[row],
    )

    assert not any(issue.code == "line_amount_mismatch" for issue in report.issues)


def test_readiness_warns_master_data_review_only():
    rows = [
        {
            "Số phiếu nhập (*)": "PN001",
            "Ngày hạch toán (*)": "01/01/2026",
            "Ngày chứng từ (*)": "01/01/2026",
            "Mã hàng (*)": "Cà phê rang xay",
            "Tên hàng": "Cà phê rang xay",
            "Hình thức mua hàng": "Mua hàng trong nước nhập kho",
            "Phương thức thanh toán": "Chưa thanh toán",
            "TK kho/TK chi phí (*)": "1561",
            "TK công nợ/TK tiền (*)": "331",
        }
    ]

    report = build_readiness_report(
        _table(["dummy"], [{"dummy": "x"}]),
        "misa_purchase_domestic",
        mapping={},
        defaults={},
        formulas={},
        edited_rows=rows,
    )

    assert report.status == "needs_review"
    assert report.summary.blocker == 0
    assert any(issue.code == "master_data_review_required" for issue in report.issues)
