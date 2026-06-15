from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any
import uuid
import re

from app.conversion_types import CONVERSION_TYPES
from app.models import (
    IssueExplanation,
    MisaReadinessReport,
    MisaValidationIssue,
    MisaValidationSummary,
    ReconciliationReport,
    VatPolicy,
)
from app.rule_normalizers import (
    is_blank_value,
    normalize_key,
    normalize_text,
    parse_decimal_value,
    parse_vat_rate,
    parse_vietnamese_date,
    round_money,
)
from app.rule_sources import LEGAL_DISCLAIMER, MISA_IMPORT_REQUIRED, VAT_8_WINDOW, VAT_LAW


MONEY_TOLERANCE = Decimal("1")
MAX_REPORTED_ISSUES = 250
SUPPORTED_VAT_RATES = {Decimal("0"), Decimal("0.05"), Decimal("0.08"), Decimal("0.10")}


@dataclass
class _IssueCollector:
    counts: dict[str, int]
    issues: list[MisaValidationIssue]

    def add(self, issue: MisaValidationIssue) -> None:
        self.counts[issue.severity] += 1
        if len(self.issues) < MAX_REPORTED_ISSUES:
            self.issues.append(issue)


def validate_misa_readiness(
    *,
    input_rows: int,
    target_template_id: str,
    target_headers: list[str],
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None,
    formulas: dict[str, str] | None,
    output_rows: list[dict[str, Any]],
    source_headers: list[str] | None = None,
    hidden_rows: list[int] | None = None,
    formula_cells: list[str] | None = None,
    blank_rows_ignored: int = 0,
    accounting_regime: str | None = None,
    fiscal_year_start: str | None = None,
    vat_policy: VatPolicy | dict[str, Any] | None = None,
) -> MisaReadinessReport:
    del accounting_regime, fiscal_year_start  # reserved for later COA/regime rules
    defaults = defaults or {}
    formulas = formulas or {}
    policy = _coerce_vat_policy(vat_policy)
    collector = _IssueCollector(
        counts={"fatal": 0, "blocker": 0, "warning": 0, "info": 0},
        issues=[],
    )

    required_headers = _required_headers(target_template_id, target_headers)
    mapped_targets = _mapped_targets(mapping)
    for header in required_headers:
        if header not in mapped_targets and header not in defaults and header not in formulas:
            collector.add(
                _issue(
                    severity="blocker",
                    category="template",
                    code="required_mapping_missing",
                    message=f"Thiếu thiết lập cho cột bắt buộc '{header}'.",
                    field=header,
                    source_url=MISA_IMPORT_REQUIRED.url,
                    explanation=IssueExplanation(
                        why="Trong template MISA, cột có (*) hoặc cột bắt buộc phải có nguồn dữ liệu.",
                        impact="Nếu thiếu, file import có thể bị MISA từ chối hoặc sai chứng từ.",
                        fix="Chọn cột raw, nhập default hoặc công thức cho cột bắt buộc này.",
                    ),
                )
            )

    active_rows = [
        (index, row)
        for index, row in enumerate(output_rows, start=1)
        if any(not is_blank_value(value) for value in row.values())
    ]

    for row_number, row in active_rows:
        for header in required_headers:
            if is_blank_value(row.get(header)):
                collector.add(
                    _issue(
                        severity="blocker",
                        category="template",
                        code="required_value_blank",
                        message=f"Dòng {row_number} thiếu giá trị cho cột bắt buộc '{header}'.",
                        row=row_number,
                        field=header,
                        invoice=_invoice(row, target_headers),
                        source_url=MISA_IMPORT_REQUIRED.url,
                        explanation=IssueExplanation(
                            why="Cột bắt buộc của MISA không được để trống ở dòng dữ liệu đang import.",
                            impact="MISA có thể chặn import hoặc tạo chứng từ thiếu thông tin.",
                            fix="Bổ sung mapping/default/formula hoặc sửa dữ liệu nguồn cho dòng này.",
                        ),
                    )
                )

    _check_workbook_warnings(
        collector,
        hidden_rows=hidden_rows or [],
        formula_cells=formula_cells or [],
        blank_rows_ignored=blank_rows_ignored,
    )
    _check_normalization_infos(collector, active_rows, target_headers)
    _check_row_values(collector, active_rows, target_headers, policy)
    reconciliation = _reconcile(
        input_rows=input_rows,
        output_rows=output_rows,
        target_headers=target_headers,
        source_headers=source_headers or [],
        mapping=mapping,
    )
    summary = MisaValidationSummary(**collector.counts)
    status = _status(summary)
    if reconciliation.unmapped_columns:
        collector.add(
            _issue(
                severity="warning",
                category="mapping",
                code="unused_source_columns",
                message="Một số cột nguồn chưa được dùng trong mapping.",
                actual=len(reconciliation.unmapped_columns),
                explanation=IssueExplanation(
                    why="File nguồn có cột không được đưa vào template MISA.",
                    impact="Có thể bình thường, nhưng cũng có thể bỏ sót thông tin quan trọng.",
                    fix="Kiểm tra danh sách cột chưa dùng trong phần đối chiếu nhanh.",
                ),
            )
        )
        summary = MisaValidationSummary(**collector.counts)
        status = _status(summary)

    return MisaReadinessReport(
        validation_run_id=str(uuid.uuid4()),
        ok=status == "ready",
        status=status,
        score=_score(summary),
        summary=summary,
        issues=collector.issues,
        reconciliation=reconciliation,
        legal_disclaimer=LEGAL_DISCLAIMER,
    )


