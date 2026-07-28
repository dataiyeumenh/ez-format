import base64
import hashlib
import hmac
import json
from pathlib import Path
import time

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from app.main import app


client = TestClient(app)


def _conversion_context(secret: str) -> str:
    def encode(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = encode({"alg": "HS256", "typ": "JWT"})
    payload = encode(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "owner_scope": "user:user-1",
            "conversion_run_id": "run-1",
            "target_template_id": "bsn_sales",
            "max_file_bytes": 1024 * 1024,
            "scopes": ["analyze"],
            "exp": int(time.time()) + 60,
        }
    )
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{header}.{payload}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{payload}.{encoded_signature}"


def test_master_data_parse_endpoint(tmp_path: Path):
    path = tmp_path / "warehouses.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Mã kho", "Tên kho"])
    sheet.append(["KHO01", "Kho chính"])
    workbook.save(path)

    with path.open("rb") as handle:
        response = client.post(
            "/api/v1/master-data/parse",
            data={"catalog_type": "warehouse"},
            files={
                "file": (
                    "warehouses.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["catalog_type"] == "warehouse"
    assert payload["entries"][0]["code"] == "KHO01"


@pytest.mark.no_converter_auth
def test_master_data_parse_requires_configured_service_token(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-secret")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "context-secret")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")
    path = tmp_path / "warehouses.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Mã kho", "Tên kho"])
    sheet.append(["KHO01", "Kho chính"])
    workbook.save(path)

    with path.open("rb") as handle:
        unauthorized = client.post(
            "/api/v1/master-data/parse",
            headers={"x-converter-local-mode": "true"},
            data={"catalog_type": "warehouse"},
            files={"file": ("warehouses.xlsx", handle)},
        )
    assert unauthorized.status_code == 401

    with path.open("rb") as handle:
        context = _conversion_context("context-secret")
        authorized = client.post(
            "/api/v1/master-data/parse",
            data={"catalog_type": "warehouse"},
            files={"file": ("warehouses.xlsx", handle)},
            headers={
                "x-converter-service-token": "service-secret",
                "x-converter-local-mode": "true",
                "x-conversion-context": context,
            },
        )
    assert authorized.status_code == 200
