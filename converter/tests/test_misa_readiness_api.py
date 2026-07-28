from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.operation_store import OperationStore


ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "fixtures" / "samples"
client = TestClient(app)


def _analyze_confirm_sales(tmp_path, monkeypatch) -> dict:
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
    payload = analyze.json()
    suggestion = payload["mapping_suggestion"]
    approved_defaults = {
        **suggestion["defaults"],
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
    }

    confirm = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": payload["upload_id"],
            "target_template_id": payload["target_template_id"],
            "mapping": suggestion["mapping"],
            "defaults": approved_defaults,
            "formulas": suggestion["formulas"],
            "profile_name": "Readiness test",
        },
    )
    assert confirm.status_code == 200
    return {
        "upload_id": payload["upload_id"],
        "profile_id": confirm.json()["profile_id"],
        "session": confirm.json()["session"],
        "suggestion": suggestion,
    }


def _revise_item_value(context: dict, value: str):
    source_field = next(
        source
        for source, target in context["suggestion"]["mapping"].items()
        if target == "Mã hàng (*)"
        or (isinstance(target, list) and "Mã hàng (*)" in target)
    )
    name_field = next(
        source
        for source, target in context["suggestion"]["mapping"].items()
        if target == "Tên hàng"
    )
    session = context["session"]
    return OperationStore().create_revision(
        session["session_id"],
        expected_revision=session["active_revision"],
        expected_state_hash=session["state_hash"],
        changes={"r1": {source_field: value, name_field: value}},
        created_by="user:pytest-user",
        activate=True,
    )


def _operation_body(context: dict, revision) -> dict:
    suggestion = context["suggestion"]
    return {
        "upload_id": context["upload_id"],
        "target_template_id": "bsn_sales",
        "session_id": context["session"]["session_id"],
        "revision": revision.revision,
        "state_hash": revision.state_hash,
        "conversion_run_id": "pytest-run-1",
        "mapping": suggestion["mapping"],
        "defaults": suggestion["defaults"],
        "formulas": suggestion["formulas"],
    }


def _valid_sales_row(**overrides):
    row = {
        "Hình thức bán hàng": "Bán hàng hóa trong nước",
        "Phương thức thanh toán": "Chưa thu tiền",
        "Ngày hạch toán (*)": "01/01/2026",
        "Ngày chứng từ (*)": "01/01/2026",
        "Số chứng từ (*)": "HD001",
        "Mã hàng (*)": "SP01",
        "Tên hàng": "Hàng test",
        "TK Tiền/Chi phí/Nợ (*)": "131",
        "TK Doanh thu/Có (*)": "5111",
        "Số lượng": 2,
        "Đơn giá": 1000,
        "Thành tiền": 2000,
    }
    row.update(overrides)
    return row


def test_readiness_api_returns_blocker_for_blank_required_value(tmp_path, monkeypatch):
    context = _analyze_confirm_sales(tmp_path, monkeypatch)
    revision = _revise_item_value(context, "")

    response = client.post(
        "/api/v1/mappings/readiness",
        json=_operation_body(context, revision),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "blocked"
    assert any(issue["code"] == "required_value_blank" for issue in payload["issues"])


def test_export_blocks_when_readiness_has_blocker(tmp_path, monkeypatch):
    context = _analyze_confirm_sales(tmp_path, monkeypatch)
    revision = _revise_item_value(context, "")

    response = client.post(
        "/api/v1/conversions/export",
        json={
            **_operation_body(context, revision),
            "profile_id": context["profile_id"],
            "acknowledge_warnings": True,
        },
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["status"] == "blocked"
    assert any(issue["code"] == "required_value_blank" for issue in payload["issues"])


def test_export_blocks_warning_without_acknowledgement(tmp_path, monkeypatch):
    context = _analyze_confirm_sales(tmp_path, monkeypatch)
    revision = _revise_item_value(context, "Hàng test")

    response = client.post(
        "/api/v1/conversions/export",
        json={
            **_operation_body(context, revision),
            "profile_id": context["profile_id"],
        },
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["status"] == "needs_review", [
        (issue.get("code"), issue.get("field"), issue.get("row"))
        for issue in payload["issues"]
        if issue.get("severity") == "blocker"
    ][:20]
    assert any(issue["code"] == "master_data_review_required" for issue in payload["issues"]), [
        (issue.get("code"), issue.get("severity"), issue.get("message"))
        for issue in payload["issues"]
    ]


def test_export_allows_warning_when_acknowledged(tmp_path, monkeypatch):
    context = _analyze_confirm_sales(tmp_path, monkeypatch)
    revision = _revise_item_value(context, "Hàng test")

    response = client.post(
        "/api/v1/conversions/export",
        json={
            **_operation_body(context, revision),
            "profile_id": context["profile_id"],
            "acknowledge_warnings": True,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/vnd.ms-excel")