def _check_row_values(
    collector: _IssueCollector,
    active_rows: list[tuple[int, dict[str, Any]]],
    target_headers: list[str],
    vat_policy: VatPolicy,
) -> None:
    header = _header_lookup(target_headers)
    date_header = _first_header(header, "ngay_chung_tu", "ngay_hach_toan", "ngay_hoa_don")
    quantity_header = _first_header(header, "so_luong")
    unit_price_header = _first_header(header, "don_gia")
    discount_header = _first_header(header, "tien_chiet_khau", "chiet_khau")
    amount_header = _first_header(header, "thanh_tien")
    vat_rate_header = _first_header(
        header,
        "thue_suat_gtgt",
        "thue_gtgt",
        "percent_thue_gtgt",
        "vat_percent",
        "vat",
    )
    vat_amount_header = _first_header(header, "tien_thue_gtgt", "tien_thue")
    total_header = _first_header(header, "tong_tien_thanh_toan", "tong_tien", "khach_can_tra")
    buyer_tax_header = _first_header(header, "ma_so_thue", "mst", "ma_so_thue_nguoi_mua")
    vat8_warning_added = False
    vat5_warning_added = False
    buyer_tax_warning_added = False
    negative_warning_added = False
    zero_price_warning_added = False
    account_pattern_warning_added = False

    for row_number, row in active_rows:
        invoice = _invoice(row, target_headers)
        _check_dates(collector, row_number, row, invoice, target_headers)

        quantity = _parse_number_cell(collector, row_number, row, quantity_header, invoice)
        unit_price = _parse_number_cell(collector, row_number, row, unit_price_header, invoice)
        discount = _parse_number_cell(collector, row_number, row, discount_header, invoice) or Decimal("0")
        amount = _parse_number_cell(collector, row_number, row, amount_header, invoice)
        vat_amount = _parse_number_cell(collector, row_number, row, vat_amount_header, invoice)
        total = _parse_number_cell(collector, row_number, row, total_header, invoice)

        if quantity is not None and unit_price is not None and amount is not None:
            gross_amount = round_money(quantity * unit_price)
            net_amount = round_money(quantity * unit_price - discount)
            if _outside_tolerance(gross_amount, amount) and _outside_tolerance(net_amount, amount):
                collector.add(
                    _issue(
                        severity="blocker",
                        category="calculation",
                        code="line_amount_mismatch",
                        message="Thành tiền không khớp với Số lượng × Đơn giá - Chiết khấu.",
                        row=row_number,
                        field=amount_header,
                        invoice=invoice,
                        expected=_fmt(net_amount if discount else gross_amount),
                        actual=_fmt(amount),
                        delta=_fmt(amount - (net_amount if discount else gross_amount)),
                        explanation=IssueExplanation(
                            why="Đây là kiểm tra toán học quyết định, không phụ thuộc phán đoán nghiệp vụ.",
                            impact="Nếu giữ nguyên, tổng tiền hoặc thuế có thể bị sai.",
                            fix="Kiểm tra lại Số lượng, Đơn giá, Chiết khấu hoặc Thành tiền.",
                        ),
                    )
                )

        numeric_values = [
            (quantity_header, quantity),
            (unit_price_header, unit_price),
            (discount_header, discount if discount != 0 else None),
            (amount_header, amount),
            (vat_amount_header, vat_amount),
            (total_header, total),
        ]
        if not negative_warning_added:
            negative = next(((field, value) for field, value in numeric_values if value is not None and value < 0), None)
            if negative:
                negative_warning_added = True
                collector.add(
                    _issue(
                        severity="warning",
                        category="business",
                        code="negative_amount_context_unclear",
                        message="Có giá trị âm, cần kiểm tra đây là hàng trả/giảm trừ hay lỗi dữ liệu.",
                        row=row_number,
                        field=negative[0],
                        invoice=invoice,
                        actual=_fmt(negative[1]),
                        explanation=IssueExplanation(
                            why="Giá trị âm có thể hợp lệ trong nghiệp vụ điều chỉnh, nhưng không thể tự kết luận.",
                            impact="Nếu âm sai ngữ cảnh, doanh thu/tồn kho/thuế có thể bị đảo dấu.",
                            fix="Kiểm tra loại chứng từ và nghiệp vụ phát sinh.",
                        ),
                    )
                )
        if (
            not zero_price_warning_added
            and quantity is not None
            and quantity > 0
            and ((unit_price is not None and unit_price == 0) or (amount is not None and amount == 0))
        ):
            zero_price_warning_added = True
            collector.add(
                _issue(
                    severity="warning",
                    category="business",
                    code="zero_price_promotion_unclear",
                    message="Có dòng số lượng > 0 nhưng đơn giá/thành tiền bằng 0.",
                    row=row_number,
                    field=unit_price_header or amount_header,
                    invoice=invoice,
                    explanation=IssueExplanation(
                        why="Dòng giá 0 có thể là hàng khuyến mại hoặc lỗi mapping/đơn giá.",
                        impact="Nếu không đúng nghiệp vụ, doanh thu và giá vốn có thể lệch.",
                        fix="Xác nhận đây là hàng khuyến mại hoặc sửa lại đơn giá/thành tiền.",
                    ),
                )
            )

        if (
            buyer_tax_header
            and not buyer_tax_warning_added
            and is_blank_value(row.get(buyer_tax_header))
        ):
            buyer_tax_warning_added = True
            collector.add(
                _issue(
                    severity="warning",
                    category="tax",
                    code="buyer_tax_code_missing_optional",
                    message="Mã số thuế người mua đang trống, cần kiểm tra nếu xuất hóa đơn cho doanh nghiệp.",
                    row=row_number,
                    field=buyer_tax_header,
                    invoice=invoice,
                    explanation=IssueExplanation(
                        why="Mã số thuế có thể không bắt buộc với khách lẻ, nhưng quan trọng với khách doanh nghiệp.",
                        impact="Thiếu MST có thể làm hóa đơn/đối soát khách hàng chưa đủ thông tin.",
                        fix="Bổ sung MST nếu người mua là tổ chức/doanh nghiệp.",
                    ),
                )
            )

        transaction_date = parse_vietnamese_date(row.get(date_header)) if date_header else None
        vat_rate = _parse_vat_cell(collector, row_number, row, vat_rate_header, invoice)
        if vat_rate == "NON_TAXABLE":
            if vat_amount is not None and vat_amount != 0:
                _add_vat_mismatch(
                    collector, row_number, vat_amount_header, invoice, Decimal("0"), vat_amount
                )
        elif isinstance(vat_rate, Decimal):
            if vat_rate not in SUPPORTED_VAT_RATES:
                collector.add(
                    _issue(
                        severity="blocker",
                        category="vat",
                        code="vat_rate_unsupported",
                        message="Thuế suất GTGT không thuộc nhóm hỗ trợ: 0%, 5%, 8%, 10% hoặc KCT.",
                        row=row_number,
                        field=vat_rate_header,
                        invoice=invoice,
                        expected="0%, 5%, 8%, 10%, KCT",
                        actual=str(row.get(vat_rate_header)),
                        source_url=VAT_LAW.url,
                        explanation=IssueExplanation(
                            why="MVP chỉ cho phép các thuế suất GTGT phổ biến đã cấu hình.",
                            impact="Thuế suất lạ có thể làm sai tiền thuế hoặc cần rule riêng.",
                            fix="Kiểm tra lại cột thuế suất hoặc cấu hình thêm rule nếu doanh nghiệp có trường hợp đặc biệt.",
                        ),
                    )
                )
            elif vat_rate == Decimal("0.08"):
                if not vat_policy.allow_8_percent:
                    collector.add(
                        _issue(
                            severity="blocker",
                            category="vat",
                            code="vat_8_not_allowed_by_policy",
                            message="Thuế suất 8% không được bật trong cấu hình kiểm tra hiện tại.",
                            row=row_number,
                            field=vat_rate_header,
                            invoice=invoice,
                            source_url=VAT_8_WINDOW.url,
                            explanation=IssueExplanation(
                                why="Cấu hình vat_policy.allow_8_percent=false nghĩa là không cho phép dùng chính sách 8%.",
                                impact="Export có thể dùng thuế suất không phù hợp với cấu hình doanh nghiệp.",
                                fix="Bật allow_8_percent nếu doanh nghiệp áp dụng chính sách giảm thuế, hoặc sửa thuế suất.",
                            ),
                        )
                    )
                elif _date_outside_policy(transaction_date, vat_policy):
                    collector.add(
                        _issue(
                            severity="blocker",
                            category="vat",
                            code="vat_8_outside_policy_window",
                            message="Thuế suất 8% nằm ngoài thời gian chính sách giảm thuế đã cấu hình.",
                            row=row_number,
                            field=vat_rate_header,
                            invoice=invoice,
                            source_url=VAT_8_WINDOW.url,
                            explanation=IssueExplanation(
                                why="MVP chỉ chấp nhận 8% trong khoảng hiệu lực đã cấu hình.",
                                impact="Có rủi ro dùng sai thuế suất theo ngày chứng từ.",
                                fix="Kiểm tra ngày chứng từ hoặc cấu hình vat_policy.",
                            ),
                        )
                    )
                elif vat_policy.allow_8_percent and not vat8_warning_added:
                    vat8_warning_added = True
                    collector.add(
                        _issue(
                            severity="warning",
                            category="vat",
                            code="vat_8_eligibility_uncertain",
                            message="Thuế suất 8% cần kiểm tra điều kiện hàng hóa/dịch vụ được giảm thuế.",
                            row=row_number,
                            field=vat_rate_header,
                            invoice=invoice,
                            source_url=VAT_8_WINDOW.url,
                            explanation=IssueExplanation(
                                why="8% là chính sách giảm từ 10% cho nhóm đủ điều kiện, app không tự phân loại mặt hàng.",
                                impact="Nếu mặt hàng không đủ điều kiện, doanh nghiệp có thể kê khai sai thuế suất.",
                                fix="Kế toán kiểm tra nhóm hàng hóa/dịch vụ trước khi xác nhận cảnh báo.",
                            ),
                        )
                    )
            elif vat_rate == Decimal("0.05") and not vat5_warning_added:
                vat5_warning_added = True
                collector.add(
                    _issue(
                        severity="warning",
                        category="vat",
                        code="vat_5_category_uncertain",
                        message="Thuế suất 5% cần kiểm tra nhóm hàng hóa/dịch vụ áp dụng.",
                        row=row_number,
                        field=vat_rate_header,
                        invoice=invoice,
                        source_url=VAT_LAW.url,
                        explanation=IssueExplanation(
                            why="App không tự phân loại hàng hóa/dịch vụ để kết luận chắc chắn thuế suất 5%.",
                            impact="Nếu mặt hàng không thuộc nhóm 5%, kê khai thuế có thể sai.",
                            fix="Kế toán kiểm tra danh mục hàng hóa/dịch vụ và quy định thuế trước khi xác nhận.",
                        ),
                    )
                )
            if amount is not None and vat_amount is not None:
                expected_vat = round_money(amount * vat_rate)
                if _outside_tolerance(expected_vat, vat_amount):
                    _add_vat_mismatch(
                        collector, row_number, vat_amount_header, invoice, expected_vat, vat_amount
                    )

        if amount is not None and vat_amount is not None and total is not None:
            expected_total = round_money(amount + vat_amount)
            if _outside_tolerance(expected_total, total):
                collector.add(
                    _issue(
                        severity="blocker",
                        category="calculation",
                        code="total_amount_mismatch",
                        message="Tổng tiền thanh toán không khớp với Thành tiền + Tiền thuế GTGT.",
                        row=row_number,
                        field=total_header,
                        invoice=invoice,
                        expected=_fmt(expected_total),
                        actual=_fmt(total),
                        delta=_fmt(total - expected_total),
                        explanation=IssueExplanation(
                            why="Đây là đối chiếu tổng tiền theo các cột đã có trong file.",
                            impact="Số tiền phải thu/phải trả có thể sai.",
                            fix="Kiểm tra Thành tiền, Tiền thuế GTGT hoặc Tổng tiền.",
                        ),
                    )
                )

        if not account_pattern_warning_added:
            unusual_account = _first_unusual_account(row, target_headers)
            if unusual_account:
                account_pattern_warning_added = True
                account_header, account_value = unusual_account
                collector.add(
                    _issue(
                        severity="warning",
                        category="accounting",
                        code="account_pattern_unusual",
                        message="Tài khoản kế toán có định dạng khác thường.",
                        row=row_number,
                        field=account_header,
                        invoice=invoice,
                        actual=str(account_value),
                        explanation=IssueExplanation(
                            why="MVP chỉ kiểm tra pattern cơ bản vì chưa có danh mục tài khoản doanh nghiệp.",
                            impact="Có thể là tài khoản nhập sai hoặc tài khoản nội bộ cần cấu hình thêm.",
                            fix="Kiểm tra lại mã tài khoản hoặc nạp COA/danh mục tài khoản để kiểm tra chặt hơn.",
                        ),
                    )
                )

    _check_invoice_header_conflicts(collector, active_rows, target_headers)
    _check_mixed_tax_rates(collector, active_rows, target_headers)
    _check_duplicates(collector, active_rows, target_headers)


