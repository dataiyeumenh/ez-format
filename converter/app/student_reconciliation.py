from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.normalization import normalize_header
from app.parsing import parse_decimal


MONEY_TOLERANCE = Decimal("1")
QUANTITY_TOLERANCE = Decimal("0")


@dataclass(frozen=True)
class ReconciliationItem:
    code: str
    status: str
    left: dict[str, Any] | None = None
    right: dict[str, Any] | None = None
    delta: Decimal | None = None
    tolerance: Decimal | None = None
    deterministic: bool = True
    evidence: list[dict[str, Any]] = field(default_factory=list)
    possible_reasons_vi: list[str] = field(default_factory=list)
    fix_hint_vi: str | None = None
    readiness_issue_code: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "code": self.code,
            "status": self.status,
            "left": _serialize_component(self.left),
            "right": _serialize_component(self.right),
            "delta": _serialize_decimal(self.delta),
            "tolerance": _serialize_decimal(self.tolerance),
            "deterministic": self.deterministic,
            "evidence": self.evidence,
            "possibleReasonsVi": self.possible_reasons_vi,
            "fixHintVi": self.fix_hint_vi,
            "readinessIssueCode": self.readiness_issue_code,
        }
        return {key: value for key, value in payload.items() if value is not None}


@dataclass(frozen=True)
class ReconciliationReport:
    items: list[ReconciliationItem]

    @property
    def status(self) -> str:
        if any(item.status == "mismatch" for item in self.items):
            return "mismatch"
        if any(item.status == "insufficient_data" for item in self.items):
            return "insufficient_data"
        return "match"

    @property
    def ok(self) -> bool:
        return self.status == "match"

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "ok": self.ok, "items": [item.to_dict() for item in self.items]}


def reconcile_session(session_state: dict[str, Any]) -> ReconciliationReport:
    """Reconcile only values supplied by the session; missing evidence is never a match."""
    rows = _session_rows(session_state)
    raw_readiness = session_state.get("readiness")
    readiness = _mapping(raw_readiness)
    issues = list(readiness.get("issues") or [])
    has_readiness_issues = isinstance(raw_readiness, dict) and "issues" in raw_readiness
    groups = _invoice_groups(rows)

    return ReconciliationReport(
        items=[
            _row_count_item(readiness, rows),
            _detail_subtotal_item(groups, issues),
            _payment_total_item(groups, issues),
            _invoice_vat_item(groups, issues),
            _duplicate_item(issues, has_readiness_issues),
            _summary_item(
                code="customer_receivable_summary_when_supported",
                groups=groups,
                left_fields=("tong_phai_thu", "phai_thu", "cong_no_phai_thu"),
                right_fields=("tong_tien_thanh_toan",),
                left_label="Tổng phải thu khách hàng",
                right_label="Tổng thanh toán chứng từ",
            ),
            _summary_item(
                code="supplier_payable_summary_when_supported",
                groups=groups,
                left_fields=("tong_phai_tra", "phai_tra", "cong_no_phai_tra"),
                right_fields=("tong_tien_thanh_toan",),
                left_label="Tổng phải trả nhà cung cấp",
                right_label="Tổng thanh toán chứng từ",
            ),
            _summary_item(
                code="inventory_quantity_summary_when_supported",
                groups=groups,
                left_fields=("so_luong",),
                right_fields=("tong_so_luong", "so_luong_tong"),
                left_label="Tổng số lượng chi tiết",
                right_label="Tổng số lượng chứng từ",
                tolerance=QUANTITY_TOLERANCE,
            ),
        ]
    )


def _row_count_item(readiness: dict[str, Any], rows: list[dict[str, Any]]) -> ReconciliationItem:
    reconciliation = _mapping(readiness.get("reconciliation"))
    input_rows = _decimal(reconciliation.get("input_rows"))
    output_rows = _decimal(reconciliation.get("output_rows"))
    if input_rows is None or output_rows is None:
        return _insufficient("input_row_count_vs_output_row_count", "Chưa có đủ số dòng nguồn và dòng sau mapping.")
    return _comparison_item(
        code="input_row_count_vs_output_row_count",
        left_label="Số dòng nguồn",
        left_value=input_rows,
        right_label="Số dòng sau mapping",
        right_value=output_rows,
        tolerance=Decimal("0"),
        evidence=[
            {"source": "readiness.reconciliation", "field": "input_rows"},
            {"source": "readiness.reconciliation", "field": "output_rows"},
        ],
        reasons=["Có thể thiếu dòng khi lọc, mapping hoặc xuất dữ liệu."],
        fix_hint="Đối chiếu số dòng nguồn với preview sau mapping.",
    )


