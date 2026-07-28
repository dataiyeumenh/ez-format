from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.main as main
import app.misa_workflow as workflow
from app.operation_store import OperationStore, OperationStoreError
from app.operation_store_client import NodeOperationStoreClient, OperationStoreClientError


class _RemoteArtifactStore:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def get_artifact(self, _session_id: str, *, kind: str, revision: int) -> bytes:
        assert kind == "upload"
        assert revision == 1
        return self.content


def _session(raw_sha256: str):
    return SimpleNamespace(session_id="session-1", raw_sha256=raw_sha256)


def _encode_segment(value: dict[str, object]) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _context_token(secret: str, *, operation_session_id: str = "") -> str:
    header = _encode_segment({"alg": "HS256", "typ": "JWT"})
    body = _encode_segment(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "owner_scope": "user:user-1",
            "workspace_id": None,
            "conversion_run_id": "run-1",
            "operation_session_id": operation_session_id,
            "upload_id": "",
            "target_template_id": "bsn_sales",
            "scopes": ["analyze"],
            "max_file_bytes": 20 * 1024 * 1024,
            "exp": int(time.time()) + 300,
        }
    )
    signature = hmac.new(
        secret.encode("utf-8"), f"{header}.{body}".encode("ascii"), hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{body}.{encoded_signature}"


def test_tampered_local_upload_is_replaced_from_verified_remote_artifact(tmp_path):
    original = b"trusted workbook bytes"
    input_path = tmp_path / "input.xlsx"
    input_path.write_bytes(b"tampered workbook bytes")
    metadata = {"input_path": str(input_path), "raw_sha256": hashlib.sha256(original).hexdigest()}

    workflow._restore_upload_bytes_if_missing(
        metadata,
        _RemoteArtifactStore(original),
        _session(metadata["raw_sha256"]),
    )

    assert input_path.read_bytes() == original


def test_tampered_local_upload_fails_closed_when_remote_checksum_is_invalid(tmp_path):
    original = b"trusted workbook bytes"
    input_path = tmp_path / "input.xlsx"
    input_path.write_bytes(b"tampered workbook bytes")
    metadata = {"input_path": str(input_path), "raw_sha256": hashlib.sha256(original).hexdigest()}

    with pytest.raises(OperationStoreError, match="checksum"):
        workflow._restore_upload_bytes_if_missing(
            metadata,
            _RemoteArtifactStore(b"also tampered"),
            _session(metadata["raw_sha256"]),
        )

    assert input_path.read_bytes() == b"tampered workbook bytes"


def test_upload_cleanup_removes_only_expired_unbound_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    root = workflow.UPLOAD_ROOT

    expired = root / "expired"
    expired.mkdir(parents=True)
    (expired / "metadata.json").write_text(
        json.dumps({"upload_id": "expired", "expires_at": 100}), encoding="utf-8"
    )

    active = root / "active"
    active.mkdir(parents=True)
    (active / "metadata.json").write_text(
        json.dumps(
            {
                "upload_id": "active",
                "operation_session_id": "session-active",
                "expires_at": 500,
            }
        ),
        encoding="utf-8",
    )

    malformed = root / "malformed"
    malformed.mkdir(parents=True)
    (malformed / "metadata.json").write_text("not-json", encoding="utf-8")

    deleted = workflow.cleanup_expired_uploads(now=200)

    assert deleted == ["expired"]
    assert not expired.exists()
    assert active.exists()
    assert malformed.exists()


def test_production_operation_store_requires_signed_remote_session(tmp_path, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.delenv("CONVERSION_CONTEXT_SECRET", raising=False)

    with pytest.raises(OperationStoreError, match="session"):
        OperationStore(tmp_path)


@pytest.mark.parametrize(
    ("node_env", "provider"),
    [
        (None, None),
        ("production", None),
        ("production", "local"),
        ("development", "local"),
    ],
)
def test_operation_store_rejects_implicit_or_unsafe_local_state(
    tmp_path, monkeypatch, node_env, provider
):
    if node_env is None:
        monkeypatch.delenv("NODE_ENV", raising=False)
    else:
        monkeypatch.setenv("NODE_ENV", node_env)
    if provider is None:
        monkeypatch.delenv("OPERATION_STORE_PROVIDER", raising=False)
    else:
        monkeypatch.setenv("OPERATION_STORE_PROVIDER", provider)
    monkeypatch.delenv("OPERATION_STORE_ALLOW_LOCAL", raising=False)
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-token")

    with pytest.raises(OperationStoreError, match="operation store|local|provider"):
        OperationStore(tmp_path)


def test_local_operation_store_requires_explicit_authenticated_test_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("OPERATION_STORE_ALLOW_LOCAL", "true")
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)

    with pytest.raises(OperationStoreError, match="service token"):
        OperationStore(tmp_path)

    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-token")
    store = OperationStore(tmp_path)
    assert store.root == tmp_path


def test_converter_startup_rejects_missing_operation_store_mode(monkeypatch):
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.delenv("OPERATION_STORE_PROVIDER", raising=False)
    monkeypatch.delenv("OPERATION_STORE_ALLOW_LOCAL", raising=False)

    with pytest.raises(OperationStoreError, match="OPERATION_STORE_PROVIDER"):
        main._assert_secure_production_config()


def test_node_operation_store_client_requires_secure_transport(monkeypatch):
    import app.operation_store_client as client_module

    monkeypatch.setattr(
        client_module,
        "verify_conversion_context_token",
        lambda _token: {
            "conversion_run_id": "run-1",
            "operation_session_id": "session-1",
        },
    )
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("NODE_INTERNAL_ALLOW_INSECURE_LOCALHOST", "true")

    secure = NodeOperationStoreClient(
        "signed-context", base_url="https://node.example/api/internal"
    )
    assert secure.base_url == "https://node.example/api/internal"

    with pytest.raises(OperationStoreClientError, match="HTTPS"):
        NodeOperationStoreClient(
            "signed-context", base_url="http://node.example/api/internal"
        )

    local = NodeOperationStoreClient(
        "signed-context", base_url="http://127.0.0.1:5000/api/internal"
    )
    assert local.base_url == "http://127.0.0.1:5000/api/internal"

    monkeypatch.delenv("NODE_ENV", raising=False)
    with pytest.raises(OperationStoreClientError, match="HTTPS"):
        NodeOperationStoreClient(
            "signed-context", base_url="http://127.0.0.1:5000/api/internal"
        )


def test_production_analyze_requires_preallocated_operation_session(tmp_path, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-token")
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")

    with pytest.raises(OperationStoreError, match="session"):
        workflow.analyze_upload(
            filename="input.xlsx",
            content=b"workbook",
            conversion_context_token="signed-context",
            operation_session_id=None,
            conversion_run_id=None,
        )

    assert not workflow.UPLOAD_ROOT.exists()


def test_production_analyze_route_rejects_context_without_session(tmp_path, monkeypatch):
    secret = "route-secret"
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", secret)
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-token")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false")
    monkeypatch.setattr(workflow, "UPLOAD_ROOT", tmp_path / "uploads")

    token = _context_token(secret)
    response = TestClient(main.app, raise_server_exceptions=False).post(
        "/api/v1/uploads/analyze",
        headers={
            "x-converter-service-token": "service-token",
            "x-conversion-context": token,
        },
        data={"target_template_id": "bsn_sales", "conversion_run_id": "run-1"},
        files={"file": ("input.xlsx", b"workbook", "application/octet-stream")},
    )

    assert response.status_code == 409
    assert "operation_session_id" in response.text
