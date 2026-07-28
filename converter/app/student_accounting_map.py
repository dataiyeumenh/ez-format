from __future__ import annotations

from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.voucher_models import FieldProvenance, SourceReference, VoucherDraft, VoucherField


EntrySide = Literal["debit", "credit"]
MapStatus = Literal["suggested", "needs_review", "unresolved"]
IssueSeverity = Literal["blocker", "warning"]


class AccountingEvidence(BaseModel):
    voucher_id: str
    source_rows: list[int]
    preview_rows: list[int] = Field(default_factory=list)
    target_field: str | None = None
    provenance: list[FieldProvenance] = Field(default_factory=list)


class AccountingEntry(BaseModel):
    side: EntrySide
    account: str | None = None
    amount: str
    status: MapStatus
    reason_vi: str
    evidence: list[AccountingEvidence]


class AccountingMapIssue(BaseModel):
    severity: IssueSeverity
    code: str
    message_vi: str


class AccountingMap(BaseModel):
    voucher_id: str
    business_event: str
    business_event_status: MapStatus
    entries: list[AccountingEntry]
    balanced: bool
    issues: list[AccountingMapIssue]
    evidence: list[AccountingEvidence]


_ACCOUNT_FIELDS = {
    "sales": {
        "debit": ("TK Tiền/Chi phí/Nợ (*)", "debit_account"),
        "credit": ("TK Doanh thu/Có (*)", "credit_account"),
        "tax": ("TK thuế GTGT",),
    },
    "purchase": {
        "debit": ("TK kho/TK chi phí (*)", "inventory_account"),
        "credit": ("TK công nợ/TK tiền (*)", "payable_account"),
        "tax": ("TK thuế GTGT",),
    },
}

_PROVENANCE_SOURCES = {
    "source_direct",
    "source_fill_down",
    "workspace_master_data",
    "confirmed_alias",
    "approved_profile",
    "deterministic_derived",
    "ai_suggestion",
    "manual",
}


def build_accounting_maps(session_state: dict[str, Any]) -> list[AccountingMap]:
    """Build reviewable accounting suggestions from canonical vouchers and mapped rows."""
    report = session_state.get("voucher_report")
    drafts = getattr(report, "drafts", None)
    if drafts is None and isinstance(report, dict):
        drafts = report.get("drafts")
    if not drafts:
        return []

    preview_rows = list((session_state.get("student_preview") or {}).get("rows") or [])
    table = session_state.get("table")
    defaults = dict(session_state.get("defaults") or {})
    default_provenance = dict(session_state.get("default_provenance") or {})
    return [
        _build_map(
            draft,
            preview_rows=preview_rows,
            table=table,
            defaults=defaults,
            default_provenance=default_provenance,
        )
        for draft in drafts
    ]