def _check_workbook_warnings(
    collector: _IssueCollector,
    *,
    hidden_rows: list[int],
    formula_cells: list[str],
    blank_rows_ignored: int,
) -> None:
    if hidden_rows:
        collector.add(
            _issue(
                severity="warning",
                category="workbook",
                code="hidden_rows_detected",
                message="File nguồn có dòng bị ẩn.",
                row=hidden_rows[0],
                actual=len(hidden_rows),
                explanation=IssueExplanation(
                    why="Dòng ẩn có thể vẫn được đọc và import nếu có dữ liệu.",
                    impact="Có thể import cả dữ liệu người dùng không nhìn thấy trên Excel.",
                    fix="Mở file nguồn và kiểm tra các dòng đang bị ẩn.",
                ),
            )
        )
    if formula_cells:
        collector.add(
            _issue(
                severity="warning",
                category="workbook",
                code="formula_cell_used",
                message="File nguồn có ô công thức; cần kiểm tra giá trị trước khi import.",
                field=formula_cells[0],
                actual=len(formula_cells),
                explanation=IssueExplanation(
                    why="Công thức có thể thay đổi khi mở file hoặc khi thiếu workbook liên kết.",
                    impact="Giá trị import có thể khác với kỳ vọng nếu công thức chưa tính đúng.",
                    fix="Kiểm tra công thức hoặc paste values trước khi upload.",
                ),
            )
        )
    if blank_rows_ignored:
        collector.add(
            _issue(
                severity="info",
                category="workbook",
                code="blank_row_ignored",
                message="Đã bỏ qua dòng trống trong file nguồn.",
                actual=blank_rows_ignored,
                explanation=IssueExplanation(
                    why="Dòng trống không tạo dữ liệu MISA.",
                    impact="Không ảnh hưởng nếu đó là dòng phân cách.",
                    fix="Không cần sửa nếu số dòng dữ liệu đầu ra khớp kỳ vọng.",
                ),
            )
        )


