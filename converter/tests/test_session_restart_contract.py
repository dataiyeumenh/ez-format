from __future__ import annotations

import copy
import base64
import hashlib
import hmac
import json
import time
from io import BytesIO
from datetime import datetime, timedelta, timezone

import httpx
import openpyxl
import pytest
from fastapi.testclient import TestClient

from app.excel_io import InputTable
from app.main import app
from app.master_data_client import ConversionContextError
from app.operation_store import OperationStore, OperationStoreError
from app.operation_store_client import NodeOperationStoreClient, OperationStoreClientError


class MemoryOperationStoreClient:
    """Node API stand-in: durable state exists independently of converter disk."""

    def __init__(self) -> None:
        self.states: dict[tuple[str, str], dict] = {}
        self.artifacts: dict[tuple[str, str, str, int], dict] = {}
        self.session_id = "preallocated-session"
        self.run_id = "run-1"

    def put_state(
        self,
        *,
        session_id: str,
        run_id: str,
        revision: int,
        state: dict,
        expires_at: datetime,
    ) -> dict:
        key = (session_id, run_id)
        previous = self.states.get(key)
        if previous and revision != previous["revision"] + 1:
            raise AssertionError("remote state revision must advance")
        self.states[key] = {
            "revision": revision,
            "state": copy.deepcopy(state),
            "expires_at": expires_at,
        }
        return {"session": {"revision": revision}}

    def get_state(self, *, session_id: str, run_id: str) -> dict:
        stored = self.states[(session_id, run_id)]
        return {"session": {"revision": stored["revision"]}, "state": copy.deepcopy(stored["state"])}

    def put_artifact(
        self,
        *,
        session_id: str,
        run_id: str,
        kind: str,
        revision: int,
        content: bytes,
        content_type: str,
        expires_at: datetime,
    ) -> dict:
        self.artifacts[(session_id, run_id, kind, revision)] = {
            "content": bytes(content),
            "content_type": content_type,
            "expires_at": expires_at,
        }
        return {"artifact": {"revision": revision}}

    def get_artifact(
        self,
        *,
        session_id: str,
        run_id: str,
        kind: str,
        revision: int | None = None,
    ) -> bytes:
        candidates = [
            (key, value)
            for key, value in self.artifacts.items()
            if key[:3] == (session_id, run_id, kind)
            and (revision is None or key[3] == revision)
        ]
        if not candidates:
            raise OperationStoreClientError(
                "Artifact was not found", status_code=404, code="ARTIFACT_NOT_FOUND"
            )
        key, stored = max(candidates, key=lambda item: item[0][3])
        if stored["expires_at"] <= datetime.now(timezone.utc):
            raise OperationStoreClientError(
                "Artifact has expired", status_code=410, code="ARTIFACT_EXPIRED"
            )
        return bytes(stored["content"])


def _table() -> InputTable:
    return InputTable(
        headers=["So hoa don", "Thanh tien"],
        rows=[{"So hoa don": "HD001", "Thanh tien": "1000"}],
        sheet_name="Data",
        header_row_index=1,
    )


def _context_token(
    *,
    session_id: str = "preallocated-session",
    upload_id: str = "",
    scopes: list[str] | None = None,
    expires_in: int = 300,
) -> str:
    def encode(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = encode({"alg": "HS256", "typ": "JWT"})
    body = encode(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "owner_scope": "user:user-1",
            "workspace_id": None,
            "snapshot_set_hash": None,
            "conversion_context_id": "context-1",
            "conversion_run_id": "run-1",
            "operation_session_id": session_id,
            "upload_id": upload_id,
            "target_template_id": "bsn_sales",
            "scopes": scopes or ["analyze"],
            "max_file_bytes": 20 * 1024 * 1024,
            "exp": int(time.time()) + expires_in,
        }
    )
    signature = hmac.new(
        b"restart-secret", f"{header}.{body}".encode("ascii"), hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{body}.{encoded_signature}"


def _workbook_bytes() -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Data"
    sheet.append(
        ["Mã hóa đơn", "Thời gian", "Tên khách hàng", "Mã hàng", "Số lượng", "Đơn giá"]
    )
    sheet.append(["HD001", "01/07/2026", "Khách A", "SP001", 2, 50000])
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_analyze_persists_preallocated_session_before_response_and_immediate_restart(
    tmp_path, monkeypatch
):
    import app.misa_workflow as workflow
    import app.operation_store as store_module

    remote = MemoryOperationStoreClient()
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "restart-secret")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "first-process"))
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "mapping.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setattr(workflow, "find_mapping_profile", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(store_module, "NodeOperationStoreClient", lambda _token: remote)

    result = workflow.analyze_upload(
        filename="input.xlsx",
        content=_workbook_bytes(),
        requested_target_template_id="bsn_sales",
        conversion_context_token=_context_token(),
        operation_session_id="preallocated-session",
        conversion_run_id="run-1",
    )

    assert result["session"]["session_id"] == "preallocated-session"
    assert ("preallocated-session", "run-1") in remote.states
    assert not (tmp_path / "first-process" / "preallocated-session").exists()

    restarted = OperationStore(
        tmp_path / "second-process",
        remote_client=remote,
        conversion_run_id="run-1",
        conversion_context_token=_context_token(),
    )
    session = restarted.load_session("preallocated-session")
    assert session.active_revision == 1
    assert restarted.materialize_table("preallocated-session").rows[0]["Mã hóa đơn"] == "HD001"


