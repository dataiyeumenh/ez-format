from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from app.excel_io import InputTable
from app.misa_mapping import (
    apply_mapping,
    sanitize_defaults_for_template,
    sanitize_mapping_for_template,
)
from app.misa_templates import get_misa_template
from app.models import (
    MisaReadinessIssue,
    MisaReadinessReport,
    MisaReadinessSummary,
)
from app.normalization import is_blank, normalize_header
from app.parsing import parse_date, parse_number


MISA_IMPORT_SOURCE_URL = "https://helpact.misa.vn/kb/html_10050000/"
MISA_IMPORT_ERROR_SOURCE_URL = (
    "https://helpact.misa.vn/kb/lam-the-nao-khi-nhap-khau-danh-muc-so-du-chung-tu-tu-excel-vao-phan-mem-bao-loi/"
)
DISCLAIMER = (
    "EzFormat kiểm tra lỗi kỹ thuật/import có thể xác định; kế toán vẫn cần rà soát "
    "nghiệp vụ và quy định áp dụng."
)
MONEY_TOLERANCE = Decimal("1")

DATE_HEADER_HINTS = ("ngay", "han_su_dung")
NUMBER_HEADER_HINTS = (
    "so_luong",
    "don_gia",
    "thanh_tien",
    "tien_chiet_khau",
    "tien_thue",
    "ty_le",
    "percent_thue",
    "thue_suat",
    "ty_gia",
)
DOCUMENT_KEY_HEADERS = (
    "so_chung_tu",
    "so_phieu_nhap",
    "so_hoa_don",
)
STRONG_INVOICE_NUMBER_HEADERS = ("so_hoa_don",)
STRONG_INVOICE_QUALIFIER_HEADERS = ("ky_hieu_hd", "ma_so_thue", "ma_nha_cung_cap")
DOCUMENT_FINGERPRINT_HEADERS = (
    "ngay_hach_toan",
    "ngay_chung_tu",
    "ngay_hoa_don",
    "ma_khach_hang",
    "ten_khach_hang",
    "ma_nha_cung_cap",
    "ten_nha_cung_cap",
    "thanh_tien",
    "tien_thue_gtgt",
)


def build_readiness_report(
    table: InputTable,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    edited_rows: list[dict[str, Any]] | None = None,
) -> MisaReadinessReport:
    template = get_misa_template(target_template_id)
    clean_defaults = sanitize_defaults_for_template(target_template_id, defaults, template.headers)
    clean_mapping = sanitize_mapping_for_template(target_template_id, mapping)
    formulas = formulas or {}
    rows = (
        edited_rows
        if edited_rows is not None
        else apply_mapping(table, template.headers, clean_mapping, clean_defaults, formulas)
    )

    issues: list[MisaReadinessIssue] = []
    required_headers = _required_headers(template.headers)
    mapped_targets = _mapped_targets(clean_mapping)

    if edited_rows is None:
        _check_required_mapping(
            issues=issues,
            required_headers=required_headers,
            mapped_targets=mapped_targets,
            defaults=clean_defaults,
            formulas=formulas,
        )
        _check_source_parseable_values(issues, table, clean_mapping)
    _check_required_values(issues, rows, required_headers)
    _check_parseable_values(issues, rows)
    _check_amount_math(issues, rows)
    _check_vat_math(issues, rows)
    _check_duplicate_documents(issues, rows)
    _add_review_warnings(issues, rows, table, clean_mapping)

    summary = MisaReadinessSummary(
        blocker=sum(1 for issue in issues if issue.severity == "blocker"),
        warning=sum(1 for issue in issues if issue.severity == "warning"),
        info=sum(1 for issue in issues if issue.severity == "info"),
    )
    status = _status(summary)
    return MisaReadinessReport(
        ok=status == "ready",
        status=status,
        score=_score(summary),
        summary=summary,
        issues=issues,
        reconciliation=_reconciliation(table, rows, clean_mapping),
        disclaimer=DISCLAIMER,
    )


