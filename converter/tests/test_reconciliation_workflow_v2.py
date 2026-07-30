from __future__ import annotations

from io import BytesIO

import openpyxl
import pytest

from app.excel_io import InputTable
from app.operation_store import OperationStore, OperationStoreError
from app.reconciliation_workflow_v2 import (
    add_comparison_file,
    confirm_candidate_match,
    get_reconciliation_report,
    run_reconciliation,
)


HEADERS = ["MST người bán", "Ký hiệu", "Số hóa đơn", "Ngày hóa đơn", "Tổng tiền"]


def _xlsx(rows):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(HEADERS)
    for row in rows:
        sheet.append(row)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _xlsx_with_headers(headers, rows):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _session(store: OperationStore):
    return store.create_session(
        upload_id="upload-reconcile",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="template-v1",
        source_signature={"hash": "source-v1"},
        table=InputTable(
            headers=HEADERS,
            rows=[
                {
                    "MST người bán": "0312345678",
                    "Ký hiệu": "C26TAA",
                    "Số hóa đơn": "000001",
                    "Ngày hóa đơn": "01/07/2026",
                    "Tổng tiền": 108000,
                }
            ],
        ),
        raw_sha256="raw-sha",
        ttl_seconds=3600,
    )


def test_reconciliation_without_optional_file_is_not_run(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert report["status"] == "not_run"
    assert report["roles_present"] == ["primary"]


def test_strong_invoice_key_matches_with_one_optional_source(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="invoice.xlsx",
        content=_xlsx([["0312345678", "C26TAA", "000001", "01/07/2026", 108000]]),
        role="invoice_export",
    )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert report["status"] == "partial"
    assert report["summary"]["matched"] == 1
    assert report["summary"]["conflicts"] == 0


@pytest.mark.parametrize("raw_total", ["không phải số", "", "1,2,3"])
def test_strong_key_with_unusable_total_is_conflict_not_match(
    tmp_path, monkeypatch, raw_total
):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="invoice.xlsx",
        content=_xlsx([["0312345678", "C26TAA", "000001", "01/07/2026", raw_total]]),
        role="invoice_export",
    )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert report["summary"]["matched"] == 0
    assert report["summary"]["conflicts"] == 1
    assert report["records"][0]["reason"] == "total_unavailable"


def test_amount_only_never_auto_matches_and_third_optional_file_is_rejected(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    amount_only = _xlsx([["", "", "", "", 108000]])
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="a.xlsx",
        content=amount_only,
        role="payment_list",
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="b.xlsx",
        content=amount_only,
        role="inventory_list",
    )

    with pytest.raises(OperationStoreError):
        add_comparison_file(
            store,
            session_id=session.session_id,
            revision=1,
            state_hash=session.state_hash,
            filename="c.xlsx",
            content=amount_only,
            role="other",
        )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    assert report["summary"]["matched"] == 0
    assert report["status"] == "insufficient_evidence"
    assert store.load_session(session.session_id).active_revision == 1


