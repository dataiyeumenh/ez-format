from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import openpyxl
import pytest
from fastapi.testclient import TestClient

from app.excel_io import InputTable
from app.main import app
from app.operation_store import (
    STUDENT_METADATA_STATE_CONTRACT,
    OperationStore,
    OperationStoreExpiredError,
    cleanup_expired_operation_sessions,
)


client = TestClient(app)


def _context_token(payload: dict, secret: str = "test-secret") -> str:
    def encode(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = encode({"alg": "HS256", "typ": "JWT"})
    body = encode(payload)
    signature = hmac.new(
        secret.encode("utf-8"), f"{header}.{body}".encode("ascii"), hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{body}.{encoded_signature}"


def test_production_analyze_forwards_preallocated_run_session_and_upload_bindings(
    tmp_path, monkeypatch
):
    import app.main as main_module

    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    captured = {}

    def fake_analyze_upload(**kwargs):
        captured.update(kwargs)
        return {
            "upload_id": kwargs.get("preallocated_upload_id"),
            "target_template_id": "bsn_sales",
            "session": {"session_id": kwargs["operation_session_id"]},
        }

    monkeypatch.setattr(main_module, "analyze_upload", fake_analyze_upload)
    run_id = "507f1f77bcf86cd799439011"
    session_id = "a52a3c60-df68-46e5-a6a5-4a7bb44828c5"
    upload_id = "e7270428-d19f-4fd9-bd86-1b4a5a632e0a"
    token = _context_token(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "owner_scope": "user:user-1",
            "workspace_id": None,
            "snapshot_set_hash": None,
            "conversion_run_id": run_id,
            "operation_session_id": session_id,
            "upload_id": upload_id,
                "target_template_id": "bsn_sales",
                "max_file_bytes": 20 * 1024 * 1024,
                "scopes": ["analyze"],
            "exp": int(time.time()) + 60,
        }
    )
    input_path = _workbook(tmp_path / "production.xlsx")

    with input_path.open("rb") as handle:
        response = client.post(
            "/api/v1/uploads/analyze",
            files={
                "file": (
                    "production.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            data={
                "target_template_id": "bsn_sales",
                "conversion_context_token": token,
                "conversion_run_id": run_id,
                "operation_session_id": session_id,
                "upload_id": upload_id,
            },
            headers={"x-conversion-context": token},
        )

    assert response.status_code == 200
    assert captured["conversion_run_id"] == run_id
    assert captured["operation_session_id"] == session_id
    assert captured["preallocated_upload_id"] == upload_id


def test_health_capabilities_are_fixed_booleans():
    payload = client.get("/healthz").json()

    assert payload["status"] == "ok"
    assert payload["capabilities"]["converter"] is True
    assert payload["capabilities"]["operations"] is True


def test_converter_capability_endpoint_matches_health_source_of_truth(monkeypatch):
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    monkeypatch.setenv("FEATURE_AI_EXPLANATION", "false")
    monkeypatch.setenv("RECONCILIATION_MAX_ROWS", "12345")
    monkeypatch.setenv("RECONCILIATION_MAX_COMPARISON_FILES", "2")

    health = client.get("/healthz").json()["capabilities"]
    response = client.get("/api/v1/capabilities")

    assert response.status_code == 200
    assert response.json()["anomaly_detection"] is True
    assert response.json()["ai_explanation"] is False
    assert response.json()["limits"]["max_rows_per_file"] == 12345
    assert health["converter"] is True
    assert health["operations"] is True


def test_health_never_probes_ollama_directly(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "ollama")
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Direct Ollama probe forbidden")
        ),
    )

    response = client.get("/healthz")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["capabilities"]["converter"] is True
    assert payload["capabilities"]["operations"] is True


@pytest.mark.no_converter_auth
def test_local_operation_session_requires_explicit_dev_flag(tmp_path, monkeypatch):
    monkeypatch.delenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", raising=False)
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    store = OperationStore()
    session = store.create_session(
        upload_id="local-session",
        owner_scope="local:default",
        user_id=None,
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["Mã hàng"], rows=[{"Mã hàng": "SP01"}]),
        raw_sha256="raw",
        ttl_seconds=3600,
    )

    response = client.get(
        f"/api/v1/sessions/{session.session_id}/revisions",
        headers={"x-converter-local-mode": "true"},
    )

    assert response.status_code == 401