def _detail_subtotal_item(
    groups: dict[str, list[dict[str, Any]]], issues: list[dict[str, Any]]
) -> ReconciliationItem:
    left_value = _sum_group_fields(groups, ("thanh_tien",), unique=False)
    right_value = _sum_group_fields(groups, ("tong_tien_hang", "tong_tien_hang_hoa"), unique=True)
    return _financial_item(
        code="detail_amount_vs_invoice_subtotal",
        left_label="Tổng chi tiết",
        left_value=left_value,
        right_label="Tổng tiền hàng hóa đơn",
        right_value=right_value,
        issues=issues,
        readiness_codes=("line_amount_mismatch",),
        evidence_fields=("thanh_tien", "tong_tien_hang"),
        reasons=["Thiếu dòng chi tiết", "Chiết khấu chưa được tính", "Dòng tổng bị nhận nhầm là dữ liệu"],
        fix_hint="Đối chiếu các dòng chi tiết, chiết khấu và cột tổng tiền hàng.",
    )


def _payment_total_item(
    groups: dict[str, list[dict[str, Any]]], issues: list[dict[str, Any]]
) -> ReconciliationItem:
    subtotal = _sum_group_fields(groups, ("tong_tien_hang", "tong_tien_hang_hoa"), unique=True)
    vat = _sum_group_fields(groups, ("tong_tien_thue_gtgt", "tong_thue_gtgt"), unique=True)
    payment = _sum_group_fields(groups, ("tong_tien_thanh_toan",), unique=True)
    if subtotal is None or vat is None or payment is None:
        return _insufficient(
            "subtotal_plus_vat_vs_payment_total",
            "Cần tổng tiền hàng, tổng thuế GTGT và tổng thanh toán theo hóa đơn.",
        )
    return _comparison_item(
        code="subtotal_plus_vat_vs_payment_total",
        left_label="Tổng tiền hàng + thuế GTGT",
        left_value=subtotal + vat,
        right_label="Tổng thanh toán",
        right_value=payment,
        tolerance=MONEY_TOLERANCE,
        evidence=_financial_evidence("tong_tien_hang", "tong_tien_thue_gtgt", "tong_tien_thanh_toan"),
        reasons=["Chiết khấu, phí hoặc làm tròn chưa được phản ánh trong tổng thanh toán."],
        fix_hint="Kiểm tra tổng tiền hàng, thuế GTGT, chiết khấu và tổng thanh toán của từng hóa đơn.",
    )


def _invoice_vat_item(
    groups: dict[str, list[dict[str, Any]]], issues: list[dict[str, Any]]
) -> ReconciliationItem:
    left_value = _sum_group_fields(groups, ("tien_thue_gtgt",), unique=False)
    right_value = _sum_group_fields(groups, ("tong_tien_thue_gtgt", "tong_thue_gtgt"), unique=True)
    return _financial_item(
        code="line_vat_vs_invoice_vat",
        left_label="Tổng thuế GTGT dòng",
        left_value=left_value,
        right_label="Tổng thuế GTGT hóa đơn",
        right_value=right_value,
        issues=issues,
        readiness_codes=("vat_amount_mismatch",),
        evidence_fields=("tien_thue_gtgt", "tong_tien_thue_gtgt"),
        reasons=["Thuế suất, cơ sở tính thuế hoặc tiền thuế của một dòng chưa đúng."],
        fix_hint="Kiểm tra tiền thuế GTGT từng dòng và tổng thuế của hóa đơn.",
    )


def _duplicate_item(
    issues: list[dict[str, Any]], has_readiness_issues: bool
) -> ReconciliationItem:
    duplicate = _readiness_issue(issues, ("duplicate_document_key",))
    if duplicate is not None:
        return ReconciliationItem(
            code="duplicate_document_keys",
            status="mismatch",
            deterministic=True,
            evidence=[_issue_evidence(duplicate)],
            possible_reasons_vi=["Số hóa đơn/chứng từ trùng nhưng các thông tin liên quan khác nhau."],
            fix_hint_vi=str(duplicate.get("fix_hint") or "Kiểm tra và tách hoặc sửa chứng từ trùng."),
            readiness_issue_code="duplicate_document_key",
        )
    if not has_readiness_issues:
        return _insufficient("duplicate_document_keys", "Chưa có kết quả readiness để kiểm tra chứng từ trùng.")
    return ReconciliationItem(
        code="duplicate_document_keys",
        status="match",
        deterministic=True,
        evidence=[{"source": "readiness.issues", "issue_code": "duplicate_document_key"}],
        possible_reasons_vi=[],
        fix_hint_vi="Không có chứng từ trùng mâu thuẫn theo readiness hiện tại.",
    )


def _summary_item(
    *,
    code: str,
    groups: dict[str, list[dict[str, Any]]],
    left_fields: tuple[str, ...],
    right_fields: tuple[str, ...],
    left_label: str,
    right_label: str,
    tolerance: Decimal = MONEY_TOLERANCE,
) -> ReconciliationItem:
    left_value = _sum_group_fields(groups, left_fields, unique=False)
    right_value = _sum_group_fields(groups, right_fields, unique=True)
    if left_value is None or right_value is None:
        return _insufficient(code, "Module chỉ chạy khi file có cả số liệu chi tiết và tổng đối chiếu.")
    return _comparison_item(
        code=code,
        left_label=left_label,
        left_value=left_value,
        right_label=right_label,
        right_value=right_value,
        tolerance=tolerance,
        evidence=_financial_evidence(*left_fields, *right_fields),
        reasons=["Dữ liệu tổng hợp hoặc chi tiết có thể thiếu dòng hoặc dùng sai cột."],
        fix_hint="Kiểm tra nguồn số liệu chi tiết và cột tổng theo từng chứng từ.",
    )