def _check_normalization_infos(
    collector: _IssueCollector,
    active_rows: list[tuple[int, dict[str, Any]]],
    target_headers: list[str],
) -> None:
    reported: set[str] = set()
    date_fields = {
        header
        for header in target_headers
        if "ngay" in normalize_key(header) or "han_su_dung" in normalize_key(header)
    }

    for row_number, row in active_rows:
        for field, value in row.items():
            if not isinstance(value, str):
                continue

            normalized = normalize_text(value)
            if normalized != value and "text_trimmed" not in reported:
                reported.add("text_trimmed")
                collector.add(
                    _issue(
                        severity="info",
                        category="normalization",
                        code="text_trimmed",
                        message="Có giá trị text đã được chuẩn hóa khoảng trắng.",
                        row=row_number,
                        field=field,
                        expected=normalized,
                        actual=value,
                        explanation=IssueExplanation(
                            why="Khoảng trắng thừa có thể làm sai mã hoặc tên khi đối chiếu.",
                            impact="Không chặn export; chỉ thông báo cách validator hiểu dữ liệu.",
                            fix="Nếu mã/tên bị sai, sửa lại dữ liệu nguồn hoặc mapping.",
                        ),
                    )
                )

            if field in date_fields:
                parsed_date = parse_vietnamese_date(value)
                if (
                    parsed_date is not None
                    and normalized != parsed_date.isoformat()
                    and "date_normalized" not in reported
                ):
                    reported.add("date_normalized")
                    collector.add(
                        _issue(
                            severity="info",
                            category="normalization",
                            code="date_normalized",
                            message="Có ngày được đọc và chuẩn hóa để kiểm tra.",
                            row=row_number,
                            field=field,
                            expected=parsed_date.isoformat(),
                            actual=value,
                            explanation=IssueExplanation(
                                why="Validator cần đưa ngày về dạng chuẩn để so sánh kỳ hạn/chính sách.",
                                impact="Không chặn export; chỉ thông báo cách hệ thống hiểu giá trị ngày.",
                                fix="Nếu ngày hệ thống hiểu sai, sửa định dạng ngày trong file nguồn.",
                            ),
                        )
                    )

            if _looks_like_number_text(value):
                parsed_number = parse_decimal_value(value)
                if (
                    parsed_number is not None
                    and normalized != str(parsed_number)
                    and "number_normalized" not in reported
                ):
                    reported.add("number_normalized")
                    collector.add(
                        _issue(
                            severity="info",
                            category="normalization",
                            code="number_normalized",
                            message="Có số được đọc và chuẩn hóa để kiểm tra.",
                            row=row_number,
                            field=field,
                            expected=str(parsed_number),
                            actual=value,
                            explanation=IssueExplanation(
                                why="Validator cần chuẩn hóa dấu phân tách nghìn/thập phân trước khi tính toán.",
                                impact="Không chặn export; chỉ thông báo cách hệ thống hiểu giá trị số.",
                                fix="Nếu số hệ thống hiểu sai, sửa định dạng số trong file nguồn.",
                            ),
                        )
                    )

            if {"text_trimmed", "date_normalized", "number_normalized"}.issubset(reported):
                return


