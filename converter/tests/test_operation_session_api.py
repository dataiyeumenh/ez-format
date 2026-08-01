from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import openpyxl
import pytest
from fastapi.testclient import TestClient

from app.excel_io import InputTable, read_input_table
from app.main import app
from app.operation_store import (
    STUDENT_METADATA_STATE_CONTRACT,
    OperationStore,
    OperationStoreError,
    OperationStoreExpiredError,
    cleanup_expired_operation_sessions,
)
from app.operation_store_client import (
    LEGACY_NODE_JSON_MAX_BODY_BYTES,
    OperationStoreClientError,
    _artifact_max_bytes,
    _assert_legacy_node_json_body_size,
)


client = TestClient(app)
OPERATION_FENCE_SECRET = "operation-fence-test-secret-at-least-32-characters"


@pytest.fixture(autouse=True)
def _isolate_operation_fence_state(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "default-sessions"))
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", OPERATION_FENCE_SECRET)


@pytest.fixture
def _allow_uncertified_workflow_export(monkeypatch):
    import app.misa_workflow as workflow
    from app.misa_templates import get_misa_template

    monkeypatch.setattr(workflow, "get_misa_template_for_export", get_misa_template)


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
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", OPERATION_FENCE_SECRET)
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


def test_health_capabilities_are_fixed_booleans(tmp_path, monkeypatch):
    certification_dir = tmp_path / "certifications"
    certification_dir.mkdir()
    monkeypatch.setenv("MISA_TEMPLATE_CERTIFICATION_DIR", str(certification_dir))
    response = client.get("/healthz")
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "degraded"
    assert payload["misa_templates"]["status"] == "degraded"
    assert payload["capabilities"]["converter"] is True
    assert payload["capabilities"]["operations"] is True


def test_node_operation_store_client_purges_all_bound_remote_artifacts(monkeypatch):
    from app.operation_store_client import NodeOperationStoreClient

    client = object.__new__(NodeOperationStoreClient)
    client.session_id = "session-1"
    client.run_id = "student:session-1"
    captured = {}
    monkeypatch.setattr(
        client,
        "_request",
        lambda method, path, **kwargs: captured.update(
            {"method": method, "path": path, **kwargs}
        )
        or {
            "success": True,
            "session_id": "session-1",
            "run_id": "student:session-1",
            "purge_scope": "all_artifacts",
            "remaining_metadata": 0,
            "remaining_bytes": 0,
            "remote_operation_session_deleted": True,
        },
    )

    result = client.delete_session_artifacts(
        session_id="session-1",
        run_id="student:session-1",
    )

    assert captured == {
        "method": "DELETE",
        "path": "/converter-sessions/session-1/artifacts",
        "params": {"run_id": "student:session-1"},
    }
    assert result["remote_operation_session_deleted"] is True


