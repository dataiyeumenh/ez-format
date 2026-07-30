from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest
import xlrd
from fastapi.testclient import TestClient

import app.main as main
import app.import_result_workflow as import_result_workflow
from app.excel_io import InputTable
from app.export_manifest import build_export_manifest
from app.import_repair_export import (
    RetryBlockedError,
    export_retry_workbook,
    prepare_retry,
)
from app.mapping_profile_v2 import template_version
from app.misa_templates import get_misa_template


SERVICE_TOKEN = "test-import-repair-service-token"


def _manifest(rows: list[dict], *, origins: list[dict] | None = None):
    template = get_misa_template("bsn_sales")
    return build_export_manifest(
        conversion_id="run-1",
        export_batch_id="batch-1",
        target_template_id=template.id,
        template_hash=template_version(template.workbook.path),
        raw_file_hash="b" * 64,
        mapping_profile_id="profile-1",
        mapping_profile_version=1,
        validation_ruleset_version="misa-readiness-v1",
        output_rows=rows,
        row_origins=origins
        or [
            {"raw_sheet": "Raw", "raw_rows": [index + 2]}
            for index in range(len(rows))
        ],
    )


def _two_line_rows() -> list[dict]:
    return [
        {
            "Số chứng từ (*)": "BH0001",
            "Ngày chứng từ (*)": "01/07/2026",
            "Mã khách hàng": "KH01",
            "Mã hàng (*)": "HH01",
            "Số lượng": Decimal("1"),
            "Đơn giá": Decimal("100"),
            "Thành tiền": Decimal("100"),
        },
        {
            "Số chứng từ (*)": "BH0001",
            "Ngày chứng từ (*)": "01/07/2026",
            "Mã khách hàng": "KH01",
            "Mã hàng (*)": "HH02",
            "Số lượng": Decimal("1"),
            "Đơn giá": Decimal("200"),
            "Thành tiền": Decimal("200"),
        },
    ]


def test_retry_includes_every_line_in_document_group():
    rows = _two_line_rows()
    manifest = _manifest(rows)
    group_id = manifest.rows[0].document_group_id

    result = prepare_retry(
        manifest=manifest,
        selected_document_group_ids=[group_id],
        confirmed_failed_group_ids={group_id},
        patches=[],
        source_rows=rows,
        template_headers=get_misa_template("bsn_sales").headers,
    )

    assert len(result.rows) == 2
    assert [row["Mã hàng (*)"] for row in result.rows] == ["HH01", "HH02"]


def test_unknown_import_status_blocks_retry():
    rows = _two_line_rows()[:1]
    manifest = _manifest(rows)
    group_id = manifest.rows[0].document_group_id

    with pytest.raises(RetryBlockedError, match="unknown"):
        prepare_retry(
            manifest=manifest,
            selected_document_group_ids=[group_id],
            confirmed_failed_group_ids=set(),
            patches=[],
            source_rows=rows,
            template_headers=get_misa_template("bsn_sales").headers,
        )


@pytest.mark.parametrize("status", ["unknown", "imported", "mixed"])
def test_non_failed_or_mixed_group_status_blocks_retry(status: str):
    rows = _two_line_rows()[:1]
    manifest = _manifest(rows)
    group_id = manifest.rows[0].document_group_id

    with pytest.raises(RetryBlockedError, match=status):
        prepare_retry(
            manifest=manifest,
            selected_document_group_ids=[group_id],
            confirmed_failed_group_ids={group_id},
            document_group_statuses={group_id: status},
            patches=[],
            source_rows=rows,
            template_headers=get_misa_template("bsn_sales").headers,
        )


def test_unknown_manifest_group_integrity_blocks_retry():
    rows = _two_line_rows()[:1]
    manifest = _manifest(rows, origins=[{"raw_sheet": "", "raw_rows": []}])
    group_id = manifest.rows[0].document_group_id

    with pytest.raises(RetryBlockedError, match="integrity"):
        prepare_retry(
            manifest=manifest,
            selected_document_group_ids=[group_id],
            confirmed_failed_group_ids={group_id},
            patches=[],
            source_rows=rows,
            template_headers=get_misa_template("bsn_sales").headers,
        )


def test_allowlisted_patch_targets_only_the_confirmed_output_row():
    rows = _two_line_rows()
    manifest = _manifest(rows)
    group_id = manifest.rows[0].document_group_id

    result = prepare_retry(
        manifest=manifest,
        selected_document_group_ids=[group_id],
        confirmed_failed_group_ids={group_id},
        patches=[
            {
                "document_group_id": group_id,
                "output_row_number": 2,
                "field": "Mã hàng (*)",
                "transform": "replace_code",
                "from": "HH02",
                "to": "0002",
            }
        ],
        source_rows=rows,
        template_headers=get_misa_template("bsn_sales").headers,
    )

    assert result.rows[0]["Mã hàng (*)"] == "HH01"
    assert result.rows[1]["Mã hàng (*)"] == "0002"
    assert result.before_rows[1]["Mã hàng (*)"] == "HH02"