def _looks_like_number_text(value: str) -> bool:
    text = normalize_text(value).lower()
    return bool(re.fullmatch(r"\(?-?\d[\d\s,.\u00a0]*(\))?(\s*(đ|vnd|vnđ))?", text))


def _check_dates(
    collector: _IssueCollector,
    row_number: int,
    row: dict[str, Any],
    invoice: str | None,
    target_headers: list[str],
) -> None:
    for header in target_headers:
        key = normalize_key(header)
        if "ngay" not in key or is_blank_value(row.get(header)):
            continue
        parsed_date = parse_vietnamese_date(row.get(header))
        if parsed_date is None:
            collector.add(
                _issue(
                    severity="blocker",
                    category="format",
                    code="date_unparseable",
                    message=f"Không đọc được ngày ở cột '{header}'.",
                    row=row_number,
                    field=header,
                    invoice=invoice,
                    actual=str(row.get(header)),
                    explanation=IssueExplanation(
                        why="Ngày phải đọc được theo serial Excel, dd/mm/yyyy, dd-mm-yyyy hoặc yyyy-mm-dd.",
                        impact="Ngày chứng từ/hạch toán sai có thể làm sai kỳ kế toán.",
                        fix="Sửa lại định dạng ngày trong file nguồn hoặc mapping.",
                    ),
                )
            )
        elif parsed_date > date.today():
            collector.add(
                _issue(
                    severity="warning",
                    category="business",
                    code="future_date",
                    message=f"Ngày ở cột '{header}' nằm trong tương lai.",
                    row=row_number,
                    field=header,
                    invoice=invoice,
                    actual=parsed_date.isoformat(),
                    explanation=IssueExplanation(
                        why="Ngày tương lai có thể hợp lệ với đơn đặt trước, nhưng thường là lỗi nhập liệu.",
                        impact="Có thể hạch toán sai kỳ hoặc chưa đến ngày phát sinh.",
                        fix="Kiểm tra lại ngày chứng từ/hạch toán.",
                    ),
                )
            )


