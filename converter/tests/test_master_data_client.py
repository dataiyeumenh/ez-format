import base64
import hashlib
import hmac
import json
import time

import pytest

from app.master_data_client import (
    ConversionContextError,
    clear_master_data_context_cache,
    fetch_master_data_context,
    verify_conversion_context_token,
)


def _encode(value: dict) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _token(payload: dict, secret: str = "test-secret") -> str:
    header = _encode({"alg": "HS256", "typ": "JWT"})
    body = _encode(payload)
    signature = hmac.new(
        secret.encode("utf-8"), f"{header}.{body}".encode("ascii"), hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{body}.{encoded_signature}"


def test_verify_conversion_context_token(monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    token = _token(
        {
            "purpose": "misa_conversion",
            "user_id": "user-1",
            "workspace_id": "workspace-1",
            "snapshot_set_hash": "hash-1",
            "snapshot_ids": ["snapshot-1"],
            "exp": int(time.time()) + 60,
        }
    )

    claims = verify_conversion_context_token(token)

    assert claims["workspace_id"] == "workspace-1"
    assert claims["snapshot_set_hash"] == "hash-1"


def test_verify_rejects_tampered_token(monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    token = _token(
        {
            "purpose": "misa_conversion",
            "workspace_id": "workspace-1",
            "snapshot_set_hash": "hash-1",
            "exp": int(time.time()) + 60,
        }
    )

    with pytest.raises(ConversionContextError, match="Chữ ký"):
        verify_conversion_context_token(token + "x")


def test_verify_rejects_expired_token(monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    token = _token(
        {
            "purpose": "misa_conversion",
            "workspace_id": "workspace-1",
            "snapshot_set_hash": "hash-1",
            "exp": int(time.time()) - 1,
        }
    )

    with pytest.raises(ConversionContextError, match="hết hạn"):
        verify_conversion_context_token(token)


def test_fetch_context_marks_stale_snapshot_as_conflict(monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("NODE_INTERNAL_API_URL", "http://node/api/internal")
    token = _token(
        {
            "purpose": "misa_conversion",
            "workspace_id": "workspace-1",
            "snapshot_set_hash": "hash-1",
            "master_data_revision": 1,
            "exp": int(time.time()) + 60,
        }
    )

    class Response:
        status_code = 409

        @staticmethod
        def json():
            return {"message": "Danh mục MISA đã thay đổi"}

    monkeypatch.setattr("app.master_data_client.httpx.get", lambda *_args, **_kwargs: Response())
    clear_master_data_context_cache()

    with pytest.raises(ConversionContextError) as error:
        fetch_master_data_context(token)

    assert error.value.status_code == 409


def test_cached_context_is_revalidated_before_reuse(monkeypatch):
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "test-secret")
    monkeypatch.setenv("NODE_INTERNAL_API_URL", "http://node/api/internal")
    token = _token(
        {
            "purpose": "misa_conversion",
            "workspace_id": "workspace-1",
            "snapshot_set_hash": "hash-1",
            "master_data_revision": 1,
            "exp": int(time.time()) + 60,
        }
    )
    calls = []

    class Response:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload

        def json(self):
            return self._payload

    def get(url, **_kwargs):
        calls.append(url)
        if "context-status" in url:
            return Response(409, {"message": "Alias MISA đã thay đổi"})
        return Response(
            200,
            {
                "snapshotSetHash": "hash-1",
                "workspace": {"id": "workspace-1"},
                "catalogs": {},
            },
        )

    monkeypatch.setattr("app.master_data_client.httpx.get", get)
    clear_master_data_context_cache()

    assert fetch_master_data_context(token)["workspace"]["id"] == "workspace-1"
    with pytest.raises(ConversionContextError) as error:
        fetch_master_data_context(token)

    assert error.value.status_code == 409
    assert any("context-status" in url for url in calls)