def test_remote_create_rejects_preallocated_session_mismatch(tmp_path):
    remote = MemoryOperationStoreClient()
    store = OperationStore(
        tmp_path, remote_client=remote, conversion_run_id="run-1"
    )

    with pytest.raises(OperationStoreError, match="binding"):
        store.create_session(
            session_id="foreign-session",
            upload_id="upload-1",
            owner_scope="user:user-1",
            user_id="user-1",
            workspace_id=None,
            target_template_id="bsn_sales",
            target_template_version="template-sha",
            source_signature={"hash": "source-sha"},
            table=_table(),
            raw_sha256=hashlib.sha256(b"workbook").hexdigest(),
            conversion_run_id="run-1",
            ttl_seconds=3600,
        )


def test_node_mode_never_falls_back_to_stale_local_session(tmp_path):
    local = OperationStore(tmp_path, conversion_run_id="run-1")
    session = local.create_session(
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="template-sha",
        source_signature={"hash": "source-sha"},
        table=_table(),
        raw_sha256=hashlib.sha256(b"workbook").hexdigest(),
        conversion_run_id="run-1",
        ttl_seconds=3600,
    )

    class MissingRemoteClient:
        session_id = session.session_id
        run_id = "run-1"

        def get_state(self, **_kwargs):
            raise OperationStoreClientError(
                "Session was not found", status_code=404, code="ARTIFACT_NOT_FOUND"
            )

    with pytest.raises(OperationStoreError, match="Session not found"):
        OperationStore(
            tmp_path,
            remote_client=MissingRemoteClient(),
            conversion_run_id="run-1",
        ).load_session(session.session_id)


def test_preview_export_resumes_after_converter_process_restart(tmp_path):
    client = MemoryOperationStoreClient()
    first = OperationStore(
        tmp_path / "first", remote_client=client, conversion_run_id="run-1"
    )
    session = first.create_session(
        session_id="preallocated-session",
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="template-sha",
        source_signature={"hash": "source-sha"},
        table=_table(),
        raw_sha256=hashlib.sha256(b"workbook").hexdigest(),
        conversion_run_id="run-1",
        ttl_seconds=3600,
    )

    # A fresh process has no prior converter directory, only Node-backed state.
    restarted = OperationStore(
        tmp_path / "second", remote_client=client, conversion_run_id="run-1"
    )

    loaded = restarted.assert_current(
        session.session_id,
        expected_revision=session.active_revision,
        expected_state_hash=session.state_hash,
    )
    assert loaded.session_id == session.session_id
    assert restarted.materialize_table(session.session_id) == _table()
    assert not (tmp_path / "second" / session.session_id).exists()