def _required_headers(headers: list[str]) -> list[str]:
    return [header for header in headers if header and "(*)" in header]


def _mapped_targets(mapping: dict[str, Any]) -> set[str]:
    targets: set[str] = set()
    for target_spec in mapping.values():
        if isinstance(target_spec, list):
            targets.update(str(target) for target in target_spec)
        elif target_spec:
            targets.add(str(target_spec))
    return targets


def _check_required_mapping(
    *,
    issues: list[MisaReadinessIssue],
    required_headers: list[str],
    mapped_targets: set[str],
    defaults: dict[str, Any],
    formulas: dict[str, str],
) -> None:
    for header in required_headers:
        default_value = defaults.get(header)
        has_default = not is_blank(default_value)
        has_formula = not is_blank(formulas.get(header))
        if header not in mapped_targets and not has_default and not has_formula:
            issues.append(
                _issue(
                    severity="blocker",
                    category="template",
                    code="required_mapping_missing",
                    field=header,
                    message=f"Cột bắt buộc {header} chưa có mapping, giá trị mặc định hoặc công thức.",
                    expected="Có mapping/default/formula",
                    actual="",
                    fix_hint="Ghép cột từ file Excel hoặc nhập giá trị mặc định/công thức cho cột bắt buộc.",
                    source_url=MISA_IMPORT_SOURCE_URL,
                )
            )


def _check_required_values(
    issues: list[MisaReadinessIssue],
    rows: list[dict[str, Any]],
    required_headers: list[str],
) -> None:
    for row_number, row in enumerate(rows, start=1):
        if not _active_row(row):
            continue
        for header in required_headers:
            if is_blank(row.get(header)):
                issues.append(
                    _issue(
                        severity="blocker",
                        category="template",
                        code="required_value_blank",
                        row=row_number,
                        field=header,
                        invoice=_invoice(row),
                        message=f"Cột bắt buộc {header} đang trống.",
                        expected="Có giá trị",
                        actual="" if row.get(header) is None else row.get(header),
                        fix_hint="Kiểm tra mapping hoặc bổ sung giá trị trước khi tải file MISA.",
                        source_url=MISA_IMPORT_SOURCE_URL,
                    )
                )


def _check_parseable_values(
    issues: list[MisaReadinessIssue],
    rows: list[dict[str, Any]],
) -> None:
    for row_number, row in enumerate(rows, start=1):
        for header, value in row.items():
            if is_blank(value):
                continue
            normalized = normalize_header(header)
            if _is_date_header(normalized) and parse_date(value) is None:
                issues.append(
                    _issue(
                        severity="blocker",
                        category="format",
                        code="date_unparseable",
                        row=row_number,
                        field=header,
                        invoice=_invoice(row),
                        message=f"Không đọc được giá trị ngày ở cột {header}.",
                        expected="Ngày hợp lệ",
                        actual=value,
                        fix_hint="Dùng định dạng ngày rõ ràng như dd/MM/yyyy hoặc kiểm tra lại dữ liệu gốc.",
                        source_url=MISA_IMPORT_ERROR_SOURCE_URL,
                    )
                )
            if _is_number_header(normalized) and parse_number(value) is None:
                issues.append(
                    _issue(
                        severity="blocker",
                        category="format",
                        code="number_unparseable",
                        row=row_number,
                        field=header,
                        invoice=_invoice(row),
                        message=f"Không đọc được giá trị số ở cột {header}.",
                        expected="Số hợp lệ",
                        actual=value,
                        fix_hint="Kiểm tra ký tự tiền tệ, dấu phân tách hoặc giá trị text trong cột số.",
                        source_url=MISA_IMPORT_ERROR_SOURCE_URL,
                    )
                )


