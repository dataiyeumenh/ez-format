from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from app.conversion_types import ConversionTypeDefinition
from app.field_detection import semantic_value
from app.models import ErrorCheckIssue, JsonDict
from app.normalization import is_blank, normalize_header
from app.parsing import parse_date, parse_number


AUTO_PROFILE = "auto_by_document_date"
TT99_PROFILE = "tt99_2026"
TT200_PROFILE = "tt200_legacy"
TT133_PROFILE = "tt133_sme"
SUPPORTED_PROFILES = {AUTO_PROFILE, TT99_PROFILE, TT200_PROFILE, TT133_PROFILE}
TT99_EFFECTIVE_DATE = date(2026, 1, 1)

TT99_SOURCE_URL = "https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529.htm"
VAT_LAW_SOURCE_URL = "https://vanban.chinhphu.vn/?docid=212476&pageid=27160"
MISA_SALES_SOURCE_URL = "https://amis.misa.vn/20119/hach-toan-dn-thuong-mai/"
MISA_PURCHASE_SOURCE_URL = "https://helpmimosaonline.misa.vn/kb/mua-hang-chua-thanh-toan/"


@dataclass(frozen=True)
class AccountingRule:
    rule_id: str
    applies_to: tuple[str, ...]
    effective_from: str
    severity: str
    expected_accounts: tuple[str, ...]
    source_url: str
    source_note: str


RULE_REGISTRY: tuple[AccountingRule, ...] = (
    AccountingRule(
        rule_id="sales_debit_account",
        applies_to=("sales_goods", "sales_service"),
        effective_from="legacy",
        severity="error",
        expected_accounts=("111", "112", "131"),
        source_url=MISA_SALES_SOURCE_URL,
        source_note="Bán hàng ghi Nợ tiền/công nợ khách hàng.",
    ),
    AccountingRule(
        rule_id="sales_revenue_account",
        applies_to=("sales_goods", "sales_service"),
        effective_from="legacy",
        severity="error",
        expected_accounts=("511",),
        source_url=MISA_SALES_SOURCE_URL,
        source_note="Bán hàng ghi Có doanh thu.",
    ),
    AccountingRule(
        rule_id="output_vat_account",
        applies_to=("sales_goods", "sales_service"),
        effective_from="2025-07-01",
        severity="error",
        expected_accounts=("3331",),
        source_url=VAT_LAW_SOURCE_URL,
        source_note="VAT đầu ra phải tách tài khoản thuế phải nộp.",
    ),
    AccountingRule(
        rule_id="sales_cogs_account",
        applies_to=("sales_goods",),
        effective_from="legacy",
        severity="error",
        expected_accounts=("632",),
        source_url=MISA_SALES_SOURCE_URL,
        source_note="Bán hàng hóa xuất kho ghi nhận giá vốn.",
    ),
    AccountingRule(
        rule_id="sales_inventory_account",
        applies_to=("sales_goods",),
        effective_from="legacy",
        severity="error",
        expected_accounts=("155", "156"),
        source_url=MISA_SALES_SOURCE_URL,
        source_note="Bán hàng hóa xuất kho ghi giảm kho.",
    ),
    AccountingRule(
        rule_id="purchase_goods_cost_account",
        applies_to=("purchase_goods",),
        effective_from="legacy",
        severity="error",
        expected_accounts=("152", "153", "154", "156"),
        source_url=MISA_PURCHASE_SOURCE_URL,
        source_note="Mua hàng ghi Nợ tài sản/chi phí phù hợp.",
    ),
    AccountingRule(
        rule_id="purchase_service_cost_account",
        applies_to=("purchase_service",),
        effective_from="legacy",
        severity="error",
        expected_accounts=("154", "242", "627", "641", "642"),
        source_url=MISA_PURCHASE_SOURCE_URL,
        source_note="Mua dịch vụ ghi Nợ chi phí/phân bổ/giá thành phù hợp.",
    ),
    AccountingRule(
        rule_id="purchase_payable_account",
        applies_to=("purchase_goods", "purchase_service"),
        effective_from="legacy",
        severity="error",
        expected_accounts=("111", "112", "331"),
        source_url=MISA_PURCHASE_SOURCE_URL,
        source_note="Mua hàng ghi Có tiền hoặc phải trả người bán.",
    ),
    AccountingRule(
        rule_id="input_vat_account",
        applies_to=("purchase_goods", "purchase_service"),
        effective_from="2025-07-01",
        severity="error",
        expected_accounts=("133", "1331"),
        source_url=VAT_LAW_SOURCE_URL,
        source_note="VAT đầu vào dùng tài khoản thuế GTGT được khấu trừ.",
    ),
    AccountingRule(
        rule_id="tt133_discount_account",
        applies_to=("sales_goods", "sales_service"),
        effective_from="legacy",
        severity="warning",
        expected_accounts=("not:521",),
        source_url=MISA_SALES_SOURCE_URL,
        source_note="TT133 không dùng TK 521 cho giảm trừ doanh thu.",
    ),
    AccountingRule(
        rule_id="tt99_profile_effective_date",
        applies_to=("all",),
        effective_from="2026-01-01",
        severity="info",
        expected_accounts=("profile:tt99_2026",),
        source_url=TT99_SOURCE_URL,
        source_note="TT99/2025/TT-BTC áp dụng từ 01/01/2026.",
    ),
)