def test_mapping_api_resumes_full_workflow_across_fresh_converter_instances(
    tmp_path, monkeypatch
):
    import app.misa_workflow as workflow
    import app.operation_store as store_module

    remote = MemoryOperationStoreClient()
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "restart-secret")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "mapping.sqlite"))
    monkeypatch.setenv("FEATURE_MAPPING_PROFILE_V2", "false")
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    monkeypatch.setattr(workflow, "find_mapping_profile", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(store_module, "NodeOperationStoreClient", lambda _token: remote)

    client = TestClient(app)
    analyze_token = _context_token()
    workbook_content = _workbook_bytes()
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "instance-a" / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "instance-a" / "sessions"))
    analyzed = client.post(
        "/api/v1/uploads/analyze",
        files={
            "file": (
                "input.xlsx",
                workbook_content,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
        data={
            "target_template_id": "bsn_sales",
            "conversion_run_id": "run-1",
            "operation_session_id": "preallocated-session",
        },
        headers={"x-conversion-context": analyze_token},
    )

    assert analyzed.status_code == 200, analyzed.text
    analysis = analyzed.json()
    upload_id = analysis["upload_id"]
    session = analysis["session"]
    assert remote.artifacts[("preallocated-session", "run-1", "upload", 1)][
        "content"
    ] == workbook_content

    bound_token = _context_token(
        upload_id=upload_id,
        scopes=["preview", "readiness", "confirm", "export"],
    )
    payload = {
        "upload_id": upload_id,
        "target_template_id": "bsn_sales",
        "mapping": analysis["mapping_suggestion"]["mapping"],
        "defaults": {
            **analysis["mapping_suggestion"]["defaults"],
            "TK Tiền/Chi phí/Nợ (*)": "131",
            "TK Doanh thu/Có (*)": "5111",
        },
        "formulas": analysis["mapping_suggestion"]["formulas"],
        "session_id": "preallocated-session",
        "revision": session["active_revision"],
        "state_hash": session["state_hash"],
        "conversion_run_id": "run-1",
    }

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "instance-b" / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "instance-b" / "sessions"))
    preview = client.post(
        "/api/v1/mappings/preview",
        json=payload,
        headers={"x-conversion-context": bound_token},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["stats"] == {"source_rows": 1, "output_rows": 1}
    restored_input = next((tmp_path / "instance-b" / "uploads" / upload_id).glob("input.*"))
    assert restored_input.read_bytes() == workbook_content

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "instance-c" / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "instance-c" / "sessions"))
    readiness = client.post(
        "/api/v1/mappings/readiness",
        json=payload,
        headers={"x-conversion-context": bound_token},
    )
    assert readiness.status_code == 200, readiness.text
    assert "summary" in readiness.json()

    stale = client.post(
        "/api/v1/mappings/preview",
        json={**payload, "revision": payload["revision"] + 1},
        headers={"x-conversion-context": bound_token},
    )
    assert stale.status_code == 409

    wrong_binding = client.post(
        "/api/v1/mappings/preview",
        json={**payload, "upload_id": "foreign-upload"},
        headers={"x-conversion-context": bound_token},
    )
    assert wrong_binding.status_code == 409

    forged_binding_token = _context_token(
        upload_id="foreign-upload",
        scopes=["preview"],
    )
    forged_binding = client.post(
        "/api/v1/mappings/preview",
        json={**payload, "upload_id": "foreign-upload"},
        headers={"x-conversion-context": forged_binding_token},
    )
    assert forged_binding.status_code == 404

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "instance-d" / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "instance-d" / "sessions"))
    confirmed = client.post(
        "/api/v1/mappings/confirm",
        json={**payload, "profile_name": "Restart profile"},
        headers={"x-conversion-context": bound_token},
    )
    assert confirmed.status_code == 200, confirmed.text
    confirmation = confirmed.json()
    confirmed_session = confirmation["session"]

    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "instance-e" / "uploads")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "instance-e" / "sessions"))
    exported = client.post(
        "/api/v1/conversions/export",
        json={
            **payload,
            "profile_id": confirmation["profile_id"],
            "revision": confirmed_session["active_revision"],
            "state_hash": confirmed_session["state_hash"],
            "acknowledge_warnings": True,
        },
        headers={"x-conversion-context": bound_token},
    )
    assert exported.status_code == 200, exported.text
    assert exported.content[:8] == bytes.fromhex("D0CF11E0A1B11AE1")