def test_node_operation_store_client_publishes_exact_state_bytes_with_cas(monkeypatch):
    from app.operation_store_client import NodeOperationStoreClient

    node_client = object.__new__(NodeOperationStoreClient)
    node_client.session_id = "session-1"
    node_client.run_id = "run-1"
    node_client._protocol = "raw-v2"
    captured = {}
    monkeypatch.setattr(
        node_client,
        "_request",
        lambda method, path, **kwargs: captured.update(
            {"method": method, "path": path, **kwargs}
        )
        or {
            "session": {
                "revision": 5,
                "sha256": kwargs["params"]["sha256"],
            },
            "state": json.loads(kwargs["content"]),
        },
    )
    state = {
        "session": {"state_hash": "c" * 64, "label": "dữ liệu"},
        "schema_version": 1,
    }

    result = node_client.put_state(
        session_id="session-1",
        run_id="run-1",
        revision=5,
        expected_revision=4,
        expected_state_sha256="b" * 64,
        state=state,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    expected_bytes = json.dumps(
        state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    assert captured["method"] == "PUT"
    assert captured["path"] == "/converter-sessions/session-1/state"
    assert captured["content"] == expected_bytes
    assert captured["params"]["expected_revision"] == "4"
    assert captured["params"]["expected_sha256"] == "b" * 64
    assert captured["params"]["sha256"] == hashlib.sha256(expected_bytes).hexdigest()
    assert result["state"] == state


def test_node_operation_store_client_falls_back_to_legacy_json_for_old_node(monkeypatch):
    from app.operation_store_client import NodeOperationStoreClient

    node_client = object.__new__(NodeOperationStoreClient)
    node_client.session_id = "session-1"
    node_client.run_id = "run-1"
    node_client._protocol = None
    captured = {}

    def request(method, path, **kwargs):
        if path == "/converter-sessions/protocol":
            raise OperationStoreClientError("not found", status_code=404)
        captured.update({"method": method, "path": path, **kwargs})
        payload = json.loads(kwargs["content"])
        state = payload["state"]
        encoded = json.dumps(
            state, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        return {
            "state": state,
            "session": {
                "revision": payload["revision"],
                "sha256": hashlib.sha256(encoded).hexdigest(),
            },
        }

    monkeypatch.setattr(node_client, "_request", request)
    state = {
        "session": {"state_hash": "c" * 64, "label": "dữ liệu"},
        "schema_version": 1,
    }

    node_client.put_state(
        session_id="session-1",
        run_id="run-1",
        revision=2,
        expected_revision=1,
        expected_state_sha256="b" * 64,
        state=state,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    payload = json.loads(captured["content"])
    assert captured["headers"]["content-type"] == "application/json"
    assert payload["run_id"] == "run-1"
    assert payload["state"] == state
    canonical_bytes = json.dumps(
        state, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    assert list(payload["state"]) == ["schema_version", "session"]
    assert "state_base64" not in payload
    assert payload["sha256"] == hashlib.sha256(canonical_bytes).hexdigest()
    assert payload["expected_revision"] == 1
    assert payload["expected_sha256"] == "b" * 64


def test_node_operation_store_client_uses_single_canonical_base64_for_new_legacy_node(
    monkeypatch,
):
    from app.operation_store_client import NodeOperationStoreClient

    node_client = object.__new__(NodeOperationStoreClient)
    node_client.session_id = "session-1"
    node_client.run_id = "run-1"
    node_client._protocol = "legacy-json-v1"
    node_client._legacy_json_state_encoding = "base64"
    captured = {}

    def request(method, path, **kwargs):
        captured.update({"method": method, "path": path, **kwargs})
        payload = json.loads(kwargs["content"])
        content = base64.b64decode(payload["state_base64"])
        return {
            "state": json.loads(content),
            "session": {
                "revision": payload["revision"],
                "sha256": hashlib.sha256(content).hexdigest(),
            },
        }

    monkeypatch.setattr(node_client, "_request", request)
    state = {"session": {"label": "dữ liệu"}, "schema_version": 1}

    node_client.put_state(
        session_id="session-1",
        run_id="run-1",
        revision=2,
        expected_revision=1,
        expected_state_sha256="b" * 64,
        state=state,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    payload = json.loads(captured["content"])
    canonical_bytes = json.dumps(
        state, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    assert "state" not in payload
    assert base64.b64decode(payload["state_base64"]) == canonical_bytes
    assert payload["sha256"] == hashlib.sha256(canonical_bytes).hexdigest()


def test_pinned_legacy_protocol_negotiates_new_node_canonical_encoding(monkeypatch):
    from app.operation_store_client import NodeOperationStoreClient

    node_client = object.__new__(NodeOperationStoreClient)
    node_client._configured_protocol = "legacy-json-v1"
    node_client._protocol = None
    node_client._legacy_json_state_encoding = None
    node_client._legacy_json_max_body_bytes = None
    monkeypatch.setattr(
        node_client,
        "_request",
        lambda method, path: {
            "preferred": "raw-v2",
            "supported": ["raw-v2", "legacy-json-v1"],
            "legacy_json_state_encoding": "base64",
            "legacy_json_max_body_bytes": 90 * 1024 * 1024,
        },
    )

    assert node_client._operation_protocol() == "legacy-json-v1"
    assert node_client._legacy_state_encoding() == "base64"
    assert node_client._legacy_body_limit() == 90 * 1024 * 1024


def test_legacy_node_json_body_preflight_enforces_exact_50_mib_boundary():
    assert LEGACY_NODE_JSON_MAX_BODY_BYTES == 50 * 1024 * 1024
    _assert_legacy_node_json_body_size(
        b"x" * 32,
        max_body_bytes=32,
    )
    with pytest.raises(OperationStoreClientError) as error:
        _assert_legacy_node_json_body_size(
            b"x" * 33,
            max_body_bytes=32,
        )
    assert error.value.status_code == 413
    assert error.value.code == "OPERATION_PROTOCOL_SIZE_MISMATCH"


def test_node_operation_store_client_sends_legacy_base64_artifacts_to_old_node(monkeypatch):
    from app.operation_store_client import NodeOperationStoreClient

    node_client = object.__new__(NodeOperationStoreClient)
    node_client.session_id = "session-1"
    node_client.run_id = "run-1"
    node_client._protocol = None
    captured = {}

    def request(method, path, **kwargs):
        if path == "/converter-sessions/protocol":
            raise OperationStoreClientError("not found", status_code=404)
        captured.update({"method": method, "path": path, **kwargs})
        payload = json.loads(kwargs["content"])
        return {"artifact": {"revision": payload["revision"]}}

    monkeypatch.setattr(node_client, "_request", request)
    content = b"legacy artifact bytes"

    node_client.put_artifact(
        session_id="session-1",
        run_id="run-1",
        kind="upload",
        revision=1,
        content=content,
        content_type="application/octet-stream",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    payload = json.loads(captured["content"])
    assert base64.b64decode(payload["content_base64"]) == content
    assert payload["sha256"] == hashlib.sha256(content).hexdigest()


@pytest.mark.parametrize("operation", ["state", "artifact"])
def test_old_node_fallback_rejects_oversized_legacy_json_before_put(
    monkeypatch,
    operation,
):
    import app.operation_store_client as client_module
    from app.operation_store_client import NodeOperationStoreClient

    node_client = object.__new__(NodeOperationStoreClient)
    node_client.session_id = "session-1"
    node_client.run_id = "run-1"
    node_client._protocol = None
    calls = []
    monkeypatch.setattr(client_module, "LEGACY_NODE_JSON_MAX_BODY_BYTES", 256)

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == "/converter-sessions/protocol":
            raise OperationStoreClientError("not found", status_code=404)
        raise AssertionError("oversized legacy body must fail before PUT")

    monkeypatch.setattr(node_client, "_request", request)

    with pytest.raises(OperationStoreClientError) as error:
        if operation == "state":
            node_client.put_state(
                session_id="session-1",
                run_id="run-1",
                revision=2,
                expected_revision=1,
                expected_state_sha256="b" * 64,
                state={"value": "x" * 512},
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            )
        else:
            node_client.put_artifact(
                session_id="session-1",
                run_id="run-1",
                kind="upload",
                revision=1,
                content=b"x" * 512,
                content_type="application/octet-stream",
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            )

    assert error.value.status_code == 413
    assert error.value.code == "OPERATION_PROTOCOL_SIZE_MISMATCH"
    assert [path for _method, path, _kwargs in calls] == [
        "/converter-sessions/protocol"
    ]


@pytest.mark.parametrize(
    "configured",
    [
        "",
        "0",
        "-1",
        "1.5",
        "1e6",
        "0x100000",
        "+1000",
        " 1000 ",
        "1_000",
        "9007199254740992",
        "invalid",
    ],
)
def test_converter_artifact_invalid_max_bytes_uses_node_default(monkeypatch, configured):
    monkeypatch.setenv("CONVERTER_ARTIFACT_MAX_BYTES", configured)
    assert _artifact_max_bytes() == 64 * 1024 * 1024


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


def test_health_never_probes_ollama_directly(tmp_path, monkeypatch):
    certification_dir = tmp_path / "certifications"
    certification_dir.mkdir()
    monkeypatch.setenv("MISA_TEMPLATE_CERTIFICATION_DIR", str(certification_dir))
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
    assert payload["status"] == "degraded"
    assert payload["misa_templates"]["status"] == "degraded"
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


def _create_test_operation_session(
    store, *, session_id=None, ttl_seconds=3600, initial_context=None
):
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
        initial_context=initial_context,
        state_contract=(STUDENT_METADATA_STATE_CONTRACT if session_id else None),
    )


def _persisted_state_response(payload):
    encoded = json.dumps(
        payload["state"],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "state": json.loads(encoded),
        "session": {
            "revision": payload["revision"],
            "sha256": hashlib.sha256(encoded).hexdigest(),
        },
    }


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
    assert store._read_lifecycle_state(session.session_id)["status"] == "purged"


def test_student_metadata_cache_rejects_expiry_and_purges_local_raw_state(
    tmp_path,
):
    session_id = "student-session-expired"

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id
            self.payload = None
            self.expired = False

        def put_state(self, **payload):
            self.payload = payload
            return _persisted_state_response(payload)

        def get_state(self, **_payload):
            payload = dict(self.payload)
            state = json.loads(json.dumps(payload["state"]))
            if self.expired:
                state["session"]["expires_at"] = (
                    datetime.now(timezone.utc) - timedelta(seconds=1)
                ).isoformat()
            payload["state"] = state
            return _persisted_state_response(payload)

    remote = RemoteStore()
    store = OperationStore(root=tmp_path / "sessions", remote_client=remote)
    session = _create_test_operation_session(
        store,
        session_id=session_id,
    )
    session_dir = store.root / session.session_id
    assert not session_dir.exists()
    assert list(store.root.iterdir()) == []

    remote.expired = True
    with pytest.raises(OperationStoreExpiredError):
        store.load_session(session.session_id)

    assert not session_dir.exists()
    assert session.session_id not in store._remote_payloads
    assert store._read_lifecycle_state(session.session_id)["status"] == "purging"


def test_node_operation_session_full_state_survives_second_instance_without_local_state(
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
            assert payload["expected_revision"] == 0
            assert payload["expected_state_sha256"] == ""
            encoded = json.dumps(
                payload["state"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            state_sha256 = hashlib.sha256(encoded).hexdigest()
            captured.update(payload)
            captured["state_sha256"] = state_sha256
            return {
                "state": json.loads(encoded),
                "session": {
                    "revision": payload["revision"],
                    "sha256": state_sha256,
                },
            }

        @staticmethod
        def get_state(**_payload):
            return {
                "state": captured["state"],
                "session": {
                    "revision": captured["revision"],
                    "sha256": captured["state_sha256"],
                },
            }

    first_store = OperationStore(
        root=tmp_path / "first-sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    created = _create_test_operation_session(
        first_store,
        session_id=session_id,
        initial_context={
            "upload_metadata": {
                "upload_id": "student-upload",
                "filename": "student-workbook.xlsx",
                "operation_session_id": session_id,
                "target_template_id": "bsn_sales",
                "conversion_run_id": f"student:{session_id}",
                "owner_scope": "user:user-1",
                "conversion_context": {
                    "user_id": "user-1",
                    "workspace_id": "",
                    "owner_scope": "user:user-1",
                    "conversion_run_id": f"student:{session_id}",
                },
            }
        },
    )

    restarted_store = OperationStore(
        root=tmp_path / "second-sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    materialized = restarted_store.materialize_table(created.session_id)

    assert materialized.headers == ["Họ tên", "CCCD"]
    assert materialized.rows == [
        {"Họ tên": "Nguyễn Văn An", "CCCD": "079203001234"}
    ]
    assert captured["state"]["table"]["headers"] == ["Họ tên", "CCCD"]
    assert captured["state"]["contract"] == STUDENT_METADATA_STATE_CONTRACT
    assert not (first_store.root / created.session_id).exists()
    assert not (restarted_store.root / created.session_id).exists()


def test_transient_unavailable_node_state_does_not_mark_session_purging(tmp_path):
    session_id = "student-session-write-intent"

    class RemoteStore:
        run_id = "student:student-session-write-intent"
        session_id = "student-session-write-intent"

        @staticmethod
        def get_state(**_payload):
            raise OperationStoreClientError(
                "Artifact is unavailable",
                status_code=410,
                code="ARTIFACT_UNAVAILABLE",
            )

    store = OperationStore(
        root=tmp_path / "sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    store._write_lifecycle_state(session_id, "active")

    with pytest.raises(OperationStoreError, match="unavailable"):
        store.load_session(session_id)

    assert store._read_lifecycle_state(session_id)["status"] == "active"


def test_student_node_table_reader_uses_persisted_state_without_local_raw(
    tmp_path,
    monkeypatch,
):
    import app.misa_workflow as workflow

    session_id = "student-session-table-reader-restart"
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    persisted = {}

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id

        @staticmethod
        def put_state(**payload):
            persisted.update(payload)
            return _persisted_state_response(payload)

        @staticmethod
        def get_state(**_payload):
            return _persisted_state_response(persisted)

    first_store = OperationStore(
        root=tmp_path / "first-sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    created = _create_test_operation_session(
        first_store,
        session_id=session_id,
        initial_context={
            "upload_metadata": {
                "upload_id": "student-upload",
                "filename": "student-workbook.xlsx",
                "operation_session_id": session_id,
                "target_template_id": "bsn_sales",
                "conversion_run_id": f"student:{session_id}",
                "owner_scope": "user:user-1",
                "conversion_context": {
                    "user_id": "user-1",
                    "workspace_id": "",
                    "owner_scope": "user:user-1",
                    "conversion_run_id": f"student:{session_id}",
                },
            }
        },
    )
    restarted_store = OperationStore(
        root=tmp_path / "second-sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    stale_upload_dir = workflow.UPLOAD_ROOT / created.upload_id
    stale_upload_dir.mkdir(parents=True)
    stale_metadata_path = stale_upload_dir / "metadata.json"
    stale_metadata_path.write_text(
        json.dumps(
            {
                "operation_session_id": "replica-local-stale-session",
                "target_template_id": "stale-template",
                "input_path": str(stale_upload_dir / "input.xlsx"),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(workflow, "OperationStore", lambda **_kwargs: restarted_store)

    metadata = workflow._read_metadata(
        created.upload_id,
        operation_store=restarted_store,
        session=created,
    )
    table = workflow._read_upload_table(
        created.upload_id,
        conversion_context_token="unused-by-fake",
    )

    assert metadata["operation_session_id"] == created.session_id
    assert metadata["target_template_id"] == "bsn_sales"
    assert metadata["operation_revision"] == created.active_revision
    assert metadata["operation_state_hash"] == created.state_hash
    assert metadata["operation_storage_revision"] == 1
    assert len(metadata["operation_storage_sha256"]) == 64
    assert table.headers == ["Họ tên", "CCCD"]
    assert table.rows == [{"Họ tên": "Nguyễn Văn An", "CCCD": "079203001234"}]
    assert not stale_metadata_path.exists()
    assert not (first_store.root / created.session_id).exists()
    assert not (restarted_store.root / created.session_id).exists()


def test_legacy_student_metadata_state_drains_local_table_into_node(tmp_path):
    root = tmp_path / "legacy-sessions"
    local_store = OperationStore(root=root)
    created = _create_test_operation_session(local_store)
    table_payload = json.loads(
        (root / created.session_id / "table.json").read_text(encoding="utf-8")
    )
    legacy_state = {
        "schema_version": 1,
        "contract": STUDENT_METADATA_STATE_CONTRACT,
        "session": created.model_dump(mode="json"),
    }
    legacy_bytes = json.dumps(
        legacy_state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    persisted = {
        "state": legacy_state,
        "revision": 1,
        "state_sha256": hashlib.sha256(legacy_bytes).hexdigest(),
    }

    class RemoteStore:
        @staticmethod
        def get_state(**_payload):
            return {
                "state": persisted["state"],
                "session": {
                    "revision": persisted["revision"],
                    "sha256": persisted["state_sha256"],
                },
            }

        @staticmethod
        def put_state(**payload):
            assert payload["expected_revision"] == 1
            assert payload["expected_state_sha256"] == persisted["state_sha256"]
            encoded = json.dumps(
                payload["state"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            persisted.update(
                state=json.loads(encoded),
                revision=payload["revision"],
                state_sha256=hashlib.sha256(encoded).hexdigest(),
            )
            return RemoteStore.get_state()

    remote = RemoteStore()
    remote.session_id = created.session_id
    remote.run_id = f"student:{created.session_id}"

    restarted = OperationStore(
        root=root,
        remote_client=remote,
        conversion_run_id=f"student:{created.session_id}",
    )

    table = restarted.materialize_table(created.session_id)

    assert table.headers == table_payload["headers"]
    assert table.rows == [item["values"] for item in table_payload["rows"]]
    assert persisted["revision"] == 2
    assert persisted["state"]["table"] == table_payload
    assert not (root / created.session_id).exists()


def test_legacy_student_metadata_state_recovers_bound_gridfs_upload(tmp_path):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Student Data"
    sheet.append(["Họ tên", "CCCD"])
    sheet.append(["Nguyễn Văn An", "079203001234"])
    workbook_path = tmp_path / "legacy-upload.xlsx"
    workbook.save(workbook_path)
    workbook_bytes = workbook_path.read_bytes()
    table = read_input_table(workbook_path)

    root = tmp_path / "legacy-gridfs-sessions"
    local_store = OperationStore(root=root)
    created = local_store.create_session(
        upload_id="legacy-gridfs-upload",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={"hash": "legacy-gridfs"},
        table=table,
        raw_sha256=hashlib.sha256(workbook_bytes).hexdigest(),
        ttl_seconds=3600,
        initial_context={"upload_metadata": {"filename": "legacy-upload.xlsx"}},
    )
    local_store.purge_local_session_state(created.session_id)
    legacy_state = {
        "schema_version": 1,
        "contract": STUDENT_METADATA_STATE_CONTRACT,
        "session": created.model_dump(mode="json"),
    }
    legacy_bytes = json.dumps(
        legacy_state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    persisted = {
        "state": legacy_state,
        "revision": 1,
        "state_sha256": hashlib.sha256(legacy_bytes).hexdigest(),
    }

    class RemoteStore:
        @staticmethod
        def get_state(**_payload):
            return {
                "state": persisted["state"],
                "session": {
                    "revision": persisted["revision"],
                    "sha256": persisted["state_sha256"],
                },
            }

        @staticmethod
        def get_artifact(**payload):
            assert payload["kind"] == "upload"
            assert payload["session_id"] == created.session_id
            return workbook_bytes

        @staticmethod
        def put_state(**payload):
            encoded = json.dumps(
                payload["state"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            persisted.update(
                state=json.loads(encoded),
                revision=payload["revision"],
                state_sha256=hashlib.sha256(encoded).hexdigest(),
            )
            return RemoteStore.get_state()

    remote = RemoteStore()
    remote.session_id = created.session_id
    remote.run_id = f"student:{created.session_id}"
    restarted = OperationStore(
        root=root,
        remote_client=remote,
        conversion_run_id=remote.run_id,
    )

    recovered = restarted.materialize_table(created.session_id)

    assert recovered.headers == table.headers
    assert recovered.rows == table.rows
    assert persisted["revision"] == 2
    assert persisted["state"]["table"]["headers"] == table.headers


def test_legacy_student_metadata_without_durable_source_requires_operator_drain(
    tmp_path,
):
    local_store = OperationStore(root=tmp_path / "legacy-source")
    created = _create_test_operation_session(local_store)
    local_store.purge_local_session_state(created.session_id)
    legacy_state = {
        "schema_version": 1,
        "contract": STUDENT_METADATA_STATE_CONTRACT,
        "session": created.model_dump(mode="json"),
    }
    legacy_bytes = json.dumps(
        legacy_state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    class RemoteStore:
        session_id = created.session_id
        run_id = f"student:{created.session_id}"

        @staticmethod
        def get_state(**_payload):
            return {
                "state": legacy_state,
                "session": {
                    "revision": 1,
                    "sha256": hashlib.sha256(legacy_bytes).hexdigest(),
                },
            }

        @staticmethod
        def get_artifact(**_payload):
            raise OperationStoreClientError("not found", status_code=404)

    restarted = OperationStore(
        root=tmp_path / "legacy-source",
        remote_client=RemoteStore(),
        conversion_run_id=RemoteStore.run_id,
    )

    with pytest.raises(OperationStoreError, match="operator drain recovery"):
        restarted.materialize_table(created.session_id)


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
    final_dir = store.root / result["session"].session_id
    assert not in_flight_dir.exists()
    assert (final_dir / "session.json").is_file()
    assert not (final_dir / ".creating.json").exists()


def test_operation_sweeper_drains_active_write_lease_without_resurrection(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("OPERATION_STORE_ALLOW_LOCAL", "true")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "converter-service-secret")
    store = OperationStore(root=tmp_path / "sessions")
    session = _create_test_operation_session(store)
    write_started = threading.Event()
    release_write = threading.Event()
    cleanup_finished = threading.Event()
    original_save = store._save_session

    def blocked_save(updated, table_payload=None):
        write_started.set()
        assert release_write.wait(2)
        return original_save(updated, table_payload)

    store._save_session = blocked_save
    writer = threading.Thread(
        target=lambda: store.create_revision(
            session.session_id,
            expected_revision=session.active_revision,
            expected_state_hash=session.state_hash,
            changes={"r1": {"CCCD": "DOC-REDACTED"}},
            created_by=session.owner_scope,
        ),
        daemon=True,
    )
    writer.start()
    assert write_started.wait(2)

    cleanup_result = {}
    cleaner = threading.Thread(
        target=lambda: (
            cleanup_result.setdefault(
                "deleted",
                cleanup_expired_operation_sessions(
                    root=store.root,
                    now=datetime.now(timezone.utc) + timedelta(days=1),
                    batch_size=10,
                ),
            ),
            cleanup_finished.set(),
        ),
        daemon=True,
    )
    cleaner.start()
    assert not cleanup_finished.wait(0.1)

    release_write.set()
    writer.join(2)
    cleaner.join(2)

    assert not writer.is_alive()
    assert not cleaner.is_alive()
    assert cleanup_result["deleted"] == [session.session_id]
    assert not (store.root / session.session_id).exists()
    with pytest.raises(OperationStoreError, match="purged|purging"):
        store.load_session(session.session_id)


def test_student_operation_create_is_atomic_through_remote_save_and_future_sweep(
    tmp_path,
):
    session_id = "student-create-interleave"
    remote_started = threading.Event()
    release_remote = threading.Event()
    captured = {}

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id

        @staticmethod
        def put_state(**payload):
            captured.update(payload)
            remote_started.set()
            assert release_remote.wait(2)
            return _persisted_state_response(payload)

    store = OperationStore(
        root=tmp_path / "sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    result = {}

    def create():
        try:
            result["session"] = _create_test_operation_session(
                store,
                session_id=session_id,
            )
        except Exception as exc:  # pragma: no cover - asserted through result
            result["error"] = exc

    creator = threading.Thread(target=create, daemon=True)
    creator.start()
    assert remote_started.wait(2)

    published = store.root / session_id
    assert not published.exists()
    staging = [path for path in store.root.iterdir() if path.is_dir()]
    assert staging == []

    deleted = cleanup_expired_operation_sessions(
        root=store.root,
        now=datetime.now(timezone.utc) + timedelta(days=1),
        batch_size=10,
    )
    assert deleted == []
    assert list(store.root.iterdir()) == []

    release_remote.set()
    creator.join(2)
    assert not creator.is_alive()
    assert "error" not in result
    assert not published.exists()
    assert list(store.root.iterdir()) == []
    assert captured["state"]["table"]["headers"] == ["Họ tên", "CCCD"]


def test_student_operation_create_remote_failure_publishes_no_local_state(tmp_path):
    session_id = "student-create-remote-failure"

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id

        @staticmethod
        def put_state(**_payload):
            raise RuntimeError("remote unavailable")

    store = OperationStore(
        root=tmp_path / "sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )

    with pytest.raises(OperationStoreError, match="Node"):
        _create_test_operation_session(store, session_id=session_id)

    assert not (store.root / session_id).exists()
    assert list(store.root.iterdir()) == []
    assert session_id not in store._remote_payloads


def test_student_operation_purge_removes_local_state_but_fails_closed_on_remote_partial(
    tmp_path,
):
    session_id = "student-purge-remote-partial"

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id

        @staticmethod
        def put_state(**payload):
            return _persisted_state_response(payload)

        @staticmethod
        def delete_session_artifacts(**payload):
            return {
                "success": True,
                "session_id": payload["session_id"],
                "run_id": payload["run_id"],
                "purge_scope": "all_artifacts",
                "remaining_metadata": 1,
                "remaining_bytes": 0,
                "remote_operation_session_deleted": False,
            }

    store = OperationStore(
        root=tmp_path / "sessions",
        remote_client=RemoteStore(),
        conversion_run_id=f"student:{session_id}",
    )
    _create_test_operation_session(store, session_id=session_id)

    report = store.purge_session_state(session_id)

    assert report == {
        "local_operation_session_deleted": True,
        "remote_operation_session_deleted": False,
        "operation_session_deleted": False,
    }
    assert not (store.root / session_id).exists()


def test_operation_purge_fence_drains_in_flight_create_and_survives_restart(
    tmp_path,
):
    session_id = "student-purge-create-race"
    remote_write_started = threading.Event()
    release_remote_write = threading.Event()
    purge_finished = threading.Event()

    class RemoteStore:
        def __init__(self):
            self.run_id = f"student:{session_id}"
            self.session_id = session_id
            self.has_state = False

        def put_state(self, **payload):
            remote_write_started.set()
            assert release_remote_write.wait(2)
            self.has_state = True
            return _persisted_state_response(payload)

        def delete_session_artifacts(self, **payload):
            self.has_state = False
            return {
                "success": True,
                "session_id": payload["session_id"],
                "run_id": payload["run_id"],
                "purge_scope": "all_artifacts",
                "remaining_metadata": 0,
                "remaining_bytes": 0,
                "remote_operation_session_deleted": True,
            }

    remote = RemoteStore()
    root = tmp_path / "sessions"
    store = OperationStore(
        root=root,
        remote_client=remote,
        conversion_run_id=remote.run_id,
    )
    results = {}

    creator = threading.Thread(
        target=lambda: results.setdefault(
            "created",
            _create_test_operation_session(store, session_id=session_id),
        ),
        daemon=True,
    )
    creator.start()
    assert remote_write_started.wait(2)

    def purge():
        results["purge"] = store.purge_session_state(session_id)
        purge_finished.set()

    purger = threading.Thread(target=purge, daemon=True)
    purger.start()
    assert not purge_finished.wait(0.1)

    release_remote_write.set()
    creator.join(2)
    purger.join(2)

    assert not creator.is_alive()
    assert not purger.is_alive()
    assert results["purge"]["operation_session_deleted"] is True
    assert remote.has_state is False
    assert not (root / session_id).exists()

    restarted = OperationStore(
        root=root,
        remote_client=remote,
        conversion_run_id=remote.run_id,
    )
    with pytest.raises(OperationStoreError, match="purged|purging|xoá"):
        _create_test_operation_session(restarted, session_id=session_id)


def test_purged_fence_is_hmac_minimized_and_swept_only_after_safe_horizon(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("OPERATION_STORE_ALLOW_LOCAL", "true")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "converter-service-secret")
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "operation-fence-test-secret-at-least-32-characters",
    )
    monkeypatch.setenv("OPERATION_FENCE_RETENTION_SECONDS", "86400")
    root = tmp_path / "sessions"
    store = OperationStore(root=root)
    session = _create_test_operation_session(store)

    result = store.purge_session_state(session.session_id)
    assert result["operation_session_deleted"] is True
    state_path = store._lifecycle_state_path(session.session_id)
    lock_path = store._lifecycle_lock_path(session.session_id)
    payload = json.loads(state_path.read_text(encoding="utf-8"))
    assert session.session_id not in state_path.name
    assert session.session_id not in state_path.read_text(encoding="utf-8")
    assert "session_id" not in payload
    assert payload["status"] == "purged"
    purge_after = datetime.fromisoformat(payload["purge_after"])

    cleanup_expired_operation_sessions(
        root=root,
        now=purge_after - timedelta(seconds=1),
        batch_size=10,
    )
    assert state_path.is_file()

    cleanup_expired_operation_sessions(
        root=root,
        now=purge_after + timedelta(seconds=1),
        batch_size=10,
    )
    assert not state_path.exists()
    assert lock_path.exists()


def test_purged_fence_ignores_early_purge_after_before_retention_horizon(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "operation-fence-test-secret-at-least-32-characters",
    )
    root = tmp_path / "sessions"
    store = OperationStore(root=root)
    session = _create_test_operation_session(store)
    store.purge_session_state(session.session_id)
    state_path = store._lifecycle_state_path(session.session_id)
    payload = json.loads(state_path.read_text(encoding="utf-8"))
    current_time = datetime.now(timezone.utc)
    payload["purge_after"] = (current_time - timedelta(days=1)).isoformat()
    store._atomic_write(state_path, payload)

    cleanup_expired_operation_sessions(
        root=root,
        now=current_time,
        batch_size=1,
    )

    assert state_path.is_file()


def test_schema_v1_plaintext_purged_fence_migrates_without_allowing_reuse(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "operation-fence-test-secret-at-least-32-characters",
    )
    monkeypatch.setenv("CONVERTER_ARTIFACT_TTL_SECONDS", "172800")
    root = tmp_path / "sessions"
    store = OperationStore(root=root)
    session_id = "legacy-purged-session"
    legacy_path = store._lifecycle_root / f"{session_id}.json"
    legacy_lock = store._lifecycle_root / f"{session_id}.lock"
    legacy_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": session_id,
                "status": "purged",
                "updated_at": "2026-07-30T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    legacy_lock.write_bytes(b"\0")

    payload = store._read_lifecycle_state(session_id)

    state_path = store._lifecycle_state_path(session_id)
    serialized = state_path.read_text(encoding="utf-8")
    assert payload["schema_version"] == 2
    assert payload["key_ids"] == ["v1"]
    assert payload["status"] == "purged"
    assert session_id not in state_path.name
    assert session_id not in serialized
    assert "session_id" not in payload
    assert not legacy_path.exists()
    assert not legacy_lock.exists()
    purge_after = datetime.fromisoformat(payload["purge_after"])
    assert purge_after >= datetime.now(timezone.utc) + timedelta(hours=47)

    restarted = OperationStore(root=root)
    with pytest.raises(OperationStoreError, match="purged|purging"):
        with restarted._write_lease(session_id, initialize=True):
            pass


def test_schema_v1_purged_fence_wins_over_hmac_active_state(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "operation-fence-test-secret-at-least-32-characters",
    )
    root = tmp_path / "sessions"
    store = OperationStore(root=root)
    session_id = "legacy-conflicting-session"
    store._write_lifecycle_state(session_id, "active")
    legacy_path = store._lifecycle_root / f"{session_id}.json"
    legacy_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": session_id,
                "status": "purged",
                "updated_at": "2026-07-30T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )

    payload = store._read_lifecycle_state(session_id)

    assert payload["status"] == "purged"
    assert not legacy_path.exists()


def test_operation_cleanup_uses_independent_session_and_fence_budgets(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "operation-fence-test-secret-at-least-32-characters",
    )
    root = tmp_path / "sessions"
    store = OperationStore(root=root)
    first = _create_test_operation_session(store, ttl_seconds=3600)
    second = _create_test_operation_session(store, ttl_seconds=3600)
    ordered = sorted(
        (first, second),
        key=lambda session: store._lifecycle_state_path(session.session_id).name,
    )
    purged, active = ordered
    store.purge_session_state(purged.session_id)
    fence_path = store._lifecycle_state_path(purged.session_id)
    payload = json.loads(fence_path.read_text(encoding="utf-8"))
    current_time = datetime.now(timezone.utc)
    payload["updated_at"] = (current_time - timedelta(days=3)).isoformat()
    payload["retain_until"] = (current_time - timedelta(days=2)).isoformat()
    payload["purge_after"] = (current_time - timedelta(days=1)).isoformat()
    store._atomic_write(fence_path, payload)

    deleted = cleanup_expired_operation_sessions(
        root=root,
        now=current_time,
        batch_size=1,
    )

    assert deleted == []
    assert (root / active.session_id).is_dir()
    assert not fence_path.exists()


def test_operation_cleanup_selects_expired_sessions_and_fences_before_batch_budget(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "operation-fence-test-secret-at-least-32-characters",
    )
    root = tmp_path / "sessions"
    store = OperationStore(root=root)
    current_time = datetime.now(timezone.utc)

    for name in ("a-active", "b-active", "c-active"):
        directory = root / name
        directory.mkdir()
        (directory / "session.json").write_text(
            json.dumps({"expires_at": (current_time + timedelta(days=1)).isoformat()}),
            encoding="utf-8",
        )
    expired_directory = root / "z-expired"
    expired_directory.mkdir()
    (expired_directory / "session.json").write_text(
        json.dumps({"expires_at": (current_time - timedelta(days=1)).isoformat()}),
        encoding="utf-8",
    )

    ordered = sorted(
        [f"fence-{index}" for index in range(32)],
        key=lambda session_id: store._lifecycle_state_path(session_id).name,
    )
    for session_id in ordered[:3]:
        store._write_lifecycle_state(session_id, "active")
    expired_fence_id = ordered[-1]
    store._write_lifecycle_state(expired_fence_id, "purged")
    expired_fence = store._lifecycle_state_path(expired_fence_id)
    payload = json.loads(expired_fence.read_text(encoding="utf-8"))
    payload["updated_at"] = (current_time - timedelta(days=4)).isoformat()
    payload["retain_until"] = (current_time - timedelta(days=3)).isoformat()
    payload["purge_after"] = (current_time - timedelta(days=2)).isoformat()
    store._atomic_write(expired_fence, payload)

    deleted = cleanup_expired_operation_sessions(
        root=root,
        now=current_time,
        batch_size=1,
    )

    assert deleted == ["z-expired"]
    assert not expired_fence.exists()


def test_operation_cleanup_cursor_advances_past_stable_failures_with_bounded_scan(
    tmp_path,
    monkeypatch,
):
    import app.operation_store as operation_store_module

    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "operation-fence-test-secret-at-least-32-characters",
    )
    root = tmp_path / "sessions"
    root.mkdir()
    current_time = datetime.now(timezone.utc)
    for index in range(10):
        directory = root / f"a-failing-{index:02d}"
        directory.mkdir()
        (directory / "session.json").write_text(
            json.dumps({"expires_at": (current_time - timedelta(days=1)).isoformat()}),
            encoding="utf-8",
        )
    eligible = root / "z-expired"
    eligible.mkdir()
    (eligible / "session.json").write_text(
        json.dumps({"expires_at": (current_time - timedelta(days=1)).isoformat()}),
        encoding="utf-8",
    )
    calls: list[str] = []

    def remove(_root, directory):
        calls.append(directory.name)
        if directory.name.startswith("a-failing"):
            raise OSError("stable failure")
        operation_store_module._remove_operation_session_directory(_root, directory)
        return True

    monkeypatch.setattr(
        operation_store_module,
        "_coordinated_remove_expired_directory",
        remove,
    )

    first = cleanup_expired_operation_sessions(root=root, now=current_time, batch_size=1)
    first_scan_count = len(calls)
    second = cleanup_expired_operation_sessions(root=root, now=current_time, batch_size=1)
    second_scan_count = len(calls) - first_scan_count

    assert first == []
    assert second == ["z-expired"]
    assert first_scan_count <= 8
    assert second_scan_count <= 8


def test_operation_fence_rejects_short_active_secret_and_accepts_32_utf8_bytes(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v2")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", "short")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}")
    with pytest.raises(OperationStoreError, match="at least 32 bytes"):
        OperationStore(root=tmp_path / "short-active")

    utf8_root = tmp_path / "utf8-previous"
    previous_secret = "\u00e9" * 20
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v1")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", previous_secret)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}")
    monkeypatch.delenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", raising=False)
    OperationStore(root=utf8_root)

    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v2")
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_SECRET",
        "active-operation-fence-secret-at-least-32-bytes",
    )
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_PREVIOUS_KEYS",
        json.dumps({"v1": previous_secret}),
    )
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_ROTATION_HORIZON",
        (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
    )
    OperationStore(root=utf8_root)


def test_operation_fence_canary_rejects_wrong_material_for_same_key_id(
    tmp_path,
    monkeypatch,
):
    root = tmp_path / "sessions"
    first_secret = "first-operation-fence-secret-at-least-32-characters"
    wrong_secret = "wrong-operation-fence-secret-at-least-32-characters"
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "stable-id")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", first_secret)
    OperationStore(root=root)

    lifecycle_root = tmp_path / ".sessions-lifecycle"
    canaries = list(lifecycle_root.glob(".key-canary-*"))
    assert len(canaries) == 1
    assert list(lifecycle_root.glob("*.json")) == []
    serialized = canaries[0].read_text(encoding="utf-8")
    assert first_secret not in serialized

    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", wrong_secret)
    with pytest.raises(OperationStoreError, match="same key id.*different secret material"):
        OperationStore(root=root)


def test_operation_fence_rotation_requires_bootstrapped_matching_previous_canary(
    tmp_path,
    monkeypatch,
):
    old_secret = "old-operation-fence-secret-at-least-32-characters"
    wrong_secret = "wrong-operation-fence-secret-at-least-32-characters"
    new_secret = "new-operation-fence-secret-at-least-32-characters"
    horizon = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()

    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v2")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", new_secret)
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_PREVIOUS_KEYS",
        json.dumps({"v1": old_secret}),
    )
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", horizon)
    with pytest.raises(OperationStoreError, match="(?i)previous.*canary.*bootstrap"):
        OperationStore(root=tmp_path / "missing-bootstrap")
    assert list((tmp_path / ".missing-bootstrap-lifecycle").glob("*.canary")) == []

    root = tmp_path / "wrong-material"
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v1")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", old_secret)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}")
    monkeypatch.delenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", raising=False)
    OperationStore(root=root)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v2")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", new_secret)
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_PREVIOUS_KEYS",
        json.dumps({"v1": wrong_secret}),
    )
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", horizon)
    with pytest.raises(OperationStoreError, match="same key id.*different secret material"):
        OperationStore(root=root)
    assert len(list((tmp_path / ".wrong-material-lifecycle").glob("*.canary"))) == 1


def test_rotating_purge_waits_for_old_head_lock_and_old_path_stays_terminal(
    tmp_path,
    monkeypatch,
):
    import app.operation_store as operation_store_module

    old_secret = "old-operation-fence-secret-at-least-32-characters"
    new_secret = "new-operation-fence-secret-at-least-32-characters"
    root = tmp_path / "sessions"
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v1")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", old_secret)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}")
    old_store = OperationStore(root=root)
    session_id = _create_test_operation_session(old_store).session_id
    old_key = hmac.new(
        old_secret.encode("utf-8"),
        session_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    old_state_path = old_store._lifecycle_root / f"{old_key}.json"
    old_lock_path = old_store._lifecycle_root / f"{old_key}.lock"

    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v2")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", new_secret)
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_PREVIOUS_KEYS",
        json.dumps({"v1": old_secret}),
    )
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_ROTATION_HORIZON",
        (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
    )
    rotating_store = OperationStore(root=root)
    old_started = threading.Event()
    release_old = threading.Event()
    purge_finished = threading.Event()

    def old_head_write():
        with operation_store_module._file_lock(old_lock_path):
            payload = json.loads(old_state_path.read_text(encoding="utf-8"))
            assert payload["schema_version"] == 2
            assert payload["status"] == "active"
            old_started.set()
            assert release_old.wait(timeout=2)
            old_store._atomic_write(
                old_state_path,
                {
                    "schema_version": 2,
                    "status": "active",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "retain_until": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
                },
            )

    def purge():
        rotating_store.purge_session_state(session_id)
        purge_finished.set()

    writer = threading.Thread(target=old_head_write, daemon=True)
    purger = threading.Thread(target=purge, daemon=True)
    writer.start()
    assert old_started.wait(timeout=2)
    purger.start()
    time.sleep(0.1)
    assert not purge_finished.is_set()
    release_old.set()
    writer.join(timeout=2)
    purger.join(timeout=2)

    assert purge_finished.is_set()
    old_payload = json.loads(old_state_path.read_text(encoding="utf-8"))
    assert old_payload["schema_version"] == 2
    assert old_payload["status"] == "purged"


def test_operation_fence_key_rotation_shares_terminal_state_and_rejects_early_key_removal(
    tmp_path,
    monkeypatch,
):
    old_secret = "old-operation-fence-secret-at-least-32-characters"
    new_secret = "new-operation-fence-secret-at-least-32-characters"
    rotation_horizon = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    root = tmp_path / "sessions"
    session_id = "rotation-session"

    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v1")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", old_secret)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}")
    monkeypatch.delenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", raising=False)
    old_store = OperationStore(root=root)
    old_store._write_lifecycle_state(session_id, "active")

    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v2")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", new_secret)
    monkeypatch.setenv(
        "OPERATION_FENCE_HMAC_PREVIOUS_KEYS",
        json.dumps({"v1": old_secret}),
    )
    monkeypatch.setenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", rotation_horizon)
    rotating_store = OperationStore(root=root)
    canary_payloads = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in rotating_store._lifecycle_root.glob("*.canary")
    ]
    previous_canary = next(
        payload for payload in canary_payloads if payload["key_id"] == "v1"
    )
    assert previous_canary["required_until"] == rotation_horizon
    assert rotating_store._read_lifecycle_state(session_id)["status"] == "active"
    rotating_store._write_lifecycle_state(session_id, "purged")
    old_key = hmac.new(
        old_secret.encode("utf-8"), session_id.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    old_reader_payload = json.loads(
        (rotating_store._lifecycle_root / f"{old_key}.json").read_text(
            encoding="utf-8"
        )
    )
    assert old_reader_payload["schema_version"] == 2
    assert old_reader_payload["status"] == "purged"

    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v1")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", old_secret)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}")
    monkeypatch.delenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", raising=False)
    restarted_old = OperationStore(root=root)
    assert restarted_old._read_lifecycle_state(session_id)["status"] == "purged"

    monkeypatch.setenv("OPERATION_FENCE_HMAC_ACTIVE_KEY_ID", "v2")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", new_secret)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_PREVIOUS_KEYS", "{}")
    monkeypatch.delenv("OPERATION_FENCE_HMAC_ROTATION_HORIZON", raising=False)
    with pytest.raises(OperationStoreError, match="(?i)previous.*retention horizon"):
        OperationStore(root=root)


def test_expired_context_cannot_reuse_operation_id_after_fence_horizon(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", OPERATION_FENCE_SECRET)
    expired = _context_token(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "owner_scope": "user:user-1",
            "workspace_id": None,
            "conversion_run_id": "run-expired",
            "operation_session_id": "purged-session",
            "upload_id": "upload-expired",
            "target_template_id": "bsn_sales",
            "exp": int(time.time()) - 1,
        }
    )

    with pytest.raises(OperationStoreError, match="không hợp lệ"):
        OperationStore(root=tmp_path / "sessions", conversion_context_token=expired)


def test_operation_sweeper_cleans_crashed_staging_after_creation_grace(
    tmp_path,
    monkeypatch,
):
    root = tmp_path / "sessions"
    staging = root / ".creating-crashed-session"
    staging.mkdir(parents=True)
    (staging / "table.json").write_text('{"raw":"state"}', encoding="utf-8")
    monkeypatch.setenv("OPERATION_SESSION_CREATION_GRACE_SECONDS", "30")
    old = datetime.now(timezone.utc) - timedelta(minutes=2)
    timestamp = old.timestamp()
    os.utime(staging, (timestamp, timestamp))

    deleted = cleanup_expired_operation_sessions(
        root=root,
        now=datetime.now(timezone.utc),
        batch_size=1,
    )

    assert deleted == [staging.name]
    assert not staging.exists()


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


def test_node_analyze_keeps_raw_only_in_bound_remote_artifact(tmp_path, monkeypatch):
    import app.misa_workflow as workflow
    import app.operation_store as operation_store_module

    session_id = "a52a3c60-df68-46e5-a6a5-4a7bb44828c5"
    upload_id = "e7270428-d19f-4fd9-bd86-1b4a5a632e0a"
    run_id = "507f1f77bcf86cd799439011"
    persisted = {}
    artifacts = {}
    remote_calls = []

    class RemoteStore:
        def __init__(self, _context_token):
            self.session_id = session_id
            self.run_id = run_id

        @staticmethod
        def put_state(**payload):
            remote_calls.append("put_state")
            encoded = json.dumps(
                payload["state"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            persisted.update(
                {
                    "state": json.loads(encoded),
                    "revision": payload["revision"],
                    "sha256": hashlib.sha256(encoded).hexdigest(),
                }
            )
            return {
                "state": persisted["state"],
                "session": {
                    "revision": persisted["revision"],
                    "sha256": persisted["sha256"],
                },
            }

        @staticmethod
        def get_state(**_payload):
            remote_calls.append("get_state")
            assert persisted, "initial analyze read Node state before first publication"
            return {
                "state": persisted["state"],
                "session": {
                    "revision": persisted["revision"],
                    "sha256": persisted["sha256"],
                },
            }

        @staticmethod
        def put_artifact(**payload):
            artifacts[payload["kind"]] = bytes(payload["content"])
            return {"artifact": {"sha256": hashlib.sha256(payload["content"]).hexdigest()}}

    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "converter-service-secret")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "mapping.sqlite"))
    monkeypatch.setenv("FEATURE_MAPPING_PROFILE_V2", "false")
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setattr(operation_store_module, "NodeOperationStoreClient", RemoteStore)
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
            "scopes": ["analyze"],
            "exp": int(time.time()) + 60,
        }
    )
    source_path = _workbook(tmp_path / "raw.xlsx")
    source_bytes = source_path.read_bytes()

    result = workflow.analyze_upload(
        filename="raw.xlsx",
        content=source_bytes,
        requested_target_template_id="bsn_sales",
        conversion_context_token=token,
        operation_session_id=session_id,
        conversion_run_id=run_id,
        preallocated_upload_id=upload_id,
    )

    assert result["session"]["session_id"] == session_id
    assert remote_calls[0] == "put_state"
    assert artifacts["upload"] == source_bytes
    assert not (workflow.UPLOAD_ROOT / upload_id).exists()
    assert not (tmp_path / "default-sessions" / session_id).exists()

    analyze_call_count = len(remote_calls)
    metadata = workflow._read_metadata(upload_id, conversion_context_token=token)

    assert metadata["operation_session_id"] == session_id
    assert remote_calls[analyze_call_count:]
    assert set(remote_calls[analyze_call_count:]) == {"get_state"}


def test_personal_conversion_context_owns_session_without_workspace(
    tmp_path, monkeypatch
):
    import app.misa_workflow as workflow

    monkeypatch.delenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", raising=False)
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", OPERATION_FENCE_SECRET)
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


def test_session_export_uses_active_revision_without_client_rows(
    tmp_path,
    monkeypatch,
    _allow_uncertified_workflow_export,
):
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