def _create_test_operation_session(store, *, session_id=None, ttl_seconds=3600):
    return store.create_session(
        session_id=session_id,
        upload_id="student-upload",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={"hash": "source-hash"},
        table=InputTable(
            headers=["Họ tên", "CCCD"],
            rows=[{"Họ tên": "Nguyễn Văn An", "CCCD": "079203001234"}],
        ),
        raw_sha256="raw-hash",
        conversion_run_id=(f"student:{session_id}" if session_id else None),
        ttl_seconds=ttl_seconds,
        state_contract=(STUDENT_METADATA_STATE_CONTRACT if session_id else None),
    )


def test_expired_local_operation_session_rejects_and_purges_raw_table(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("OPERATION_STORE_ALLOW_LOCAL", "true")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "converter-service-secret")
    store = OperationStore(root=tmp_path / "sessions")
    session = _create_test_operation_session(store, ttl_seconds=-1)
    session_dir = store.root / session.session_id
    assert (session_dir / "table.json").is_file()

    with pytest.raises(OperationStoreExpiredError):
        store.load_session(session.session_id)

    assert not session_dir.exists()


def test_student_metadata_cache_rejects_expiry_and_purges_local_raw_state(
    tmp_path,
):
    session_id = "student-session-expired"

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id

        @staticmethod
        def put_state(**payload):
            return {"session": {"revision": payload["revision"]}}

    store = OperationStore(root=tmp_path / "sessions", remote_client=RemoteStore())
    session = _create_test_operation_session(
        store,
        session_id=session_id,
        ttl_seconds=-1,
    )
    session_dir = store.root / session.session_id
    assert (session_dir / "table.json").is_file()

    with pytest.raises(OperationStoreExpiredError):
        store.load_session(session.session_id)

    assert not session_dir.exists()
    assert session.session_id not in store._remote_payloads


