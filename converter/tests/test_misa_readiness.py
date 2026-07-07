from __future__ import annotations

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