def test_composite_key_is_candidate_only_until_user_confirms(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    headers = ["Số hóa đơn", "Ngày hóa đơn", "Tên nhà cung cấp", "Tổng tiền"]
    session = store.create_session(
        upload_id="candidate-upload",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(
            headers=headers,
            rows=[
                {
                    "Số hóa đơn": "HD-01",
                    "Ngày hóa đơn": "01/07/2026",
                    "Tên nhà cung cấp": "Công ty A",
                    "Tổng tiền": 108000,
                }
            ],
        ),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="candidate.xlsx",
        content=_xlsx_with_headers(headers, [["HD-01", "01/07/2026", "Công ty A", 108000]]),
        role="invoice_export",
    )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    candidate = next(item for item in report["records"] if item["status"] == "candidate")

    assert report["summary"]["matched"] == 0
    assert report["summary"]["candidates_need_review"] == 1
    confirmed = confirm_candidate_match(
        store,
        session_id=session.session_id,
        report_id=report["report_id"],
        match_id=candidate["match_id"],
        revision=1,
        state_hash=session.state_hash,
        confirmed_by="user:user-1",
    )
    assert confirmed["status"] == "confirmed_candidate"


def test_ambiguous_candidate_requires_explicit_comparison_record_selection(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    headers = ["Số hóa đơn", "Ngày hóa đơn", "Tên nhà cung cấp", "Tổng tiền"]
    row = {
        "Số hóa đơn": "HD-01",
        "Ngày hóa đơn": "01/07/2026",
        "Tên nhà cung cấp": "Công ty A",
        "Tổng tiền": 108000,
    }
    session = store.create_session(
        upload_id="ambiguous-upload",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=headers, rows=[row]),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="ambiguous.xlsx",
        content=_xlsx_with_headers(
            headers,
            [
                ["HD-01", "01/07/2026", "Công ty A", 108000],
                ["HD-01", "01/07/2026", "Công ty A", 108000],
            ],
        ),
        role="invoice_export",
    )
    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    candidate = next(item for item in report["records"] if item["status"] == "candidate")

    assert len(candidate["comparison_record_ids"]) == 2
    assert [option["record_id"] for option in candidate["comparison_options"]] == candidate[
        "comparison_record_ids"
    ]
    assert [option["evidence"]["source_rows"] for option in candidate["comparison_options"]] == [
        [2],
        [3],
    ]
    assert all("HD-01" in option["label"] for option in candidate["comparison_options"])
    assert candidate["comparison_options"][0]["label"] != candidate["comparison_options"][1][
        "label"
    ]
    assert candidate["label"]
    assert candidate["evidence"]["invoice_number"] == "HD-01"
    assert report["summary"]["missing_primary"] == 2
    assert len(
        [item for item in report["records"] if item["status"] == "missing_primary"]
    ) == 2
    with pytest.raises(OperationStoreError, match="chọn bản ghi"):
        confirm_candidate_match(
            store,
            session_id=session.session_id,
            report_id=report["report_id"],
            match_id=candidate["match_id"],
            revision=1,
            state_hash=session.state_hash,
            confirmed_by="user:user-1",
        )

    selected_id = candidate["comparison_record_ids"][0]
    confirmed = confirm_candidate_match(
        store,
        session_id=session.session_id,
        report_id=report["report_id"],
        match_id=candidate["match_id"],
        revision=1,
        state_hash=session.state_hash,
        confirmed_by="user:user-1",
        selected_comparison_record_id=selected_id,
    )
    updated = get_reconciliation_report(
        store, session_id=session.session_id, report_id=report["report_id"]
    )
    alternatives = [
        item["comparison_record_id"]
        for item in updated["records"]
        if item["status"] == "missing_primary"
    ]

    assert confirmed["comparison_record_id"] == selected_id
    assert updated["summary"]["matched"] == 1
    assert updated["summary"]["candidates_need_review"] == 0
    assert updated["summary"]["missing_primary"] == 1
    assert alternatives == [candidate["comparison_record_ids"][1]]
    assert updated["status"] == "conflict"


@pytest.mark.parametrize(
    ("action", "expected_status", "summary_key"),
    [
        ("reject", "rejected_candidate", "rejected_candidates"),
        ("defer", "deferred_candidate", "deferred_candidates"),
    ],
)
def test_user_can_reject_or_defer_candidate_without_selecting_ambiguous_option(
    tmp_path, monkeypatch, action, expected_status, summary_key
):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    headers = ["Số hóa đơn", "Ngày hóa đơn", "Tên nhà cung cấp", "Tổng tiền"]
    row = {
        "Số hóa đơn": "HD-01",
        "Ngày hóa đơn": "01/07/2026",
        "Tên nhà cung cấp": "Công ty A",
        "Tổng tiền": 108000,
    }
    session = store.create_session(
        upload_id="rejected-candidate",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=headers, rows=[row]),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="ambiguous.xlsx",
        content=_xlsx_with_headers(headers, [list(row.values()), list(row.values())]),
        role="invoice_export",
    )
    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    candidate = next(item for item in report["records"] if item["status"] == "candidate")

    reviewed = confirm_candidate_match(
        store,
        session_id=session.session_id,
        report_id=report["report_id"],
        match_id=candidate["match_id"],
        revision=1,
        state_hash=session.state_hash,
        confirmed_by="user:user-1",
        action=action,
    )

    assert reviewed["status"] == expected_status
    assert reviewed["comparison_record_id"] is None
    assert reviewed["report_summary"][summary_key] == 1
    assert reviewed["report_summary"]["missing_primary"] == 2
    assert reviewed["report_status"] == "conflict"


