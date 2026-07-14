from pathlib import Path

from fastapi.testclient import TestClient
from openpyxl import Workbook

from app.main import app


client = TestClient(app)


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


def test_master_data_parse_requires_configured_service_token(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-secret")
    path = tmp_path / "warehouses.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Mã kho", "Tên kho"])
    sheet.append(["KHO01", "Kho chính"])
    workbook.save(path)

    with path.open("rb") as handle:
        unauthorized = client.post(
            "/api/v1/master-data/parse",
            data={"catalog_type": "warehouse"},
            files={"file": ("warehouses.xlsx", handle)},
        )
    assert unauthorized.status_code == 401

    with path.open("rb") as handle:
        authorized = client.post(
            "/api/v1/master-data/parse",
            data={"catalog_type": "warehouse"},
            files={"file": ("warehouses.xlsx", handle)},
            headers={"x-converter-service-token": "service-secret"},
        )
    assert authorized.status_code == 200