def _parse_number_cell(
    collector: _IssueCollector,
    row_number: int,
    row: dict[str, Any],
    header: str | None,
    invoice: str | None,
) -> Decimal | None:
    if not header or is_blank_value(row.get(header)):
        return None
    parsed = parse_decimal_value(row.get(header))
    if parsed is None:
        collector.add(
            _issue(
                severity="blocker",
                category="format",
                code="number_unparseable",
                message=f"Không đọc được số ở cột '{header}'.",
                row=row_number,
                field=header,
                invoice=invoice,
                actual=str(row.get(header)),
                explanation=IssueExplanation(
                    why="Các cột tiền/số lượng phải chuyển được sang số trước khi tính toán.",
                    impact="Không thể đối chiếu công thức và có thể export sai số tiền.",
                    fix="Sửa ký tự lạ hoặc định dạng số trong file nguồn.",
                ),
            )
        )
    return parsed


def _parse_vat_cell(
    collector: _IssueCollector,
    row_number: int,
    row: dict[str, Any],
    header: str | None,
    invoice: str | None,
) -> Decimal | str | None:
    if not header or is_blank_value(row.get(header)):
        return None
    parsed = parse_vat_rate(row.get(header))
    if parsed is None:
        collector.add(
            _issue(
                severity="blocker",
                category="vat",
                code="vat_rate_unsupported",
                message="Không đọc được thuế suất GTGT.",
                row=row_number,
                field=header,
                invoice=invoice,
                expected="0%, 5%, 8%, 10%, KCT",
                actual=str(row.get(header)),
                source_url=VAT_LAW.url,
            )
        )
    return parsed


def _add_vat_mismatch(
    collector: _IssueCollector,
    row_number: int,
    field: str | None,
    invoice: str | None,
    expected: Decimal,
    actual: Decimal,
) -> None:
    collector.add(
        _issue(
            severity="blocker",
            category="vat",
            code="vat_amount_mismatch",
            message="Tiền thuế GTGT không khớp với Thành tiền × Thuế suất.",
            row=row_number,
            field=field,
            invoice=invoice,
            expected=_fmt(expected),
            actual=_fmt(actual),
            delta=_fmt(actual - expected),
            source_url=VAT_LAW.url,
            explanation=IssueExplanation(
                why="Tiền thuế GTGT phải được tính từ giá tính thuế nhân với thuế suất.",
                impact="Nếu giữ nguyên, tổng tiền hóa đơn hoặc dữ liệu import có thể sai.",
                fix="Kiểm tra lại Thành tiền, Thuế suất hoặc Tiền thuế GTGT.",
            ),
        )
    )


def _check_duplicates(
    collector: _IssueCollector,
    active_rows: list[tuple[int, dict[str, Any]]],
    target_headers: list[str],
) -> None:
    lookup = _header_lookup(target_headers)
    seller_tax_header = _first_header(lookup, "ma_so_thue_nguoi_ban", "mst_nguoi_ban")
    symbol_header = _first_header(lookup, "ky_hieu_hoa_don", "mau_so_ky_hieu")
    invoice_header = _first_header(lookup, "so_hoa_don")
    strong_key_available = bool(seller_tax_header and symbol_header and invoice_header)
    if not active_rows:
        return
    if not strong_key_available:
        _check_possible_duplicate_without_strong_key(collector, active_rows)
        return

    line_fields = [
        _first_header(lookup, "ma_hang", "ma_hang_hoa"),
        _first_header(lookup, "ten_hang", "ten_hang_hoa"),
        _first_header(lookup, "so_luong"),
        _first_header(lookup, "don_gia"),
    ]
    line_fields = [field for field in line_fields if field]
    amount_fields = [
        _first_header(lookup, "thanh_tien"),
        _first_header(lookup, "tien_thue_gtgt", "tien_thue"),
        _first_header(lookup, "tong_tien_thanh_toan", "tong_tien"),
    ]
    amount_fields = [field for field in amount_fields if field]
    if not line_fields or not amount_fields:
        return

    seen: dict[str, dict[tuple[str, ...], tuple[int, tuple[str, ...]]]] = {}
    for row_number, row in active_rows:
        key_parts = [
            str(row.get(seller_tax_header) or "").strip(),
            str(row.get(symbol_header) or "").strip(),
            str(row.get(invoice_header) or "").strip(),
        ]
        if any(not part for part in key_parts):
            continue
        invoice = "|".join(key_parts)
        line_fingerprint = tuple(str(row.get(field) or "").strip() for field in line_fields)
        amount_fingerprint = tuple(str(row.get(field) or "").strip() for field in amount_fields)
        previous = seen.setdefault(invoice, {}).get(line_fingerprint)
        if previous and previous[1] != amount_fingerprint:
            collector.add(
                _issue(
                    severity="blocker",
                    category="document",
                    code="duplicate_invoice_key",
                    message="Trùng khóa chứng từ và dòng hàng nhưng số tiền khác nhau.",
                    row=row_number,
                    field=invoice_header,
                    invoice=invoice,
                    actual=invoice,
                    explanation=IssueExplanation(
                        why="Cùng một khóa chứng từ và cùng dòng hàng xuất hiện với số tiền khác nhau trong một lần import.",
                        impact="Có thể tạo chứng từ trùng hoặc sai chi tiết.",
                        fix="Kiểm tra lại số chứng từ hoặc tách/ghép chứng từ đúng nghiệp vụ.",
                    ),
                )
            )
        else:
            seen[invoice][line_fingerprint] = (row_number, amount_fingerprint)