def test_candidate_confirmation_reserves_each_comparison_record_once(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    headers = ["Số hóa đơn", "Ngày hóa đơn", "Tên nhà cung cấp", "Tổng tiền"]
    row = {
        "Số hóa đơn": "HD-01",
        "Ngày hóa đơn": "01/07/2026",
        "Tên nhà cung cấp": "Công ty A",
        "Tổng tiền": 108000,
    }
    session = store.create_session(
        upload_id="candidate-reservation",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=headers, rows=[row, row]),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="ambiguous.xlsx",
        content=_xlsx_with_headers(headers, [list(row.values()), list(row.values())]),
        role="invoice_export",
    )
    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    candidates = [item for item in report["records"] if item["status"] == "candidate"]
    first_option, second_option = candidates[0]["comparison_record_ids"]

    confirm_candidate_match(
        store,
        session_id=session.session_id,
        report_id=report["report_id"],
        match_id=candidates[0]["match_id"],
        revision=1,
        state_hash=session.state_hash,
        confirmed_by="user:user-1",
        selected_comparison_record_id=first_option,
    )
    with pytest.raises(OperationStoreError, match="đã được ghép"):
        confirm_candidate_match(
            store,
            session_id=session.session_id,
            report_id=report["report_id"],
            match_id=candidates[1]["match_id"],
            revision=1,
            state_hash=session.state_hash,
            confirmed_by="user:user-1",
            selected_comparison_record_id=first_option,
        )
    confirm_candidate_match(
        store,
        session_id=session.session_id,
        report_id=report["report_id"],
        match_id=candidates[1]["match_id"],
        revision=1,
        state_hash=session.state_hash,
        confirmed_by="user:user-1",
        selected_comparison_record_id=second_option,
    )
    updated = get_reconciliation_report(
        store, session_id=session.session_id, report_id=report["report_id"]
    )

    assert updated["summary"]["matched"] == 2
    assert updated["summary"]["missing_primary"] == 0
    assert updated["status"] == "partial"


def test_two_source_candidates_block_complete_until_each_is_confirmed(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    headers = ["Số hóa đơn", "Ngày hóa đơn", "Tên nhà cung cấp", "Tổng tiền"]
    row = {
        "Số hóa đơn": "HD-01",
        "Ngày hóa đơn": "01/07/2026",
        "Tên nhà cung cấp": "Công ty A",
        "Tổng tiền": 108000,
    }
    session = store.create_session(
        upload_id="candidate-three-way",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=headers, rows=[row]),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    for role in ("invoice_export", "internal_ledger"):
        add_comparison_file(
            store,
            session_id=session.session_id,
            revision=1,
            state_hash=session.state_hash,
            filename=f"{role}.xlsx",
            content=_xlsx_with_headers(
                headers, [["HD-01", "01/07/2026", "Công ty A", 108000]]
            ),
            role=role,
        )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert report["status"] != "complete"
    assert report["summary"]["candidates_need_review"] == 2
    for candidate in [item for item in report["records"] if item["status"] == "candidate"]:
        confirm_candidate_match(
            store,
            session_id=session.session_id,
            report_id=report["report_id"],
            match_id=candidate["match_id"],
            revision=1,
            state_hash=session.state_hash,
            confirmed_by="user:user-1",
        )
    updated = get_reconciliation_report(
        store, session_id=session.session_id, report_id=report["report_id"]
    )
    assert updated["status"] == "complete"
    assert updated["summary"]["candidates_need_review"] == 0


def test_invoice_key_fallback_matches_when_source_document_ids_differ(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    headers = ["ID chứng từ", *HEADERS]
    session = store.create_session(
        upload_id="stable-id-fallback",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(
            headers=headers,
            rows=[dict(zip(headers, ["SRC-A", "0312345678", "C26TAA", "000001", "01/07/2026", 108000]))],
        ),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="fallback.xlsx",
        content=_xlsx_with_headers(
            headers,
            [["SRC-B", "0312345678", "C26TAA", "000001", "01/07/2026", 108000]],
        ),
        role="invoice_export",
    )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert report["summary"]["matched"] == 1
    assert report["summary"]["missing_comparison"] == 0


def test_repeated_invoice_total_is_not_summed_per_detail_line(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    rows = [
        dict(zip(HEADERS, ["0312345678", "C26TAA", "000001", "01/07/2026", 108000])),
        dict(zip(HEADERS, ["0312345678", "C26TAA", "000001", "01/07/2026", 108000])),
    ]
    session = store.create_session(
        upload_id="repeated-total",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=HEADERS, rows=rows),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="one-invoice.xlsx",
        content=_xlsx([[rows[0][header] for header in HEADERS]]),
        role="invoice_export",
    )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert report["summary"]["matched"] == 1
    assert report["summary"]["conflicts"] == 0


def test_foreign_currency_and_quantity_use_declared_precision(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path)
    headers = [*HEADERS, "Loại tiền", "Số lượng"]
    primary = ["0312345678", "C26TAA", "000001", "01/07/2026", 100, "USD", "2.000000"]
    session = store.create_session(
        upload_id="precision",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=headers, rows=[dict(zip(headers, primary))]),
        raw_sha256="raw",
        ttl_seconds=3600,
    )
    add_comparison_file(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
        filename="precision.xlsx",
        content=_xlsx_with_headers(
            headers,
            [["0312345678", "C26TAA", "000001", "01/07/2026", "100.02", "USD", "2.000002"]],
        ),
        role="invoice_export",
    )

    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert report["summary"]["conflicts"] == 1
    conflict = next(item for item in report["records"] if item["status"] == "conflict")
    assert conflict["amount_tolerance"] == "0.01"
    assert conflict["quantity_tolerance"] == "0.000001"