def _check_source_parseable_values(
    issues: list[MisaReadinessIssue],
    table: InputTable,
    mapping: dict[str, Any],
) -> None:
    for row_number, source_row in enumerate(table.rows, start=1):
        for raw_header, target_spec in mapping.items():
            if raw_header not in source_row:
                continue
            value = source_row.get(raw_header)
            if is_blank(value):
                continue
            targets = target_spec if isinstance(target_spec, list) else [target_spec]
            for target in targets:
                normalized = normalize_header(target)
                if _is_date_header(normalized) and parse_date(value) is None:
                    issues.append(
                        _issue(
                            severity="blocker",
                            category="format",
                            code="date_unparseable",
                            row=row_number,
                            field=str(target),
                            message=f"Không đọc được giá trị ngày từ cột nguồn {raw_header}.",
                            expected="Ngày hợp lệ",
                            actual=value,
                            fix_hint="Sửa dữ liệu ngày ở file gốc hoặc chọn đúng cột ngày.",
                            source_url=MISA_IMPORT_ERROR_SOURCE_URL,
                        )
                    )
                if _is_number_header(normalized) and parse_number(value) is None:
                    issues.append(
                        _issue(
                            severity="blocker",
                            category="format",
                            code="number_unparseable",
                            row=row_number,
                            field=str(target),
                            message=f"Không đọc được giá trị số từ cột nguồn {raw_header}.",
                            expected="Số hợp lệ",
                            actual=value,
                            fix_hint="Sửa dữ liệu số ở file gốc hoặc chọn đúng cột số.",
                            source_url=MISA_IMPORT_ERROR_SOURCE_URL,
                        )
                    )


def _check_amount_math(issues: list[MisaReadinessIssue], rows: list[dict[str, Any]]) -> None:
    for row_number, row in enumerate(rows, start=1):
        quantity = _decimal(_field(row, "so_luong"))
        unit_price = _decimal(_field(row, "don_gia"))
        amount = _decimal(_field(row, "thanh_tien"))
        if quantity is None or unit_price is None or amount is None:
            continue
        if quantity == 0 or unit_price == 0:
            continue

        gross = _money(quantity * unit_price)
        accepted = {gross}
        discount = _decimal(_field(row, "tien_chiet_khau"))
        if discount is not None:
            accepted.add(_money(gross - discount))
        actual = _money(amount)
        if all(abs(actual - expected) > MONEY_TOLERANCE for expected in accepted):
            closest = min(accepted, key=lambda expected: abs(actual - expected))
            issues.append(
                _issue(
                    severity="blocker",
                    category="calculation",
                    code="line_amount_mismatch",
                    row=row_number,
                    field=_real_field_name(row, "thanh_tien"),
                    invoice=_invoice(row),
                    message="Thành tiền không khớp với Số lượng × Đơn giá.",
                    expected=str(closest),
                    actual=str(actual),
                    delta=str(actual - closest),
                    fix_hint="Kiểm tra lại số lượng, đơn giá, chiết khấu hoặc thành tiền.",
                    source_url=MISA_IMPORT_ERROR_SOURCE_URL,
                )
            )


def _check_vat_math(issues: list[MisaReadinessIssue], rows: list[dict[str, Any]]) -> None:
    for row_number, row in enumerate(rows, start=1):
        amount = _decimal(_field(row, "thanh_tien"))
        vat_amount = _decimal(_field(row, "tien_thue_gtgt"))
        vat_rate = _vat_rate(_field(row, "percent_thue_gtgt") or _field(row, "thue_suat"))
        if amount is None or vat_amount is None or vat_rate is None:
            continue

        bases = {amount}
        discount = _decimal(_field(row, "tien_chiet_khau"))
        if discount is not None:
            bases.add(amount - discount)
        accepted = {_money(base * vat_rate) for base in bases}
        actual = _money(vat_amount)
        if all(abs(actual - expected) > MONEY_TOLERANCE for expected in accepted):
            closest = min(accepted, key=lambda expected: abs(actual - expected))
            issues.append(
                _issue(
                    severity="blocker",
                    category="tax",
                    code="vat_amount_mismatch",
                    row=row_number,
                    field=_real_field_name(row, "tien_thue_gtgt"),
                    invoice=_invoice(row),
                    message="Tiền thuế GTGT không khớp với thành tiền tính thuế × thuế suất.",
                    expected=str(closest),
                    actual=str(actual),
                    delta=str(actual - closest),
                    fix_hint="Kiểm tra thành tiền, chiết khấu, thuế suất hoặc tiền thuế GTGT.",
                    source_url=MISA_IMPORT_ERROR_SOURCE_URL,
                )
            )