def _financial_item(
    *,
    code: str,
    left_label: str,
    left_value: Decimal | None,
    right_label: str,
    right_value: Decimal | None,
    issues: list[dict[str, Any]],
    readiness_codes: tuple[str, ...],
    evidence_fields: tuple[str, ...],
    reasons: list[str],
    fix_hint: str,
) -> ReconciliationItem:
    if left_value is None or right_value is None:
        return _insufficient(code, "Chưa có đủ các thành phần số để đối chiếu.")
    item = _comparison_item(
        code=code,
        left_label=left_label,
        left_value=left_value,
        right_label=right_label,
        right_value=right_value,
        tolerance=MONEY_TOLERANCE,
        evidence=_financial_evidence(*evidence_fields),
        reasons=reasons,
        fix_hint=fix_hint,
    )
    issue = _readiness_issue(issues, readiness_codes)
    if issue is None:
        return item
    return ReconciliationItem(
        **{**item.__dict__, "status": "mismatch", "evidence": [*item.evidence, _issue_evidence(issue)], "readiness_issue_code": str(issue["code"])}
    )


def _comparison_item(
    *,
    code: str,
    left_label: str,
    left_value: Decimal,
    right_label: str,
    right_value: Decimal,
    tolerance: Decimal,
    evidence: list[dict[str, Any]],
    reasons: list[str],
    fix_hint: str,
) -> ReconciliationItem:
    delta = left_value - right_value
    return ReconciliationItem(
        code=code,
        status="match" if abs(delta) <= tolerance else "mismatch",
        left={"label": left_label, "value": left_value},
        right={"label": right_label, "value": right_value},
        delta=delta,
        tolerance=tolerance,
        evidence=evidence,
        possible_reasons_vi=reasons,
        fix_hint_vi=fix_hint,
    )


def _insufficient(code: str, fix_hint: str) -> ReconciliationItem:
    return ReconciliationItem(
        code=code,
        status="insufficient_data",
        deterministic=False,
        possible_reasons_vi=["Chưa đủ dữ liệu nguồn để tính đối chiếu một cách xác định."],
        fix_hint_vi=fix_hint,
    )


def _session_rows(session_state: dict[str, Any]) -> list[dict[str, Any]]:
    rows = session_state.get("rows")
    if rows is None:
        table = session_state.get("table")
        rows = getattr(table, "rows", None) if table is not None else None
    return [dict(row) for row in rows or [] if isinstance(row, dict)]


def _invoice_groups(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for index, row in enumerate(rows, start=1):
        normalized = {normalize_header(header): value for header, value in row.items()}
        invoice = _first_text(normalized, ("so_hoa_don", "so_chung_tu", "so_phieu_nhap"))
        if invoice:
            groups.setdefault(invoice, []).append(normalized)
        else:
            groups.setdefault(f"__row_{index}", []).append(normalized)
    return groups


def _sum_group_fields(
    groups: dict[str, list[dict[str, Any]]], fields: tuple[str, ...], *, unique: bool
) -> Decimal | None:
    if not groups:
        return None
    total: Decimal | None = None
    for rows in groups.values():
        values = [value for row in rows if (value := _row_decimal(row, fields)) is not None]
        if not values:
            return None
        if unique:
            if any(value != values[0] for value in values[1:]):
                return None
            values = values[:1]
        for value in values:
            total = value if total is None else total + value
    return total


def _row_decimal(row: dict[str, Any], fields: tuple[str, ...]) -> Decimal | None:
    for field in fields:
        value = _decimal(row.get(field))
        if value is not None:
            return value
    return None


def _decimal(value: Any) -> Decimal | None:
    return parse_decimal(value)


def _first_text(row: dict[str, Any], fields: tuple[str, ...]) -> str | None:
    for field in fields:
        value = row.get(field)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _readiness_issue(issues: list[dict[str, Any]], codes: tuple[str, ...]) -> dict[str, Any] | None:
    return next((issue for issue in issues if str(issue.get("code") or "") in codes), None)


def _issue_evidence(issue: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": "readiness.issues",
        "issue_code": issue.get("code"),
        "row": issue.get("row"),
        "field": issue.get("field"),
    }


def _financial_evidence(*fields: str) -> list[dict[str, Any]]:
    return [{"source": "rows", "field": field} for field in fields] or [{"source": "rows"}]


def _serialize_component(component: dict[str, Any] | None) -> dict[str, Any] | None:
    if component is None:
        return None
    return {**component, "value": _serialize_decimal(component.get("value"))}


def _serialize_decimal(value: Decimal | None) -> str | None:
    return str(value) if value is not None else None