@pytest.mark.parametrize(
    "patch,match",
    [
        ({"field": "Unknown", "value": "x", "transform": "set_value"}, "header"),
        ({"field": "Mã hàng (*)", "value": "=1+1", "transform": "set_value"}, "formula"),
        ({"field": "Mã hàng (*)", "value": {"nested": True}, "transform": "set_value"}, "nested"),
        ({"field": "Mã hàng (*)", "value": "x", "transform": "expression"}, "transform"),
    ],
)
def test_unsafe_patch_shapes_are_rejected(patch: dict, match: str):
    rows = _two_line_rows()[:1]
    manifest = _manifest(rows)
    group_id = manifest.rows[0].document_group_id

    with pytest.raises(RetryBlockedError, match=match):
        prepare_retry(
            manifest=manifest,
            selected_document_group_ids=[group_id],
            confirmed_failed_group_ids={group_id},
            patches=[{"document_group_id": group_id, **patch}],
            source_rows=rows,
            template_headers=get_misa_template("bsn_sales").headers,
        )


def test_retry_export_uses_real_template_and_keeps_full_group(tmp_path):
    rows = _two_line_rows()
    manifest = _manifest(rows)
    group_id = manifest.rows[0].document_group_id
    prepared = prepare_retry(
        manifest=manifest,
        selected_document_group_ids=[group_id],
        confirmed_failed_group_ids={group_id},
        patches=[],
        source_rows=rows,
        template_headers=get_misa_template("bsn_sales").headers,
    )

    content = export_retry_workbook(prepared, manifest=manifest)
    output = tmp_path / "retry.xls"
    output.write_bytes(content)
    sheet = xlrd.open_workbook(str(output), formatting_info=True).sheet_by_index(0)
    template = get_misa_template("bsn_sales")
    headers = sheet.row_values(template.workbook.header_row_index)
    item_col = headers.index("Mã hàng (*)")

    assert sheet.cell_value(template.data_start_row - 1, item_col) == "HH01"
    assert sheet.cell_value(template.data_start_row, item_col) == "HH02"
    assert manifest.template_hash == template_version(template.workbook.path)


def test_internal_readiness_endpoint_returns_revalidated_summary(monkeypatch):
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setattr(
        main,
        "_conversion_context_for_request",
        lambda *args, **kwargs: ("signed-context", object()),
    )
    monkeypatch.setattr(
        main,
        "build_bound_retry_readiness",
        lambda **kwargs: {
            "status": "ready",
            "summary": {"fatal": 0, "blocker": 0, "warning": 0, "info": 0},
            "issues": [],
            "examples": [],
        },
    )
    client = TestClient(main.app, raise_server_exceptions=False)

    response = client.post(
        "/api/v1/import-repairs/readiness",
        headers={
            "x-converter-service-token": SERVICE_TOKEN,
            "x-conversion-context": "signed-context",
        },
        json={"upload_id": "upload-1", "session_id": "session-1"},
    )

    assert response.status_code == 200
    assert response.json()["summary"]["blocker"] == 0


def test_bound_readiness_rebuilds_trusted_manifest_and_returns_before_after(monkeypatch):
    rows = _two_line_rows()
    bound_manifest = _manifest(rows)
    group_id = bound_manifest.rows[0].document_group_id
    template = get_misa_template("bsn_sales")
    monkeypatch.setattr(
        import_result_workflow,
        "_resolve_confirmed_export",
        lambda **kwargs: SimpleNamespace(
            rows=rows,
            row_origins=[
                {"raw_sheet": "Raw", "raw_rows": [2]},
                {"raw_sheet": "Raw", "raw_rows": [3]},
            ],
            table=InputTable(
                headers=list(rows[0]),
                rows=rows,
                sheet_name="Raw",
                header_row_index=0,
            ),
            template=template,
        ),
    )

    result = import_result_workflow.build_bound_retry_readiness(
        body={
            "upload_id": "upload-1",
            "session_id": "session-1",
            "conversion_run_id": "run-1",
            "target_template_id": "bsn_sales",
            "profile_id": "profile-1",
            "manifest": bound_manifest.model_dump(mode="json"),
            "selected_document_group_ids": [group_id],
            "confirmed_failed_group_ids": [group_id],
            "document_group_statuses": {group_id: "failed"},
            "patches": [
                {
                    "document_group_id": group_id,
                    "output_row_number": 2,
                    "field": "Mã hàng (*)",
                    "transform": "replace_code",
                    "from": "HH02",
                    "to": "0002",
                }
            ],
        },
        context_token="signed-context",
    )

    assert result["selected_row_count"] == 2
    assert result["examples"] == [
        {
            "document_group_id": group_id,
            "output_row_number": 2,
            "field": "Mã hàng (*)",
            "before": "HH02",
            "after": "0002",
        }
    ]


def test_internal_export_endpoint_returns_real_workbook_bytes(monkeypatch):
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setattr(
        main,
        "_conversion_context_for_request",
        lambda *args, **kwargs: ("signed-context", object()),
    )
    monkeypatch.setattr(
        main,
        "export_bound_retry_workbook",
        lambda **kwargs: (b"real-misa-workbook", "MISA retry.xls"),
    )
    client = TestClient(main.app, raise_server_exceptions=False)

    response = client.post(
        "/api/v1/import-repairs/export",
        headers={
            "x-converter-service-token": SERVICE_TOKEN,
            "x-conversion-context": "signed-context",
        },
        json={"upload_id": "upload-1", "session_id": "session-1"},
    )

    assert response.status_code == 200
    assert response.content == b"real-misa-workbook"
    assert response.headers["content-type"].startswith("application/vnd.ms-excel")