def _check_duplicate_documents(
    issues: list[MisaReadinessIssue],
    rows: list[dict[str, Any]],
) -> None:
    seen: dict[str, tuple[int, tuple[Any, ...]]] = {}
    for row_number, row in enumerate(rows, start=1):
        key = _document_key(row)
        if not key:
            continue
        fingerprint = _document_fingerprint(row)
        previous = seen.get(key)
        if previous is None:
            seen[key] = (row_number, fingerprint)
            continue
        previous_row, previous_fingerprint = previous
        if fingerprint != previous_fingerprint:
            issues.append(
                _issue(
                    severity="blocker",
                    category="document",
                    code="duplicate_document_key",
                    row=row_number,
                    field="Số chứng từ/Số hóa đơn",
                    invoice=key,
                    message=f"Chứng từ {key} bị trùng nhưng thông tin dòng không thống nhất.",
                    expected=f"Khớp với dòng {previous_row}",
                    actual=f"Dòng {row_number} khác thông tin",
                    fix_hint="Kiểm tra trùng số chứng từ/hóa đơn hoặc tách/sửa chứng từ trước khi import.",
                    source_url=MISA_IMPORT_ERROR_SOURCE_URL,
                )
            )


def _add_review_warnings(
    issues: list[MisaReadinessIssue],
    rows: list[dict[str, Any]],
    table: InputTable,
    mapping: dict[str, Any],
) -> None:
    used_source_headers = set(mapping)
    unused_headers = [header for header in table.headers if header and header not in used_source_headers]
    if unused_headers:
        issues.append(
            _issue(
                severity="warning",
                category="mapping",
                code="unused_source_columns",
                message="Một số cột nguồn chưa được dùng trong mapping.",
                expected="Kế toán xác nhận có thể bỏ qua",
                actual=", ".join(unused_headers[:8]),
                fix_hint="Rà soát cột nguồn chưa dùng để tránh bỏ sót thông tin cần import.",
                source_url=MISA_IMPORT_SOURCE_URL,
            )
        )

    for row_number, row in enumerate(rows, start=1):
        item_code = _field(row, "ma_hang")
        item_name = _field(row, "ten_hang")
        if not is_blank(item_code) and not is_blank(item_name) and str(item_code).strip() == str(item_name).strip():
            issues.append(
                _issue(
                    severity="warning",
                    category="master_data",
                    code="master_data_review_required",
                    row=row_number,
                    field=_real_field_name(row, "ma_hang"),
                    invoice=_invoice(row),
                    message="Mã hàng đang giống tên hàng; cần kiểm tra danh mục MISA.",
                    expected="Mã hàng tồn tại trong danh mục MISA",
                    actual=item_code,
                    fix_hint="Nếu doanh nghiệp dùng mã hàng riêng, hãy map đúng mã hoặc bổ sung danh mục trước khi import.",
                    source_url=MISA_IMPORT_SOURCE_URL,
                )
            )
            break


