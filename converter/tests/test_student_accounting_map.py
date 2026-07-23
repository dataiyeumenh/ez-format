from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.field_provenance import source_field
from app.student_accounting_map import build_accounting_maps
from app.voucher_models import (
    ReconstructionSummary,
    VoucherDraft,
    VoucherField,
    VoucherLineDraft,
    VoucherReconstructionReport,
    VoucherTotals,
)


def _state(
    *,
    direction: str,
    nature: str,
    preview_row: dict[str, object],
    totals: VoucherTotals | None = None,
    fields: dict[str, VoucherField] | None = None,
    defaults: dict[str, object] | None = None,
    default_provenance: dict[str, str] | None = None,
) -> dict[str, object]:
    line = VoucherLineDraft(
        id="line-1",
        sequence=1,
        nature=nature,
        nature_trust="verified",
        fields=fields or {"amount": VoucherField(value="100.10", trust="verified")},
        source_rows=[2],
    )
    draft = VoucherDraft(
        id="voucher-stable-1",
        direction=direction,
        direction_trust="verified",
        nature=nature,
        nature_trust="verified",
        document_kind=f"{direction}_{nature}",
        status="ready",
        header={},
        lines=[line],
        totals=totals or VoucherTotals(amount="100.10", payment="100.10"),
        source_rows=[2],
    )
    report = VoucherReconstructionReport(
        source_signature_hash="source-signature",
        sheet_name="Data",
        detected_columns={},
        drafts=[draft],
        summary=ReconstructionSummary(draft_count=1, ready=1, needs_review=0, blocked=0),
        row_conservation={"source_rows": 1, "assigned_rows": 1},
    )
    return {
        "table": SimpleNamespace(
            headers=["Document"],
            rows=[{"Document": "HD-001"}],
            sheet_name="Data",
            header_row_index=0,
        ),
        "voucher_report": report,
        "student_preview": {"rows": [preview_row]},
        "defaults": defaults or {},
        "default_provenance": default_provenance or {},
    }


def test_sales_goods_uses_preview_accounts_and_links_source_voucher_and_preview_rows():
    maps = build_accounting_maps(
        _state(
            direction="sales",
            nature="goods",
            preview_row={
                "TK Tiền/Chi phí/Nợ (*)": "131",
                "TK Doanh thu/Có (*)": "5111",
            },
        )
    )

    assert len(maps) == 1
    accounting_map = maps[0]
    assert accounting_map.voucher_id == "voucher-stable-1"
    assert accounting_map.business_event == "sales_goods"
    assert accounting_map.business_event_status == "suggested"
    assert accounting_map.balanced is True
    assert [(entry.side, entry.account, entry.amount, entry.status) for entry in accounting_map.entries] == [
        ("debit", "131", "100.1", "suggested"),
        ("credit", "5111", "100.1", "suggested"),
    ]
    assert all(entry.evidence for entry in accounting_map.entries)
    assert all(entry.evidence[0].voucher_id == "voucher-stable-1" for entry in accounting_map.entries)
    assert all(entry.evidence[0].source_rows == [2] for entry in accounting_map.entries)
    assert all(entry.evidence[0].preview_rows == [1] for entry in accounting_map.entries)


def test_purchase_goods_uses_deterministic_template_defaults_with_explicit_provenance():
    maps = build_accounting_maps(
        _state(
            direction="purchase",
            nature="goods",
            preview_row={},
            defaults={
                "TK kho/TK chi phí (*)": "156",
                "TK công nợ/TK tiền (*)": "331",
            },
            default_provenance={
                "TK kho/TK chi phí (*)": "deterministic_derived",
                "TK công nợ/TK tiền (*)": "deterministic_derived",
            },
        )
    )

    accounting_map = maps[0]
    assert accounting_map.business_event == "purchase_goods"
    assert accounting_map.balanced is True
    assert [(entry.side, entry.account) for entry in accounting_map.entries] == [
        ("debit", "156"),
        ("credit", "331"),
    ]
    assert all(entry.status == "suggested" for entry in accounting_map.entries)
    assert all(
        evidence.provenance[0].source == "deterministic_derived"
        for entry in accounting_map.entries
        for evidence in entry.evidence
    )


