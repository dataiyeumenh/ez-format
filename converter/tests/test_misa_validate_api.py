from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app


ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "fixtures" / "samples"
client = TestClient(app)


def _analyze_sample():
    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        response = client.post(
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
    assert response.status_code == 200
    return response.json()


def test_validate_mapping_endpoint_returns_readiness_report(monkeypatch, tmp_path):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    analyze = _analyze_sample()
    suggestion = analyze["mapping_suggestion"]

    response = client.post(
        "/api/v1/mappings/validate",
        json={
            "upload_id": analyze["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": suggestion["mapping"],
            "defaults": suggestion["defaults"],
            "formulas": suggestion["formulas"],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"ready", "needs_review"}
    assert payload["summary"]["blocker"] == 0
    assert payload["reconciliation"]["input_rows"] == 1930
    assert payload["reconciliation"]["output_rows"] == 1930


def test_export_gate_blocks_unacknowledged_warnings(monkeypatch, tmp_path):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    analyze = _analyze_sample()
    suggestion = analyze["mapping_suggestion"]
    mapping = dict(suggestion["mapping"])
    mapping["VAT"] = "% thuế GTGT"
    defaults = dict(suggestion["defaults"])
    defaults["% thuế GTGT"] = "8%"

    confirm = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": analyze["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": mapping,
            "defaults": defaults,
            "formulas": suggestion["formulas"],
        },
    )
    assert confirm.status_code == 200

    blocked = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": analyze["upload_id"],
            "profile_id": confirm.json()["profile_id"],
        },
    )
    assert blocked.status_code == 422
    assert blocked.json()["detail"]["status"] == "needs_review"

    allowed = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": analyze["upload_id"],
            "profile_id": confirm.json()["profile_id"],
            "acknowledge_warnings": True,
        },
    )
    assert allowed.status_code == 200
