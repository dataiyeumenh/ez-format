from __future__ import annotations

import json
import threading

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main
from tests.helpers.import_result_workbooks import (
    add_xlsx_external_link,
    add_xlsx_zip_payload,
    build_import_result_xlsx,
    build_import_result_xlsx_sheets,
)


pytestmark = pytest.mark.no_converter_auth
SERVICE_TOKEN = "test-import-result-service-token"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", SERVICE_TOKEN)
    return TestClient(main.app, raise_server_exceptions=False)


def test_import_result_parser_capacity_fails_closed(monkeypatch: pytest.MonkeyPatch):
    slots = threading.BoundedSemaphore(1)
    assert slots.acquire(blocking=False)
    monkeypatch.setattr(main, "_IMPORT_RESULT_PARSE_SLOTS", slots, raising=False)

    with pytest.raises(HTTPException) as caught:
        main._acquire_import_result_parse_slot()

    assert caught.value.status_code == 503


def test_analyze_returns_manual_inspection_without_persisting_raw_workbook(client: TestClient):
    content = build_import_result_xlsx(
        headers=["Message", "So CT"],
        rows=[["Rejected", "0007"]],
    )

    response = client.post(
        "/api/v1/import-results/analyze",
        headers={"x-converter-service-token": SERVICE_TOKEN},
        files={
            "file": (
                "result.xlsx",
                content,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["adapter"] == {"id": "manual_excel_v1", "verified": False}
    assert response.json()["status"] == "needs_schema_mapping"


def test_normalize_accepts_only_multipart_bytes_and_mapping_json(client: TestClient):
    content = build_import_result_xlsx(
        headers=["Message", "So CT"],
        rows=[["Rejected", "0007"]],
    )

    response = client.post(
        "/api/v1/import-results/normalize",
        headers={"x-converter-service-token": SERVICE_TOKEN},
        data={
            "mapping_json": json.dumps(
                {
                    "sheet_name": "Import result",
                    "header_row": 1,
                    "columns": {
                        "technical_message": "Message",
                        "document_number": "So CT",
                    },
                }
            )
        },
        files={
            "file": (
                "result.xlsx",
                content,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["issues"][0]["locator"]["document_number"] == "0007"
    assert "storage_key" not in response.request.content.decode("latin1")


def test_normalize_rejects_mapping_json_that_is_not_an_object(client: TestClient):
    content = build_import_result_xlsx(headers=["Message"], rows=[["Rejected"]])

    response = client.post(
        "/api/v1/import-results/normalize",
        headers={"x-converter-service-token": SERVICE_TOKEN},
        data={"mapping_json": "[]"},
        files={"file": ("result.xlsx", content)},
    )

    assert response.status_code == 400
    assert "mapping_json" in response.json()["detail"]


def test_analyze_rejects_xlsx_external_link_before_workbook_parsing(client: TestClient):
    content = add_xlsx_external_link(
        build_import_result_xlsx(headers=["Message"], rows=[["Rejected"]])
    )

    response = client.post(
        "/api/v1/import-results/analyze",
        headers={"x-converter-service-token": SERVICE_TOKEN},
        files={"file": ("result.xlsx", content)},
    )

    assert response.status_code == 422
    assert "external links" in response.json()["detail"]


def test_analyze_rejects_xlsx_zip_expansion(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    content = add_xlsx_zip_payload(
        build_import_result_xlsx(headers=["Message"], rows=[["Rejected"]]),
        name="xl/security-padding.bin",
        payload=b"x" * 4096,
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_EXPANDED_BYTES", "1024")

    response = client.post(
        "/api/v1/import-results/analyze",
        headers={"x-converter-service-token": SERVICE_TOKEN},
        files={"file": ("result.xlsx", content)},
    )

    assert response.status_code == 422
    assert "expanded ZIP" in response.json()["detail"]


def test_normalize_uses_multipart_selected_sheet_and_header(client: TestClient):
    content = build_import_result_xlsx_sheets(
        [
            ("Summary", [["Message"], ["summary issue"]]),
            ("Details", [["Preamble"], [], ["Message"], ["detail issue"]]),
        ]
    )

    response = client.post(
        "/api/v1/import-results/normalize",
        headers={"x-converter-service-token": SERVICE_TOKEN},
        data={
            "mapping_json": json.dumps(
                {
                    "sheet_name": "Details",
                    "header_row": 3,
                    "columns": {"technical_message": "Message"},
                }
            )
        },
        files={"file": ("result.xlsx", content)},
    )

    assert response.status_code == 200
    assert response.json()["issues"][0]["artifact_row_number"] == 4