def _build_map(
    draft: VoucherDraft,
    *,
    preview_rows: list[dict[str, Any]],
    table: Any,
    defaults: dict[str, Any],
    default_provenance: dict[str, str],
) -> AccountingMap:
    business_event = f"{draft.direction}_{draft.nature}"
    event_status: MapStatus = (
        "suggested"
        if draft.direction in _ACCOUNT_FIELDS and draft.nature in {"goods", "service"}
        else "unresolved"
    )
    issues: list[AccountingMapIssue] = []
    entries: OrderedDict[tuple[str, str | None, str], AccountingEntry] = OrderedDict()
    source_sheet = str(getattr(table, "sheet_name", "") or "")

    if event_status == "unresolved":
        issues.append(
            AccountingMapIssue(
                severity="warning",
                code="business_event_unresolved",
                message_vi="Chưa xác định được nghiệp vụ để lập bút toán gợi ý.",
            )
        )
        return AccountingMap(
            voucher_id=draft.id,
            business_event=business_event,
            business_event_status=event_status,
            entries=[],
            balanced=False,
            issues=issues,
            evidence=[],
        )

    base_total = Decimal("0")
    first_counterparty: _AccountChoice | None = None
    has_invalid_required_amount = False
    for line in draft.lines:
        amount = _decimal(line.fields.get("amount", VoucherField()).value)
        if amount is None:
            has_invalid_required_amount = True
            issues.append(
                AccountingMapIssue(
                    severity="blocker",
                    code="required_line_amount_invalid",
                    message_vi=(
                        f"Dòng chứng từ {line.sequence} thiếu số tiền bắt buộc "
                        "hoặc số tiền không thể đọc được."
                    ),
                )
            )
            continue
        base_total += amount
        preview_row, preview_index = _preview_row_for(line.source_rows, table, preview_rows)
        debit_choice = _account_choice(
            draft,
            line,
            "debit",
            preview_row=preview_row,
            preview_index=preview_index,
            source_sheet=source_sheet,
            defaults=defaults,
            default_provenance=default_provenance,
        )
        credit_choice = _account_choice(
            draft,
            line,
            "credit",
            preview_row=preview_row,
            preview_index=preview_index,
            source_sheet=source_sheet,
            defaults=defaults,
            default_provenance=default_provenance,
        )
        _add_entry(entries, debit_choice, "debit", amount)
        _add_entry(entries, credit_choice, "credit", amount)
        if first_counterparty is None:
            first_counterparty = debit_choice if draft.direction == "sales" else credit_choice

    vat = _decimal(draft.totals.vat) or Decimal("0")
    if vat:
        line = draft.lines[0] if draft.lines else None
        preview_row, preview_index = _preview_row_for(
            line.source_rows if line else draft.source_rows,
            table,
            preview_rows,
        )
        tax_choice = _account_choice(
            draft,
            line,
            "tax",
            preview_row=preview_row,
            preview_index=preview_index,
            source_sheet=source_sheet,
            defaults=defaults,
            default_provenance=default_provenance,
        )
        counterparty_amount = (_decimal(draft.totals.payment) or Decimal("0")) - base_total
        if draft.direction == "sales":
            _add_entry(entries, first_counterparty or tax_choice, "debit", counterparty_amount)
            _add_entry(entries, tax_choice, "credit", vat)
        else:
            _add_entry(entries, tax_choice, "debit", vat)
            _add_entry(entries, first_counterparty or tax_choice, "credit", counterparty_amount)

    if not entries and draft.source_rows:
        missing = _missing_choice(draft, draft.source_rows, None, None)
        _add_entry(entries, missing, "debit", _decimal(draft.totals.amount) or Decimal("0"))
        _add_entry(entries, missing, "credit", _decimal(draft.totals.amount) or Decimal("0"))

    result_entries = list(entries.values())
    if any(entry.status == "unresolved" for entry in result_entries):
        issues.append(
            AccountingMapIssue(
                severity="warning",
                code="account_unresolved",
                message_vi="Thiếu tài khoản từ dữ liệu, cấu hình đã xác nhận hoặc mặc định template rõ nguồn.",
            )
        )
    if any(entry.status == "needs_review" for entry in result_entries):
        issues.append(
            AccountingMapIssue(
                severity="warning",
                code="account_needs_review",
                message_vi="Tài khoản chỉ có nguồn gợi ý và cần kế toán xác nhận.",
            )
        )

    debit_total = sum(
        (_decimal(entry.amount) or Decimal("0") for entry in result_entries if entry.side == "debit"),
        Decimal("0"),
    )
    credit_total = sum(
        (_decimal(entry.amount) or Decimal("0") for entry in result_entries if entry.side == "credit"),
        Decimal("0"),
    )
    entries_balanced = debit_total == credit_total
    balanced = entries_balanced and not has_invalid_required_amount
    if not entries_balanced:
        issues.append(
            AccountingMapIssue(
                severity="blocker",
                code="entries_unbalanced",
                message_vi="Tổng Nợ và Có không cân; cần sửa bài tập trước khi tiếp tục.",
            )
        )

    evidence = [evidence for entry in result_entries for evidence in entry.evidence]
    return AccountingMap(
        voucher_id=draft.id,
        business_event=business_event,
        business_event_status=event_status,
        entries=result_entries,
        balanced=balanced,
        issues=issues,
        evidence=evidence,
    )


class _AccountChoice:
    def __init__(self, account: str | None, status: MapStatus, evidence: AccountingEvidence, reason_vi: str):
        self.account = account
        self.status = status
        self.evidence = evidence
        self.reason_vi = reason_vi