def _check_possible_duplicate_without_strong_key(
    collector: _IssueCollector,
    active_rows: list[tuple[int, dict[str, Any]]],
) -> None:
    seen_fingerprints: dict[str, int] = {}
    for row_number, row in active_rows:
        fingerprint = repr(
            sorted((key, str(value)) for key, value in row.items() if not is_blank_value(value))
        )
        if fingerprint in seen_fingerprints:
            collector.add(
                _issue(
                    severity="warning",
                    category="document",
                    code="possible_duplicate",
                    message="Có dòng giống nhau nhưng thiếu khóa hóa đơn/chứng từ để kết luận trùng chắc chắn.",
                    row=row_number,
                    explanation=IssueExplanation(
                        why="Không đủ khóa mạnh nên chỉ cảnh báo khả năng trùng.",
                        impact="Có thể import lặp dòng nếu đây không phải nghiệp vụ hợp lệ.",
                        fix="Kiểm tra lại dòng trùng hoặc bổ sung số hóa đơn/ký hiệu/MST người bán nếu có.",
                    ),
                )
            )
            return
        seen_fingerprints[fingerprint] = row_number


def _check_invoice_header_conflicts(
    collector: _IssueCollector,
    active_rows: list[tuple[int, dict[str, Any]]],
    target_headers: list[str],
) -> None:
    lookup = _header_lookup(target_headers)
    invoice_header = _first_header(lookup, "so_chung_tu", "so_hoa_don")
    if not invoice_header:
        return
    header_fields = [
        _first_header(lookup, "ngay_chung_tu", "ngay_hoa_don"),
        _first_header(lookup, "ngay_hach_toan"),
        _first_header(lookup, "ma_khach_hang", "ma_nha_cung_cap"),
        _first_header(lookup, "ten_khach_hang", "ten_nha_cung_cap"),
        _first_header(lookup, "ma_so_thue", "mst"),
    ]
    header_fields = [field for field in header_fields if field]
    if not header_fields:
        return
    seen: dict[str, tuple[int, tuple[str, ...]]] = {}
    for row_number, row in active_rows:
        invoice = str(row.get(invoice_header) or "").strip()
        if not invoice:
            continue
        fingerprint = tuple(str(row.get(field) or "").strip() for field in header_fields)
        previous = seen.get(invoice)
        if previous and previous[1] != fingerprint:
            collector.add(
                _issue(
                    severity="blocker",
                    category="document",
                    code="invoice_header_conflict",
                    message="Cùng số chứng từ nhưng thông tin header hóa đơn khác nhau.",
                    row=row_number,
                    field=invoice_header,
                    invoice=invoice,
                    explanation=IssueExplanation(
                        why="Một chứng từ không nên có ngày/khách hàng/MST khác nhau giữa các dòng.",
                        impact="Import có thể tạo chứng từ sai header hoặc gộp nhầm dòng.",
                        fix="Kiểm tra lại số chứng từ, ngày và thông tin khách hàng/nhà cung cấp.",
                    ),
                )
            )
        else:
            seen[invoice] = (row_number, fingerprint)


def _first_unusual_account(row: dict[str, Any], target_headers: list[str]) -> tuple[str, Any] | None:
    for header in target_headers:
        key = normalize_key(header)
        if not key.startswith("tk"):
            continue
        value = row.get(header)
        if is_blank_value(value):
            continue
        text = str(value).strip()
        if not re.fullmatch(r"\d{3,}(?:\.\d+)?", text):
            return header, value
    return None


