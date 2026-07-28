from pathlib import Path

import xlrd
from fastapi.testclient import TestClient

from app.main import app
from app.operation_store import OperationStore

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "fixtures" / "samples"

client = TestClient(app)


def test_export_ignores_edited_preview_rows_uses_stored_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")

    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        analyze = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    "raw_sales_sample.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert analyze.status_code == 200
    analyze_payload = analyze.json()
    suggestion = analyze_payload["mapping_suggestion"]

    preview = client.post(
        "/api/v1/mappings/preview",
        json={
            "upload_id": analyze_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": suggestion["mapping"],
            "defaults": suggestion["defaults"],
            "formulas": suggestion["formulas"],
        },
    )
    assert preview.status_code == 200
    preview_payload = preview.json()
    edited_rows = [dict(preview_payload["rows"][0])]
    doc_header = "Số chứng từ (*)"
    edited_rows[0][doc_header] = "EDITED-PREVIEW-001"
    approved_defaults = {
        **suggestion["defaults"],
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
    }
    edited_rows[0].update(
        {
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
        }
    )

    confirm = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": analyze_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": suggestion["mapping"],
            "defaults": approved_defaults,
            "formulas": suggestion["formulas"],
            "profile_name": "Edited preview export",
        },
    )
    assert confirm.status_code == 200
    confirmed = confirm.json()
    profile_id = confirmed["profile_id"]
    stored_revision = OperationStore().create_revision(
        confirmed["session"]["session_id"],
        expected_revision=confirmed["session"]["active_revision"],
        expected_state_hash=confirmed["session"]["state_hash"],
        changes={"r1": {"Mã hóa đơn": "STORED-REVISION-001"}},
        created_by="user:pytest-user",
        activate=True,
    )

    export = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": analyze_payload["upload_id"],
            "profile_id": profile_id,
            "session_id": confirmed["session"]["session_id"],
            "revision": stored_revision.revision,
            "state_hash": stored_revision.state_hash,
            "conversion_run_id": "pytest-run-1",
            "rows": edited_rows,
            "acknowledge_warnings": True,
        },
    )
    assert export.status_code == 200

    workbook = xlrd.open_workbook(file_contents=export.content)
    sheet = workbook.sheet_by_index(0)
    headers = preview_payload["headers"]
    assert sheet.cell_value(8, headers.index(doc_header)) == "STORED-REVISION-001"