def validate_rule_registry(registry: tuple[AccountingRule, ...]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for rule in registry:
        if not rule.rule_id:
            errors.append("Rule is missing rule_id.")
        if rule.rule_id in seen:
            errors.append(f"Duplicate rule_id: {rule.rule_id}.")
        seen.add(rule.rule_id)
        if not rule.applies_to:
            errors.append(f"{rule.rule_id} missing applies_to.")
        if not rule.effective_from:
            errors.append(f"{rule.rule_id} missing effective_from.")
        if not rule.expected_accounts:
            errors.append(f"{rule.rule_id} missing expected_accounts.")
        if not rule.source_url or not rule.source_url.startswith("https://"):
            errors.append(f"{rule.rule_id} missing source_url.")
        if not rule.source_note:
            errors.append(f"{rule.rule_id} missing source_note.")
        if rule.severity not in {"error", "warning", "info"}:
            errors.append(f"{rule.rule_id} has invalid severity {rule.severity}.")
    return errors


def _expected_accounts(rule_id: str) -> tuple[str, ...]:
    for rule in RULE_REGISTRY:
        if rule.rule_id == rule_id:
            return rule.expected_accounts
    raise KeyError(f"Missing accounting rule {rule_id}.")


SALES_DEBIT_ACCOUNTS = _expected_accounts("sales_debit_account")
SALES_REVENUE_ACCOUNTS = _expected_accounts("sales_revenue_account")
OUTPUT_VAT_ACCOUNTS = _expected_accounts("output_vat_account")
INVENTORY_ACCOUNTS = _expected_accounts("sales_inventory_account")
COGS_ACCOUNTS = _expected_accounts("sales_cogs_account")

PURCHASE_ASSET_OR_COST_ACCOUNTS = _expected_accounts("purchase_goods_cost_account")
PURCHASE_SERVICE_COST_ACCOUNTS = _expected_accounts("purchase_service_cost_account")
PURCHASE_PAYABLE_OR_CASH_ACCOUNTS = _expected_accounts("purchase_payable_account")
INPUT_VAT_ACCOUNTS = _expected_accounts("input_vat_account")


def resolve_accounting_profile(
    rows: list[dict[str, Any]],
    detected_columns: dict[str, str],
    options: JsonDict | None = None,
) -> str:
    requested = str((options or {}).get("accounting_profile", "")).strip().lower()
    if requested and requested != AUTO_PROFILE:
        return requested if requested in SUPPORTED_PROFILES else AUTO_PROFILE

    newest_date: date | None = None
    for row in rows:
        parsed = parse_date(semantic_value(row, detected_columns, "date"))
        if isinstance(parsed, datetime):
            current = parsed.date()
        elif isinstance(parsed, date):
            current = parsed
        else:
            continue
        if newest_date is None or current > newest_date:
            newest_date = current

    if newest_date is not None and newest_date >= TT99_EFFECTIVE_DATE:
        return TT99_PROFILE
    return TT200_PROFILE


def check_accounting_rules(
    rows: list[dict[str, Any]],
    detected_columns: dict[str, str],
    definition: ConversionTypeDefinition,
    options: JsonDict | None = None,
) -> list[ErrorCheckIssue]:
    options = options or {}
    profile = resolve_accounting_profile(rows, detected_columns, options)
    defaults = _merged_defaults(definition, options)
    issues: list[ErrorCheckIssue] = []

    for row_number, row in enumerate(rows, start=2):
        invoice = _document_number(row, detected_columns, definition)
        if definition.kind.startswith("sales"):
            _check_sales_row(row, row_number, invoice, detected_columns, definition, defaults, profile, issues)
        else:
            _check_purchase_row(row, row_number, invoice, detected_columns, definition, defaults, issues)

    return issues


def _check_sales_row(
    row: dict[str, Any],
    row_number: int,
    invoice: str | None,
    detected_columns: dict[str, str],
    definition: ConversionTypeDefinition,
    defaults: dict[str, Any],
    profile: str,
    issues: list[ErrorCheckIssue],
) -> None:
    debit = _account_value(row, detected_columns, "debit_account", defaults, "TK Tiền/Chi phí/Nợ (*)")
    revenue = _account_value(row, detected_columns, "revenue_account", defaults, "TK Doanh thu/Có (*)")
    vat_account = _account_value(row, detected_columns, "vat_account", defaults, "TK thuế GTGT")
    discount_account = _account_value(row, detected_columns, "discount_account", defaults, "TK chiết khấu")
    payment_method = _text(semantic_value(row, detected_columns, "payment_method"))

    _require_account_prefix(
        issues,
        row_number,
        invoice,
        "debit_account",
        "accounting_wrong_sales_debit_account",
        debit,
        SALES_DEBIT_ACCOUNTS,
        "Bán hàng phải ghi Nợ vào nhóm tiền/công nợ khách hàng 111/112/131.",
    )
    _require_account_prefix(
        issues,
        row_number,
        invoice,
        "revenue_account",
        "accounting_wrong_sales_revenue_account",
        revenue,
        SALES_REVENUE_ACCOUNTS,
        "Bán hàng phải ghi Có doanh thu nhóm 511.",
    )

    if _has_vat(row, detected_columns):
        _require_account_prefix(
            issues,
            row_number,
            invoice,
            "vat_account",
            "accounting_wrong_output_vat_account",
            vat_account,
            OUTPUT_VAT_ACCOUNTS,
            "VAT đầu ra của bán hàng phải dùng tài khoản 3331/33311.",
            missing_code="accounting_missing_output_vat_account",
        )

    if definition.kind.endswith("goods"):
        cogs = _account_value(row, detected_columns, "cogs_account", defaults, "TK giá vốn")
        inventory = _account_value(row, detected_columns, "inventory_account", defaults, "TK Kho")
        _require_account_prefix(
            issues,
            row_number,
            invoice,
            "cogs_account",
            "accounting_wrong_cogs_account",
            cogs,
            COGS_ACCOUNTS,
            "Bán hàng hóa có xuất kho phải dùng TK giá vốn nhóm 632.",
        )
        _require_account_prefix(
            issues,
            row_number,
            invoice,
            "inventory_account",
            "accounting_wrong_sales_inventory_account",
            inventory,
            INVENTORY_ACCOUNTS,
            "Bán hàng hóa có xuất kho phải ghi Có kho nhóm 155/156.",
        )
    else:
        service_inventory = _account_value(row, detected_columns, "inventory_account", defaults, "")
        if not (
            service_inventory.source
            and not service_inventory.source.startswith("defaults.")
            and _account_startswith(service_inventory.value, INVENTORY_ACCOUNTS)
        ):
            service_inventory = _AccountValue(None, None)
        if service_inventory.value:
            issues.append(
                _issue(
                    row_number,
                    invoice,
                    "warning",
                    "accounting",
                    "accounting_service_uses_inventory_account",
                    "inventory_account",
                    "Bán dịch vụ thường không cần tài khoản kho như hàng hóa; hãy kiểm tra lại nếu đây không phải dịch vụ kèm xuất kho.",
                    actual=service_inventory.value,
                    source=service_inventory.source,
                )
            )

    _check_payment_method(issues, row_number, invoice, "debit_account", debit, payment_method, sale=True)

    if (
        profile == TT133_PROFILE
        and _has_discount(row, detected_columns)
        and _account_startswith(discount_account.value, ("521",))
    ):
        issues.append(
            _issue(
                row_number,
                invoice,
                "warning",
                "accounting",
                "accounting_tt133_uses_521_discount_account",
                "discount_account",
                "TT133 không dùng TK 521 cho giảm trừ doanh thu; hãy kiểm tra profile kế toán hoặc tài khoản chiết khấu.",
                expected="Không dùng 521 theo TT133",
                actual=discount_account.value,
            )
        )


def _check_purchase_row(
    row: dict[str, Any],
    row_number: int,
    invoice: str | None,
    detected_columns: dict[str, str],
    definition: ConversionTypeDefinition,
    defaults: dict[str, Any],
    issues: list[ErrorCheckIssue],
) -> None:
    inventory_or_cost = _account_value(
        row,
        detected_columns,
        "inventory_account",
        defaults,
        "TK kho/TK chi phí (*)",
    )
    payable = _account_value(row, detected_columns, "payable_account", defaults, "TK công nợ/TK tiền (*)")
    input_vat = _account_value(row, detected_columns, "input_vat_account", defaults, "TK thuế GTGT")
    if not input_vat.value:
        input_vat = _account_value(row, detected_columns, "vat_account", defaults, "TK thuế GTGT")
    payment_method = _text(semantic_value(row, detected_columns, "payment_method"))

    allowed_cost_accounts = (
        PURCHASE_SERVICE_COST_ACCOUNTS
        if definition.kind.endswith("service")
        else PURCHASE_ASSET_OR_COST_ACCOUNTS
    )
    _require_account_prefix(
        issues,
        row_number,
        invoice,
        "inventory_account",
        "accounting_wrong_purchase_cost_account",
        inventory_or_cost,
        allowed_cost_accounts,
        "Mua hàng/dịch vụ phải ghi Nợ vào nhóm tài sản/chi phí phù hợp.",
    )
    _require_account_prefix(
        issues,
        row_number,
        invoice,
        "payable_account",
        "accounting_wrong_purchase_payable_account",
        payable,
        PURCHASE_PAYABLE_OR_CASH_ACCOUNTS,
        "Mua hàng/dịch vụ phải ghi Có nhóm tiền hoặc phải trả người bán 111/112/331.",
    )

    if _has_vat(row, detected_columns):
        _require_account_prefix(
            issues,
            row_number,
            invoice,
            "input_vat_account",
            "accounting_wrong_input_vat_account",
            input_vat,
            INPUT_VAT_ACCOUNTS,
            "VAT đầu vào của mua hàng phải dùng tài khoản 133/1331.",
            missing_code="accounting_missing_input_vat_account",
        )

    _check_payment_method(issues, row_number, invoice, "payable_account", payable, payment_method, sale=False)

    revenue = _account_value(row, detected_columns, "revenue_account", defaults, "TK Doanh thu/Có (*)")
    if _account_startswith(revenue.value, SALES_REVENUE_ACCOUNTS):
        issues.append(
            _issue(
                row_number,
                invoice,
                "error",
                "accounting",
                "accounting_purchase_uses_revenue_account",
                "revenue_account",
                "Chứng từ mua hàng không nên dùng tài khoản doanh thu nhóm 511.",
                expected="Không dùng 511 cho mua hàng",
                actual=revenue.value,
            )
        )


def _require_account_prefix(
    issues: list[ErrorCheckIssue],
    row_number: int,
    invoice: str | None,
    field: str,
    code: str,
    actual: "_AccountValue",
    allowed_prefixes: tuple[str, ...],
    message: str,
    *,
    missing_code: str | None = None,
) -> None:
    if not actual.value:
        if missing_code:
            issues.append(
                _issue(
                    row_number,
                    invoice,
                    "warning",
                    "accounting",
                    missing_code,
                    field,
                    message,
                    expected="/".join(allowed_prefixes),
                    actual=None,
                    source=actual.source,
                )
            )
        return

    if not _account_startswith(actual.value, allowed_prefixes):
        issues.append(
            _issue(
                row_number,
                invoice,
                "error",
                "accounting",
                code,
                field,
                message,
                expected="/".join(allowed_prefixes),
                actual=actual.value,
                source=actual.source,
            )
        )


def _check_payment_method(
    issues: list[ErrorCheckIssue],
    row_number: int,
    invoice: str | None,
    field: str,
    actual: "_AccountValue",
    payment_method: str,
    *,
    sale: bool,
) -> None:
    if not payment_method or not actual.value:
        return
    normalized = normalize_header(payment_method)
    expected_prefixes: tuple[str, ...] | None = None
    if "tien_mat" in normalized:
        expected_prefixes = ("111",)
    elif "chuyen_khoan" in normalized or "ngan_hang" in normalized:
        expected_prefixes = ("112",)
    elif "chua_thu" in normalized or "cong_no" in normalized or "chua_thanh_toan" in normalized:
        expected_prefixes = ("131",) if sale else ("331",)

    if expected_prefixes and not _account_startswith(actual.value, expected_prefixes):
        issues.append(
            _issue(
                row_number,
                invoice,
                "warning",
                "accounting",
                "accounting_payment_method_account_mismatch",
                field,
                "Phương thức thanh toán không khớp nhóm tài khoản tiền/công nợ.",
                expected="/".join(expected_prefixes),
                actual=actual.value,
                source=actual.source,
            )
        )


class _AccountValue:
    def __init__(self, value: str | None, source: str | None) -> None:
        self.value = _account_code(value)
        self.source = source


def _account_value(
    row: dict[str, Any],
    detected_columns: dict[str, str],
    semantic_field: str,
    defaults: dict[str, Any],
    default_header: str,
) -> _AccountValue:
    value = semantic_value(row, detected_columns, semantic_field)
    if not is_blank(value):
        return _AccountValue(_text(value), detected_columns.get(semantic_field))
    default_value = defaults.get(default_header)
    if not is_blank(default_value):
        return _AccountValue(_text(default_value), f"defaults.{default_header}")
    return _AccountValue(None, None)


def _account_startswith(value: str | None, prefixes: tuple[str, ...]) -> bool:
    if not value:
        return False
    return any(value.startswith(prefix) for prefix in prefixes)


def _account_code(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    match = re.search(r"\d+(?:\.\d+)?", text)
    if not match:
        return text
    return match.group(0).replace(".", "")


def _has_vat(row: dict[str, Any], detected_columns: dict[str, str]) -> bool:
    vat_amount = parse_number(semantic_value(row, detected_columns, "vat_amount"))
    vat_rate = parse_number(str(semantic_value(row, detected_columns, "vat_rate") or "").replace("%", ""))
    return bool((vat_amount is not None and abs(float(vat_amount)) > 0) or (vat_rate is not None and abs(float(vat_rate)) > 0))


def _has_discount(row: dict[str, Any], detected_columns: dict[str, str]) -> bool:
    for field in ("discount_amount", "discount_total", "discount_percent"):
        value = semantic_value(row, detected_columns, field)
        if not is_blank(value):
            parsed = parse_number(str(value).replace("%", ""))
            if parsed is not None and abs(float(parsed)) > 0:
                return True
    return False


def _document_number(
    row: dict[str, Any],
    detected_columns: dict[str, str],
    definition: ConversionTypeDefinition,
) -> str | None:
    field = "invoice" if definition.kind.startswith("sales") else "purchase_receipt"
    value = semantic_value(row, detected_columns, field)
    return _text(value) or None


def _merged_defaults(definition: ConversionTypeDefinition, options: JsonDict) -> dict[str, Any]:
    defaults = dict(definition.defaults)
    option_defaults = options.get("defaults", {}) if isinstance(options, dict) else {}
    if isinstance(option_defaults, dict):
        defaults.update(option_defaults)
    return defaults


def _issue(
    row: int,
    invoice: str | None,
    severity: str,
    category: str,
    code: str,
    field: str,
    message: str,
    *,
    expected: str | float | int | None = None,
    actual: str | float | int | None = None,
    source: str | None = None,
) -> ErrorCheckIssue:
    return ErrorCheckIssue(
        row=row,
        invoice=invoice,
        severity=severity,
        category=category,
        code=code,
        field=field,
        expected=expected,
        actual=actual,
        source=source,
        message=message,
    )


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()