def _account_choice(
    draft: VoucherDraft,
    line: Any,
    role: str,
    *,
    preview_row: dict[str, Any] | None,
    preview_index: int | None,
    source_sheet: str,
    defaults: dict[str, Any],
    default_provenance: dict[str, str],
) -> _AccountChoice:
    account_fields = _ACCOUNT_FIELDS[draft.direction][role]
    target_field = account_fields[0]
    voucher_field = account_fields[1] if len(account_fields) > 1 else None
    source_rows = list(getattr(line, "source_rows", None) or draft.source_rows)
    preview_value = (preview_row or {}).get(target_field)
    if _text(preview_value):
        provenance = FieldProvenance(
            source="deterministic_derived",
            references=_references(source_sheet, source_rows, target_field),
            note=f"Giá trị trường MISA preview '{target_field}'.",
        )
        return _choice(
            _text(preview_value),
            "suggested",
            draft,
            source_rows,
            preview_index,
            target_field,
            [provenance],
            "Tài khoản lấy từ dòng preview MISA hiện tại.",
        )

    field = getattr(line, "fields", {}).get(voucher_field) if voucher_field else None
    if field and _text(field.value):
        return _choice(
            _text(field.value),
            "suggested",
            draft,
            source_rows,
            preview_index,
            target_field,
            list(field.provenance),
            "Tài khoản lấy từ trường chứng từ có provenance nguồn.",
        )

    default_value = defaults.get(target_field)
    if _text(default_value):
        source = default_provenance.get(target_field, "deterministic_derived")
        provenance_source = source if source in _PROVENANCE_SOURCES else "manual"
        status: MapStatus = "needs_review" if provenance_source == "ai_suggestion" else "suggested"
        provenance = FieldProvenance(
            source=provenance_source,
            references=_references(source_sheet, source_rows, target_field),
            note=f"Mặc định cấu hình cho trường MISA '{target_field}'.",
        )
        return _choice(
            _text(default_value),
            status,
            draft,
            source_rows,
            preview_index,
            target_field,
            [provenance],
            "Tài khoản lấy từ mặc định có provenance rõ ràng.",
        )

    return _missing_choice(draft, source_rows, preview_index, target_field)


def _choice(
    account: str | None,
    status: MapStatus,
    draft: VoucherDraft,
    source_rows: list[int],
    preview_index: int | None,
    target_field: str | None,
    provenance: list[FieldProvenance],
    reason_vi: str,
) -> _AccountChoice:
    return _AccountChoice(
        account,
        status,
        AccountingEvidence(
            voucher_id=draft.id,
            source_rows=source_rows,
            preview_rows=[] if preview_index is None else [preview_index],
            target_field=target_field,
            provenance=provenance,
        ),
        reason_vi,
    )


def _missing_choice(
    draft: VoucherDraft,
    source_rows: list[int],
    preview_index: int | None,
    target_field: str | None,
) -> _AccountChoice:
    return _choice(
        None,
        "unresolved",
        draft,
        source_rows,
        preview_index,
        target_field,
        [],
        "Không có tài khoản đủ căn cứ; hệ thống không tự đặt tài khoản.",
    )


def _add_entry(
    entries: OrderedDict[tuple[str, str | None, str], AccountingEntry],
    choice: _AccountChoice,
    side: EntrySide,
    amount: Decimal,
) -> None:
    key = (side, choice.account, choice.status)
    existing = entries.get(key)
    if existing:
        existing.amount = _decimal_text((_decimal(existing.amount) or Decimal("0")) + amount)
        existing.evidence.append(choice.evidence)
        return
    entries[key] = AccountingEntry(
        side=side,
        account=choice.account,
        amount=_decimal_text(amount),
        status=choice.status,
        reason_vi=choice.reason_vi,
        evidence=[choice.evidence],
    )


def _preview_row_for(
    source_rows: list[int], table: Any, preview_rows: list[dict[str, Any]]
) -> tuple[dict[str, Any] | None, int | None]:
    if not source_rows or table is None:
        return None, None
    header_row_index = int(getattr(table, "header_row_index", 0) or 0)
    preview_index = source_rows[0] - header_row_index - 1
    if 1 <= preview_index <= len(preview_rows):
        return preview_rows[preview_index - 1], preview_index
    return None, None


def _references(sheet: str, source_rows: list[int], target_field: str) -> list[SourceReference]:
    return [
        SourceReference(sheet=sheet, row=row, column=target_field)
        for row in source_rows
    ]


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None


def _decimal_text(value: Decimal) -> str:
    normalized = value.normalize()
    return str(normalized.quantize(Decimal("1"))) if normalized == normalized.to_integral() else format(normalized, "f")


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()