def _check_mixed_tax_rates(
    collector: _IssueCollector,
    active_rows: list[tuple[int, dict[str, Any]]],
    target_headers: list[str],
) -> None:
    lookup = _header_lookup(target_headers)
    if _first_header(lookup, "percent_thue_suat_khac", "thue_suat_khac"):
        return
    invoice_header = _first_header(lookup, "so_chung_tu", "so_hoa_don")
    vat_rate_header = _first_header(
        lookup,
        "thue_suat_gtgt",
        "thue_gtgt",
        "percent_thue_gtgt",
        "vat_percent",
        "vat",
    )
    if not invoice_header or not vat_rate_header:
        return
    rates_by_invoice: dict[str, set[str]] = {}
    first_row_by_invoice: dict[str, int] = {}
    for row_number, row in active_rows:
        invoice = str(row.get(invoice_header) or "").strip()
        if not invoice:
            continue
        rate = parse_vat_rate(row.get(vat_rate_header))
        if rate is None:
            continue
        rates_by_invoice.setdefault(invoice, set()).add(str(rate))
        first_row_by_invoice.setdefault(invoice, row_number)
    for invoice, rates in rates_by_invoice.items():
        if len(rates) > 1:
            collector.add(
                _issue(
                    severity="blocker",
                    category="vat",
                    code="one_tax_template_mixed_rates",
                    message="Một chứng từ có nhiều thuế suất nhưng template không có cột thuế suất khác.",
                    row=first_row_by_invoice.get(invoice),
                    field=vat_rate_header,
                    invoice=invoice,
                    actual=", ".join(sorted(rates)),
                    explanation=IssueExplanation(
                        why="Template một thuế suất không biểu diễn rõ nhiều mức thuế trên cùng chứng từ.",
                        impact="Tiền thuế hoặc dòng thuế có thể import sai.",
                        fix="Tách chứng từ theo thuế suất hoặc chọn template/cấu hình hỗ trợ nhiều thuế suất.",
                    ),
                )
            )


def _reconcile(
    *,
    input_rows: int,
    output_rows: list[dict[str, Any]],
    target_headers: list[str],
    source_headers: list[str],
    mapping: dict[str, Any],
) -> ReconciliationReport:
    header = _header_lookup(target_headers)
    invoice_header = _first_header(header, "so_chung_tu", "so_hoa_don")
    amount_header = _first_header(header, "thanh_tien")
    vat_header = _first_header(header, "tien_thue_gtgt", "tien_thue")
    total_header = _first_header(header, "tong_tien_thanh_toan", "tong_tien", "khach_can_tra")
    mapped_sources = {str(key) for key in mapping}
    return ReconciliationReport(
        input_rows=input_rows,
        output_rows=len(output_rows),
        invoice_count=len({str(row.get(invoice_header)) for row in output_rows if invoice_header and row.get(invoice_header)}),
        sum_amount=_fmt(_sum_column(output_rows, amount_header)) if amount_header else None,
        sum_vat=_fmt(_sum_column(output_rows, vat_header)) if vat_header else None,
        sum_total=_fmt(_sum_column(output_rows, total_header)) if total_header else None,
        unmapped_columns=[header for header in source_headers if header not in mapped_sources],
    )


def _required_headers(target_template_id: str, target_headers: list[str]) -> list[str]:
    required = {header for header in target_headers if "(*)" in header}
    definition = CONVERSION_TYPES.get(target_template_id)
    if definition:
        required.update(header for header in definition.required_output_headers if header in target_headers)
    return [header for header in target_headers if header in required]


def _mapped_targets(mapping: dict[str, Any]) -> set[str]:
    targets: set[str] = set()
    for target in mapping.values():
        if isinstance(target, list):
            targets.update(str(item) for item in target)
        else:
            targets.add(str(target))
    return targets


def _invoice(row: dict[str, Any], target_headers: list[str]) -> str | None:
    header = _first_header(_header_lookup(target_headers), "so_chung_tu", "so_hoa_don")
    value = row.get(header) if header else None
    if is_blank_value(value):
        return None
    return str(value).strip()


def _header_lookup(headers: list[str]) -> dict[str, str]:
    return {normalize_key(header): header for header in headers}


def _first_header(lookup: dict[str, str], *keys: str) -> str | None:
    for key in keys:
        if key in lookup:
            return lookup[key]
    return None


def _sum_column(rows: list[dict[str, Any]], header: str | None) -> Decimal:
    if not header:
        return Decimal("0")
    total = Decimal("0")
    for row in rows:
        value = parse_decimal_value(row.get(header))
        if value is not None:
            total += value
    return total


def _status(summary: MisaValidationSummary) -> str:
    if summary.fatal:
        return "fatal"
    if summary.blocker:
        return "blocked"
    if summary.warning:
        return "needs_review"
    return "ready"


def _score(summary: MisaValidationSummary) -> int:
    score = 100 - summary.fatal * 40 - summary.blocker * 15 - summary.warning * 5
    return max(0, min(100, score))


def _outside_tolerance(expected: Decimal, actual: Decimal) -> bool:
    return abs(actual - expected) > MONEY_TOLERANCE


def _date_outside_policy(transaction_date: date | None, policy: VatPolicy) -> bool:
    if transaction_date is None:
        return False
    start = parse_vietnamese_date(policy.effective_from)
    end = parse_vietnamese_date(policy.effective_to)
    if start and transaction_date < start:
        return True
    if end and transaction_date > end:
        return True
    return False


def _coerce_vat_policy(policy: VatPolicy | dict[str, Any] | None) -> VatPolicy:
    if isinstance(policy, VatPolicy):
        return policy
    if isinstance(policy, dict):
        return VatPolicy.model_validate(policy)
    return VatPolicy()


def _fmt(value: Decimal | None) -> str | None:
    if value is None:
        return None
    normalized = value.normalize()
    if normalized == normalized.to_integral():
        return str(normalized.quantize(Decimal("1")))
    return format(normalized, "f")


def _issue(**kwargs: Any) -> MisaValidationIssue:
    return MisaValidationIssue(**kwargs)