def test_student_metadata_operation_session_survives_process_restart(
    tmp_path,
):
    session_id = "student-session-restart"
    captured = {}

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id

        @staticmethod
        def put_state(**payload):
            captured.update(payload)
            return {"session": {"revision": payload["revision"]}}

        @staticmethod
        def get_state(**_payload):
            return {
                "state": captured["state"],
                "session": {"revision": captured["revision"]},
            }

    root = tmp_path / "sessions"
    first_store = OperationStore(
        root=root,
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    created = _create_test_operation_session(
        first_store,
        session_id=session_id,
    )

    restarted_store = OperationStore(
        root=root,
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    materialized = restarted_store.materialize_table(created.session_id)

    assert materialized.headers == ["Họ tên", "CCCD"]
    assert materialized.rows == [
        {"Họ tên": "Nguyễn Văn An", "CCCD": "079203001234"}
    ]
    assert "table" not in captured["state"]
    assert "table_metadata" in captured["state"]


def test_operation_session_sweeper_is_bounded_and_restart_safe(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("OPERATION_STORE_ALLOW_LOCAL", "true")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "converter-service-secret")
    store = OperationStore(root=tmp_path / "sessions")
    expired = [
        _create_test_operation_session(store, ttl_seconds=-1),
        _create_test_operation_session(store, ttl_seconds=-1),
    ]

    first = cleanup_expired_operation_sessions(
        root=store.root,
        now=datetime.now(timezone.utc),
        batch_size=1,
    )
    assert len(first) == 1
    assert sum((store.root / item.session_id).exists() for item in expired) == 1

    second = cleanup_expired_operation_sessions(
        root=store.root,
        now=datetime.now(timezone.utc),
        batch_size=1,
    )
    assert len(second) == 1
    assert all(not (store.root / item.session_id).exists() for item in expired)


def test_operation_session_sweeper_preserves_in_flight_creation_without_session_json(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("OPERATION_STORE_ALLOW_LOCAL", "true")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "converter-service-secret")
    store = OperationStore(root=tmp_path / "sessions")
    write_started = threading.Event()
    release_write = threading.Event()
    result = {}
    original_atomic_write = store._atomic_write

    def interleaved_atomic_write(path, payload):
        if path.name == "table.json":
            write_started.set()
            assert release_write.wait(2)
        return original_atomic_write(path, payload)

    store._atomic_write = interleaved_atomic_write

    def create():
        result["session"] = _create_test_operation_session(store)

    creator = threading.Thread(target=create, daemon=True)
    creator.start()
    assert write_started.wait(2)
    in_flight_dir = next(path for path in store.root.iterdir() if path.is_dir())

    deleted = cleanup_expired_operation_sessions(
        root=store.root,
        now=datetime.now(timezone.utc),
        batch_size=1,
    )

    assert deleted == []
    assert in_flight_dir.is_dir()
    release_write.set()
    creator.join(2)
    assert not creator.is_alive()
    assert (in_flight_dir / "session.json").is_file()
    assert not (in_flight_dir / ".creating.json").exists()


def test_student_startup_cleanup_wires_operation_session_sweeper(monkeypatch):
    import app.main as main_module

    calls = []
    monkeypatch.setattr(
        main_module,
        "cleanup_expired_student_uploads",
        lambda: calls.append("student-uploads"),
    )
    monkeypatch.setattr(
        main_module,
        "cleanup_expired_uploads",
        lambda: calls.append("converter-uploads"),
    )
    monkeypatch.setattr(
        main_module,
        "cleanup_expired_operation_sessions",
        lambda: calls.append("operation-sessions"),
    )

    main_module._opportunistic_student_cleanup(force=True)

    assert calls == [
        "student-uploads",
        "converter-uploads",
        "operation-sessions",
    ]


def _workbook(path):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Data"
    sheet.append(["Mã hóa đơn", "Thời gian", "Tên khách hàng", "Mã hàng", "Số lượng", "Đơn giá"])
    sheet.append(["HD001", "2026-07-01", "Khách A", "SP001", 2, 50000])
    workbook.save(path)
    return path


def test_personal_conversion_context_owns_session_without_workspace(
    tmp_path, monkeypatch
):
    import app.misa_workflow as workflow

    monkeypatch.delenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", raising=False)
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "mapping.sqlite"))
    monkeypatch.setenv("FEATURE_MAPPING_PROFILE_V2", "false")
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setattr(
        workflow,
        "fetch_master_data_context",
        lambda _token: (_ for _ in ()).throw(
            AssertionError("Personal context must not request workspace master data")
        ),
    )
    token = _context_token(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "owner_scope": "user:user-1",
            "workspace_id": None,
            "snapshot_set_hash": None,
            "conversion_run_id": "run-1",
            "target_template_id": "bsn_sales",
            "scopes": ["analyze", "preview", "readiness", "confirm", "export"],
            "max_file_bytes": 20 * 1024 * 1024,
            "exp": int(time.time()) + 60,
        }
    )
    input_path = _workbook(tmp_path / "raw.xlsx")

    with input_path.open("rb") as handle:
        analyzed = client.post(
            "/api/v1/uploads/analyze",
            files={
                "file": (
                    "raw.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            data={
                "target_template_id": "bsn_sales",
                "conversion_context_token": token,
            },
            headers={"x-conversion-context": token},
        )

    assert analyzed.status_code == 200
    analyzed_payload = analyzed.json()
    session_id = analyzed_payload["session"]["session_id"]
    assert OperationStore().load_session(session_id).owner_scope == "user:user-1"
    assert OperationStore().active_context(session_id)["conversion_run_id"] == "run-1"
    session_token = _context_token(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "owner_scope": "user:user-1",
            "workspace_id": None,
            "snapshot_set_hash": None,
            "conversion_run_id": "run-1",
            "operation_session_id": session_id,
            "upload_id": analyzed_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "scopes": ["preview"],
            "exp": int(time.time()) + 60,
        }
    )
    revisions = client.get(
        f"/api/v1/sessions/{session_id}/revisions",
        headers={"X-Conversion-Context": session_token},
    )
    assert revisions.status_code == 200


