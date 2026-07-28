from __future__ import annotations

import os
import time
from io import BytesIO

import openpyxl
import pytest

from app.excel_io import InputTable
from app.operation_store import OperationStore
from app.reconciliation_workflow_v2 import add_comparison_file, run_reconciliation


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_ACCOUNTING_OPERATIONS_PERFORMANCE") != "1",
    reason="Set RUN_ACCOUNTING_OPERATIONS_PERFORMANCE=1 for the release benchmark",
)

HEADERS = ["MST người bán", "Ký hiệu", "Số hóa đơn", "Ngày hóa đơn", "Tổng tiền"]


def _row(index: int) -> dict[str, object]:
    return {
        "MST người bán": "0312345678",
        "Ký hiệu": "C26TAA",
        "Số hóa đơn": f"{index:06d}",
        "Ngày hóa đơn": "01/07/2026",
        "Tổng tiền": 100_000 + index,
    }


def _xlsx(row_count: int) -> bytes:
    workbook = openpyxl.Workbook(write_only=True)
    sheet = workbook.create_sheet("Data")
    sheet.append(HEADERS)
    for index in range(row_count):
        row = _row(index)
        sheet.append([row[header] for header in HEADERS])
    payload = BytesIO()
    workbook.save(payload)
    return payload.getvalue()


@pytest.mark.parametrize(
    ("row_count", "budget_seconds"),
    [(10_000, 20.0), (50_000, 75.0)],
)
def test_exact_reconciliation_scales_linearly_without_cartesian_matching(
    tmp_path, monkeypatch, row_count: int, budget_seconds: float
):
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    store = OperationStore(tmp_path / str(row_count))
    rows = [_row(index) for index in range(row_count)]
    session = store.create_session(
        upload_id=f"performance-{row_count}",
        owner_scope="user:performance-user",
        user_id="performance-user",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="performance-v1",
        source_signature={"row_count": row_count},
        table=InputTable(headers=HEADERS, rows=rows),
        raw_sha256=f"synthetic-{row_count}",
        ttl_seconds=3600,
    )
    comparison = _xlsx(row_count)

    started = time.perf_counter()
    for role in ("invoice_export", "internal_ledger"):
        add_comparison_file(
            store,
            session_id=session.session_id,
            revision=1,
            state_hash=session.state_hash,
            filename=f"{role}.xlsx",
            content=comparison,
            role=role,
        )
    report = run_reconciliation(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    elapsed = time.perf_counter() - started

    assert report["status"] == "complete"
    assert report["summary"]["matched"] == row_count
    assert report["summary"]["conflicts"] == 0
    assert elapsed <= budget_seconds, (
        f"{row_count}-row reconciliation took {elapsed:.2f}s; "
        f"budget is {budget_seconds:.2f}s"
    )
