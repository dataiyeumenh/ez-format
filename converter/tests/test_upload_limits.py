from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main


SERVICE_TOKEN = "test-converter-service-token"
CONTEXT_SECRET = "test-conversion-context-secret"
MIB = 1024 * 1024


def _context_token() -> str:
    payload = {
        "purpose": "misa_conversion",
        "user_id": "user-1",
        "owner_scope": "user:user-1",
        "workspace_id": None,
        "snapshot_set_hash": None,
        "conversion_context_id": "context-1",
        "conversion_run_id": "run-1",
        "operation_session_id": "",
        "upload_id": "",
        "target_template_id": "bsn_sales",
        "max_file_bytes": 2 * MIB,
        "scopes": ["analyze", "preview", "export"],
        "exp": int(time.time()) + 300,
    }

    def encode(value: dict[str, object]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = encode({"alg": "HS256", "typ": "JWT"})
    body = encode(payload)
    signature = hmac.new(
        CONTEXT_SECRET.encode("utf-8"),
        f"{header}.{body}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{header}.{body}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')}"


class TrackingUpload:
    def __init__(self, content: bytes) -> None:
        self.filename = "input.xlsx"
        self._content = content
        self._offset = 0
        self.read_sizes: list[int] = []
        self.closed = False

    async def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        if size < 0:
            size = len(self._content) - self._offset
        chunk = self._content[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def secure_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_REQUIRED", "true")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", CONTEXT_SECRET)
    monkeypatch.setenv("NODE_ENV", "test")
    return TestClient(main.app, raise_server_exceptions=False)


def _headers() -> dict[str, str]:
    return {
        "x-converter-service-token": SERVICE_TOKEN,
        "x-conversion-context": _context_token(),
    }


def test_read_upload_stops_at_max_plus_one_and_closes_file():
    reader = getattr(main, "read_upload_with_limit", None)
    assert callable(reader)
    upload = TrackingUpload(b"x" * (MIB + 100))

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(reader(upload, MIB))

    assert exc_info.value.status_code == 413
    assert upload.read_sizes == [MIB, 1]
    assert upload._offset == MIB + 1
    assert upload.closed is True


def test_analyze_rejects_oversized_upload_before_workflow(
    secure_client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "5")
    called = False

    def fake_analyze_upload(**_kwargs):
        nonlocal called
        called = True
        return {"upload_id": "upload-1"}

    monkeypatch.setattr(main, "analyze_upload", fake_analyze_upload)
    response = secure_client.post(
        "/api/v1/uploads/analyze",
        headers=_headers(),
        data={"target_template_id": "bsn_sales"},
        files={"file": ("input.xlsx", b"123456", "application/octet-stream")},
    )

    assert response.status_code == 413
    assert called is False


@pytest.mark.parametrize(
    ("path", "data"),
    [
        ("/api/v1/conversions/validate", {"conversion_type": "sales"}),
        ("/api/v1/conversions/preview", {"conversion_type": "sales"}),
        ("/api/v1/conversions", {"conversion_type": "sales"}),
        ("/api/v1/ai/mapping-suggestions", {"conversion_type": "sales"}),
        ("/api/v1/ai/error-check", {"conversion_type": "sales"}),
    ],
)
def test_legacy_and_ai_upload_routes_share_global_limit(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    data: dict[str, str],
):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "5")
    response = secure_client.post(
        path,
        headers=_headers(),
        data=data,
        files={"file": ("input.xlsx", b"123456", "application/octet-stream")},
    )

    assert response.status_code == 413


@pytest.mark.parametrize(
    ("reader_name", "limit_env"),
    [
        ("_read_limited_student_upload", "STUDENT_MAX_FILE_BYTES"),
        ("_read_limited_reconstruction_upload", "RECONSTRUCTION_MAX_FILE_BYTES"),
    ],
)
def test_domain_upload_limits_still_close_oversized_files(
    monkeypatch: pytest.MonkeyPatch, reader_name: str, limit_env: str
):
    monkeypatch.setenv(limit_env, "5")
    upload = TrackingUpload(b"123456")
    reader = getattr(main, reader_name)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(reader(upload))

    assert exc_info.value.status_code == 413
    assert upload.closed is True