def _reconciliation(
    table: InputTable,
    rows: list[dict[str, Any]],
    mapping: dict[str, Any],
) -> dict[str, Any]:
    invoice_keys = {_document_key(row) for row in rows if _document_key(row)}
    sum_amount = _sum_decimal(rows, "thanh_tien")
    sum_vat = _sum_decimal(rows, "tien_thue_gtgt")
    sum_total = _sum_decimal(rows, "tong_tien_thanh_toan") or (
        (sum_amount or Decimal("0")) + (sum_vat or Decimal("0"))
    )
    return {
        "input_rows": len(table.rows),
        "output_rows": len(rows),
        "invoice_count": len(invoice_keys) if invoice_keys else None,
        "sum_amount": str(sum_amount) if sum_amount is not None else None,
        "sum_vat": str(sum_vat) if sum_vat is not None else None,
        "sum_total": str(sum_total) if sum_total is not None else None,
        "unmapped_source_columns": [
            header for header in table.headers if header and header not in set(mapping)
        ],
    }


def _sum_decimal(rows: list[dict[str, Any]], normalized_field: str) -> Decimal | None:
    total: Decimal | None = None
    for row in rows:
        value = _decimal(_field(row, normalized_field))
        if value is None:
            continue
        total = value if total is None else total + value
    return _money(total) if total is not None else None


def _issue(**kwargs: Any) -> MisaReadinessIssue:
    return MisaReadinessIssue(**kwargs)


def _active_row(row: dict[str, Any]) -> bool:
    return any(not is_blank(value) for value in row.values())


def _is_date_header(normalized_header: str) -> bool:
    return any(hint in normalized_header for hint in DATE_HEADER_HINTS)


def _is_number_header(normalized_header: str) -> bool:
    return any(hint in normalized_header for hint in NUMBER_HEADER_HINTS)


def _field(row: dict[str, Any], normalized_name: str) -> Any:
    for header, value in row.items():
        if normalize_header(header) == normalized_name:
            return value
    return None


def _real_field_name(row: dict[str, Any], normalized_name: str) -> str | None:
    for header in row:
        if normalize_header(header) == normalized_name:
            return header
    return None


def _decimal(value: Any) -> Decimal | None:
    number = parse_number(value)
    if number is None:
        return None
    try:
        return Decimal(str(number))
    except (InvalidOperation, ValueError):
        return None


def _money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def _vat_rate(value: Any) -> Decimal | None:
    if is_blank(value):
        return None
    text = str(value).strip().lower()
    if text in {"kct", "không chịu thuế", "khong chiu thue"}:
        return Decimal("0")
    parsed = _decimal(value)
    if parsed is None:
        return None
    return parsed / Decimal("100") if parsed > 1 else parsed


def _invoice(row: dict[str, Any]) -> str | None:
    for normalized in DOCUMENT_KEY_HEADERS:
        value = _field(row, normalized)
        if not is_blank(value):
            return str(value).strip()
    return None


def _document_key(row: dict[str, Any]) -> str | None:
    invoice_number = next(
        (
            str(_field(row, normalized)).strip()
            for normalized in STRONG_INVOICE_NUMBER_HEADERS
            if not is_blank(_field(row, normalized))
        ),
        "",
    )
    if not invoice_number:
        return None
    qualifiers = [
        str(_field(row, normalized)).strip()
        for normalized in STRONG_INVOICE_QUALIFIER_HEADERS
        if not is_blank(_field(row, normalized))
    ]
    if not qualifiers:
        return None
    return "|".join([*qualifiers, invoice_number])


def _document_fingerprint(row: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(_normalize_fingerprint_value(_field(row, header)) for header in DOCUMENT_FINGERPRINT_HEADERS)


def _normalize_fingerprint_value(value: Any) -> Any:
    if is_blank(value):
        return ""
    parsed_date = parse_date(value)
    if parsed_date is not None:
        return str(parsed_date)
    parsed_number = _decimal(value)
    if parsed_number is not None:
        return str(_money(parsed_number))
    return str(value).strip()


def _status(summary: MisaReadinessSummary) -> str:
    if summary.blocker > 0:
        return "blocked"
    if summary.warning > 0:
        return "needs_review"
    return "ready"


def _score(summary: MisaReadinessSummary) -> int:
    score = 100 - summary.blocker * 25 - summary.warning * 5 - min(summary.info, 10)
    return max(0, min(100, score))