def test_purchase_service_reuses_voucher_field_provenance_when_preview_has_no_account():
    fields = {
        "amount": VoucherField(value="100.10", trust="verified"),
        "inventory_account": source_field("642", sheet="Data", row=2, header="TK chi phí"),
        "payable_account": source_field("331", sheet="Data", row=2, header="TK công nợ"),
    }

    maps = build_accounting_maps(
        _state(direction="purchase", nature="service", preview_row={}, fields=fields)
    )

    accounting_map = maps[0]
    assert accounting_map.business_event == "purchase_service"
    assert accounting_map.balanced is True
    assert [(entry.side, entry.account) for entry in accounting_map.entries] == [
        ("debit", "642"),
        ("credit", "331"),
    ]
    assert all(entry.evidence[0].provenance[0].references[0].header.startswith("TK") for entry in accounting_map.entries)


def test_missing_accounts_remain_unresolved_without_inventing_an_account():
    maps = build_accounting_maps(
        _state(direction="sales", nature="goods", preview_row={})
    )

    accounting_map = maps[0]
    assert [entry.account for entry in accounting_map.entries] == [None, None]
    assert all(entry.status == "unresolved" for entry in accounting_map.entries)
    assert all(entry.evidence for entry in accounting_map.entries)
    assert {issue.code for issue in accounting_map.issues} == {"account_unresolved"}


def test_unresolved_business_event_is_not_balanced_or_empty_success():
    accounting_map = build_accounting_maps(
        _state(direction="unknown", nature="unknown", preview_row={})
    )[0]

    assert accounting_map.business_event_status == "unresolved"
    assert accounting_map.entries == []
    assert accounting_map.balanced is False
    assert [issue.code for issue in accounting_map.issues] == [
        "business_event_unresolved"
    ]


def test_ai_only_account_and_unbalanced_totals_require_review_and_block_the_exercise():
    maps = build_accounting_maps(
        _state(
            direction="sales",
            nature="service",
            preview_row={"TK Tiền/Chi phí/Nợ (*)": "131", "TK Doanh thu/Có (*)": "511"},
            totals=VoucherTotals(amount="100", vat="10", payment="100"),
            defaults={"TK thuế GTGT": "3331"},
            default_provenance={"TK thuế GTGT": "ai_suggestion"},
        )
    )

    accounting_map = maps[0]
    assert accounting_map.business_event == "sales_service"
    assert accounting_map.balanced is False
    assert accounting_map.entries[-1].account == "3331"
    assert accounting_map.entries[-1].status == "needs_review"
    assert {issue.code for issue in accounting_map.issues} == {
        "account_needs_review",
        "entries_unbalanced",
    }


@pytest.mark.parametrize("invalid_amount", [None, "not-a-number"])
def test_partial_voucher_with_missing_or_unparseable_line_amount_is_not_balanced(
    invalid_amount,
):
    state = _state(
        direction="sales",
        nature="goods",
        preview_row={
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
        },
    )
    draft = state["voucher_report"].drafts[0]
    draft.lines.append(
        VoucherLineDraft(
            id="line-2",
            sequence=2,
            nature="goods",
            nature_trust="verified",
            fields={"amount": VoucherField(value=invalid_amount, trust="missing")},
            source_rows=[3],
        )
    )
    state["table"].rows.append({"Document": "HD-001"})
    state["student_preview"]["rows"].append(
        {
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
        }
    )

    accounting_map = build_accounting_maps(state)[0]

    assert accounting_map.balanced is False
    assert [(entry.side, entry.amount) for entry in accounting_map.entries] == [
        ("debit", "100.1"),
        ("credit", "100.1"),
    ]
    assert [issue.code for issue in accounting_map.issues] == [
        "required_line_amount_invalid"
    ]