def test_analyze_creates_parse_once_session_used_by_preview_and_readiness(
    tmp_path, monkeypatch
):
    import app.misa_workflow as workflow

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "mapping.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    calls = 0
    original = workflow.read_input_table

    def counted(path):
        nonlocal calls
        calls += 1
        return original(path)

    monkeypatch.setattr(workflow, "read_input_table", counted)
    input_path = _workbook(tmp_path / "raw.xlsx")
    with input_path.open("rb") as handle:
        analyzed = client.post(
            "/api/v1/uploads/analyze",
            files={"file": ("raw.xlsx", handle, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            data={"target_template_id": "bsn_sales"},
        )

    assert analyzed.status_code == 200
    payload = analyzed.json()
    session = payload["session"]
    request = {
        "upload_id": payload["upload_id"],
        "session_id": session["session_id"],
        "revision": session["active_revision"],
        "state_hash": session["state_hash"],
        "target_template_id": payload["target_template_id"],
        "mapping": payload["mapping_suggestion"]["mapping"],
        "defaults": payload["mapping_suggestion"]["defaults"],
        "formulas": payload["mapping_suggestion"]["formulas"],
    }

    preview = client.post("/api/v1/mappings/preview", json=request)
    readiness = client.post("/api/v1/mappings/validate", json=request)

    assert preview.status_code == 200
    assert readiness.status_code == 200
    assert calls == 1


def test_mapping_session_sync_creates_one_idempotent_context_revision(
    tmp_path, monkeypatch
):
    import app.misa_workflow as workflow

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "mapping.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    input_path = _workbook(tmp_path / "raw.xlsx")
    with input_path.open("rb") as handle:
        analyzed = client.post(
            "/api/v1/uploads/analyze",
            files={
                "file": (
                    "raw.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            data={"target_template_id": "bsn_sales"},
        ).json()

    session = analyzed["session"]
    payload = {
        "upload_id": analyzed["upload_id"],
        "target_template_id": analyzed["target_template_id"],
        "mapping": {
            **analyzed["mapping_suggestion"]["mapping"],
            "Nguồn mới": "Địa chỉ",
        },
        "defaults": analyzed["mapping_suggestion"]["defaults"],
        "formulas": analyzed["mapping_suggestion"]["formulas"],
        "session_id": session["session_id"],
        "revision": session["active_revision"],
        "state_hash": session["state_hash"],
    }

    first = client.post("/api/v1/mappings/session", json=payload)

    assert first.status_code == 200
    first_payload = first.json()
    assert first_payload["changed"] is True
    assert first_payload["session"]["active_revision"] == 2
    active = OperationStore().active_context(session["session_id"])
    assert active["mapping"]["Nguồn mới"] == "Địa chỉ"

    current_payload = {
        **payload,
        "revision": first_payload["session"]["active_revision"],
        "state_hash": first_payload["session"]["state_hash"],
    }
    second = client.post("/api/v1/mappings/session", json=current_payload)

    assert second.status_code == 200
    assert second.json()["changed"] is False
    assert second.json()["session"]["active_revision"] == 2
    assert client.post("/api/v1/mappings/session", json=payload).status_code == 409


def test_preview_rejects_stale_revision_with_409(tmp_path, monkeypatch):
    import app.misa_workflow as workflow

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    input_path = _workbook(tmp_path / "raw.xlsx")
    with input_path.open("rb") as handle:
        payload = client.post(
            "/api/v1/uploads/analyze",
            files={"file": ("raw.xlsx", handle, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            data={"target_template_id": "bsn_sales"},
        ).json()
    session = payload["session"]
    store = OperationStore()
    store.create_revision(
        session["session_id"],
        expected_revision=session["active_revision"],
        expected_state_hash=session["state_hash"],
        changes={"r1": {"Tên khách hàng": "Khách B"}},
        created_by="local:default",
        activate=True,
    )

    response = client.post(
        "/api/v1/mappings/preview",
        json={
            "upload_id": payload["upload_id"],
            "session_id": session["session_id"],
            "revision": session["active_revision"],
            "state_hash": session["state_hash"],
            "target_template_id": payload["target_template_id"],
            "mapping": payload["mapping_suggestion"]["mapping"],
        },
    )

    assert response.status_code == 409


def test_operation_feature_routes_use_session_revision_contract(tmp_path, monkeypatch):
    import app.misa_workflow as workflow

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    monkeypatch.setenv("FEATURE_RECONCILIATION", "true")
    monkeypatch.setenv("FEATURE_ACCOUNTING_ASSISTANT", "true")
    input_path = _workbook(tmp_path / "raw.xlsx")
    with input_path.open("rb") as handle:
        analyzed = client.post(
            "/api/v1/uploads/analyze",
            files={"file": ("raw.xlsx", handle, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            data={"target_template_id": "bsn_sales"},
        ).json()
    session = analyzed["session"]
    session_id = session["session_id"]
    state = {"revision": session["active_revision"], "state_hash": session["state_hash"]}

    assert client.get(f"/api/v1/sessions/{session_id}/revisions").status_code == 200
    assert client.post(
        f"/api/v1/sessions/{session_id}/anomalies/detect", json=state
    ).status_code == 200
    assert client.post(
        f"/api/v1/sessions/{session_id}/corrections/propose", json=state
    ).status_code == 200
    reconciliation = client.post(
        f"/api/v1/sessions/{session_id}/reconciliation/run", json=state
    )
    assert reconciliation.status_code == 200
    assert reconciliation.json()["status"] == "not_run"
    answer = client.post(
        f"/api/v1/sessions/{session_id}/questions",
        json={**state, "question": "File này có bao nhiêu dòng?"},
    )
    assert answer.status_code == 200
    assert answer.json()["answer_type"] == "deterministic"


def test_session_readiness_ignores_client_rows_instead_of_breaking_preview_flow(
    tmp_path, monkeypatch
):
    import app.misa_workflow as workflow

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    input_path = _workbook(tmp_path / "raw.xlsx")
    with input_path.open("rb") as handle:
        analyzed = client.post(
            "/api/v1/uploads/analyze",
            files={"file": ("raw.xlsx", handle, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            data={"target_template_id": "bsn_sales"},
        ).json()
    session = analyzed["session"]

    response = client.post(
        "/api/v1/mappings/validate",
        json={
            "upload_id": analyzed["upload_id"],
            "session_id": session["session_id"],
            "revision": session["active_revision"],
            "state_hash": session["state_hash"],
            "target_template_id": analyzed["target_template_id"],
            "mapping": analyzed["mapping_suggestion"]["mapping"],
            "defaults": analyzed["mapping_suggestion"]["defaults"],
            "formulas": analyzed["mapping_suggestion"]["formulas"],
            "rows": [{"Số chứng từ (*)": "FORGED-CLIENT-ROW"}],
        },
    )

    assert response.status_code == 200
    assert "FORGED-CLIENT-ROW" not in response.text


def test_session_export_uses_active_revision_without_client_rows(tmp_path, monkeypatch):
    import app.misa_workflow as workflow

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    captured = {}
    profiles = {}

    def fake_save_profile(_token, **kwargs):
        profile = SimpleNamespace(
            id="profile-1",
            owner_scope="user:pytest-user",
            target_template_id=kwargs["target_template_id"],
            mapping=kwargs["mapping"],
            defaults=kwargs["defaults"],
            formulas=kwargs["formulas"],
        )
        profiles[profile.id] = profile
        return profile

    def fake_write(_template, rows, output_path):
        captured["rows"] = rows
        output_path.write_bytes(b"xls")

    monkeypatch.setattr(workflow, "write_xls_from_template", fake_write)
    monkeypatch.setattr(workflow, "save_mapping_profile", fake_save_profile)
    monkeypatch.setattr(
        workflow,
        "get_mapping_profile",
        lambda _token, profile_id: profiles[profile_id],
    )
    monkeypatch.setattr(workflow, "mark_mapping_profile_used", lambda *_args: None)
    monkeypatch.setattr(
        workflow,
        "resolve_master_data",
        lambda rows, *_args, **_kwargs: SimpleNamespace(rows=rows, resolutions=[]),
    )
    monkeypatch.setattr(
        workflow,
        "build_readiness_report",
        lambda *_args, **_kwargs: SimpleNamespace(
            summary=SimpleNamespace(blocker=0, warning=0)
        ),
    )
    monkeypatch.setattr(workflow, "add_master_data_resolutions", lambda report, *_a, **_k: report)
    input_path = _workbook(tmp_path / "raw.xlsx")
    with input_path.open("rb") as handle:
        analyzed = client.post(
            "/api/v1/uploads/analyze",
            files={"file": ("raw.xlsx", handle, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            data={"target_template_id": "bsn_sales"},
        ).json()
    session = analyzed["session"]
    confirm_response = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": analyzed["upload_id"],
            "session_id": session["session_id"],
            "revision": session["active_revision"],
            "state_hash": session["state_hash"],
            "target_template_id": analyzed["target_template_id"],
            "mapping": analyzed["mapping_suggestion"]["mapping"],
            "defaults": analyzed["mapping_suggestion"]["defaults"],
            "formulas": analyzed["mapping_suggestion"]["formulas"],
        },
    )
    assert confirm_response.status_code == 200, confirm_response.text
    confirm = confirm_response.json()
    active = confirm["session"]
    missing_state = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": analyzed["upload_id"],
            "profile_id": confirm["profile_id"],
            "session_id": active["session_id"],
            "revision": None,
            "state_hash": None,
            "acknowledge_warnings": True,
        },
    )
    assert missing_state.status_code == 409
    store = OperationStore()
    derived = store.create_revision(
        active["session_id"],
        expected_revision=active["active_revision"],
        expected_state_hash=active["state_hash"],
        changes={"r1": {"Tên khách hàng": "REVISION-VALUE"}},
        created_by="local:default",
        activate=True,
    )

    response = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": analyzed["upload_id"],
            "profile_id": confirm["profile_id"],
            "session_id": active["session_id"],
            "revision": derived.revision,
            "state_hash": derived.state_hash,
            "acknowledge_warnings": True,
        },
    )

    assert response.status_code == 200
    assert any("REVISION-VALUE" in str(row) for row in captured["rows"])


@pytest.mark.local_converter_operation
def test_correction_undo_endpoint_reactivates_parent_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore()
    session = store.create_session(
        upload_id="undo-api",
        owner_scope="local:default",
        user_id=None,
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="v1",
        source_signature={},
        table=InputTable(
            headers=["Tên nhà cung cấp"],
            rows=[{"Tên nhà cung cấp": "  Công ty A  "}],
        ),
        raw_sha256="raw-undo",
        ttl_seconds=3600,
    )

    proposal_response = client.post(
        f"/api/v1/sessions/{session.session_id}/corrections/propose",
        json={"revision": 1, "state_hash": session.state_hash},
    )
    assert proposal_response.status_code == 200
    proposal = proposal_response.json()
    patch_id = proposal["patches"][0]["patch_id"]
    apply_response = client.post(
        f"/api/v1/sessions/{session.session_id}/corrections/apply",
        headers={"Idempotency-Key": "undo-api-apply"},
        json={
            "patch_set_id": proposal["patch_set_id"],
            "revision": 1,
            "state_hash": session.state_hash,
            "selected_patch_ids": [patch_id],
        },
    )
    assert apply_response.status_code == 200
    applied = apply_response.json()
    undo_response = client.post(
        f"/api/v1/sessions/{session.session_id}/corrections/undo",
        headers={"Idempotency-Key": "undo-api-1"},
        json={
            "patch_set_id": proposal["patch_set_id"],
            "revision": applied["revision"],
            "state_hash": applied["state_hash"],
        },
    )

    assert undo_response.status_code == 200
    assert undo_response.json()["revision"] == 1
    assert store.load_session(session.session_id).active_revision == 1


def test_analyze_never_calls_ai_even_when_legacy_use_ai_flag_is_sent(tmp_path, monkeypatch):
    import app.misa_workflow as workflow

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "mapping-ai.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv("AI_ALWAYS_SUGGEST", "true")
    monkeypatch.setattr(
        "app.ai_mapping_client.request_mapping_suggestion",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("AI must not run in analyze")
        ),
    )
    input_path = _workbook(tmp_path / "raw.xlsx")

    with input_path.open("rb") as handle:
        response = client.post(
            "/api/v1/uploads/analyze",
            files={"file": ("raw.xlsx", handle, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            data={"target_template_id": "bsn_sales", "use_ai": "true"},
        )

    assert response.status_code == 200
    assert response.json()["mapping_suggestion"]["source"] != "ai"