def test_remote_restart_rejects_tampered_state_hash(tmp_path):
    client = MemoryOperationStoreClient()
    store = OperationStore(
        tmp_path / "first", remote_client=client, conversion_run_id="run-1"
    )
    session = store.create_session(
        session_id="preallocated-session",
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="template-sha",
        source_signature={"hash": "source-sha"},
        table=_table(),
        raw_sha256=hashlib.sha256(b"workbook").hexdigest(),
        conversion_run_id="run-1",
        ttl_seconds=3600,
    )
    client.states[(session.session_id, "run-1")]["state"]["session"]["state_hash"] = "forged"

    with pytest.raises(OperationStoreError, match="state hash"):
        OperationStore(
            tmp_path / "second", remote_client=client, conversion_run_id="run-1"
        ).load_session(session.session_id)


def test_remote_restart_propagates_expired_state(tmp_path):
    client = MemoryOperationStoreClient()
    store = OperationStore(tmp_path, remote_client=client, conversion_run_id="run-1")
    session = store.create_session(
        session_id="preallocated-session",
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="template-sha",
        source_signature={"hash": "source-sha"},
        table=_table(),
        raw_sha256=hashlib.sha256(b"workbook").hexdigest(),
        conversion_run_id="run-1",
        ttl_seconds=3600,
    )
    client.states[(session.session_id, "run-1")]["state"]["session"]["expires_at"] = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()

    with pytest.raises(OperationStoreError, match="hết hạn"):
        OperationStore(
            tmp_path / "restart", remote_client=client, conversion_run_id="run-1"
        ).load_session(session.session_id)


def test_node_client_sends_bound_service_and_context_headers(monkeypatch):
    import app.operation_store_client as client_module

    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-token")
    monkeypatch.setattr(
        client_module,
        "verify_conversion_context_token",
        lambda _token: {
            "conversion_run_id": "run-1",
            "operation_session_id": "session-1",
        },
    )
    captured = {}

    def fake_request(method, url, **kwargs):
        captured.update(method=method, url=url, **kwargs)
        return httpx.Response(
            410,
            json={"error": {"message": "Artifact has expired", "code": "ARTIFACT_EXPIRED"}},
            request=httpx.Request(method, url),
        )

    monkeypatch.setattr(client_module.httpx, "request", fake_request)
    client = NodeOperationStoreClient("signed-context", base_url="https://node/api/internal")

    with pytest.raises(OperationStoreClientError) as raised:
        client.get_state(session_id="session-1", run_id="run-1")

    assert raised.value.status_code == 410
    assert raised.value.code == "ARTIFACT_EXPIRED"
    assert captured["headers"] == {
        "x-converter-service-token": "service-token",
        "x-conversion-context": "signed-context",
    }
    assert captured["url"] == "https://node/api/internal/converter-sessions/session-1/state"
    assert captured["params"] == {"run_id": "run-1"}


def test_node_client_upload_artifact_sends_no_untrusted_binding_fields(monkeypatch):
    import app.operation_store_client as client_module

    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-token")
    monkeypatch.setattr(
        client_module,
        "verify_conversion_context_token",
        lambda _token: {
            "conversion_run_id": "run-1",
            "operation_session_id": "session-1",
            "upload_id": "",
            "target_template_id": "bsn_sales",
        },
    )
    captured = {}

    def fake_request(method, url, **kwargs):
        captured.update(method=method, url=url, **kwargs)
        return httpx.Response(
            201,
            json={"success": True, "artifact": {"revision": 1}},
            request=httpx.Request(method, url),
        )

    monkeypatch.setattr(client_module.httpx, "request", fake_request)
    client = NodeOperationStoreClient("signed-context", base_url="https://node/api/internal")

    client.put_artifact(
        session_id="session-1",
        run_id="run-1",
        kind="upload",
        revision=1,
        content=b"raw workbook",
        content_type="application/vnd.ms-excel",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )

    assert captured["method"] == "PUT"
    assert captured["url"] == (
        "https://node/api/internal/converter-sessions/session-1/artifacts/upload"
    )
    assert set(captured["json"]) == {
        "run_id",
        "revision",
        "content_base64",
        "content_type",
        "expires_at",
        "sha256",
    }


def test_remote_store_preserves_foreign_owner_forbidden_status(tmp_path):
    class ForeignOwnerClient:
        def get_state(self, **_kwargs):
            raise OperationStoreClientError("Artifact belongs to another owner", status_code=403)

    with pytest.raises(ConversionContextError) as raised:
        OperationStore(
            tmp_path, remote_client=ForeignOwnerClient(), conversion_run_id="run-1"
        ).load_session("session-1")

    assert raised.value.status_code == 403
