from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time

import pytest
from fastapi.testclient import TestClient


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "no_converter_auth: disable converter service-token/local-mode injection",
    )
    config.addinivalue_line(
        "markers",
        "local_converter_operation: explicitly exercise local operation-session bypass",
    )


def _encode_segment(value: dict[str, object]) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _signed_conversion_context(url: object, kwargs: dict) -> str:
    path = str(url).split("?", 1)[0]
    body = kwargs.get("json") if isinstance(kwargs.get("json"), dict) else {}
    form = kwargs.get("data") if isinstance(kwargs.get("data"), dict) else {}
    supplied = body or form
    upload_id = str(supplied.get("upload_id") or "").strip()
    session_id = str(supplied.get("session_id") or "").strip()
    if not session_id:
        match = re.search(r"/api/v1/sessions/([^/?]+)", path)
        session_id = match.group(1) if match else ""
    if not session_id and upload_id and path.startswith("/api/v1/mappings/"):
        try:
            from app.misa_workflow import _read_metadata

            metadata = _read_metadata(upload_id)
            session_id = str(metadata.get("operation_session_id") or "").strip()
        except (KeyError, OSError):
            session_id = ""

    session = None
    if session_id:
        try:
            from app.operation_store import OperationStore

            session = OperationStore().load_session(session_id)
        except Exception:
            session = None

    run_id = str(supplied.get("conversion_run_id") or "").strip()
    if session is not None:
        run_id = str(
            session.revisions[0].context.get("conversion_run_id") or run_id
        ).strip()
    run_id = run_id or "pytest-run-1"
    if body and (
        path.startswith("/api/v1/mappings/")
        or path == "/api/v1/conversions/export"
    ):
        body = dict(body)
        body.setdefault("conversion_run_id", run_id)
        if path.startswith("/api/v1/mappings/") and session is not None:
            body.setdefault("session_id", session.session_id)
            body.setdefault("revision", session.active_revision)
            body.setdefault("state_hash", session.state_hash)
        kwargs["json"] = body

    target_template_id = str(supplied.get("target_template_id") or "").strip()
    owner_scope = "user:pytest-user"
    user_id = "pytest-user"
    workspace_id = None
    if session is not None:
        target_template_id = session.target_template_id
        upload_id = session.upload_id
        owner_scope = session.owner_scope
        user_id = str(session.user_id or "")
        workspace_id = session.workspace_id
    target_template_id = target_template_id or "bsn_sales"

    payload = {
        "purpose": "misa_conversion",
        "user_id": user_id,
        "owner_scope": owner_scope,
        "workspace_id": workspace_id,
        "snapshot_set_hash": None,
        "conversion_context_id": "pytest-context-1",
        "conversion_run_id": run_id,
        "operation_session_id": session_id,
        "upload_id": upload_id,
        "target_template_id": target_template_id,
        "max_file_bytes": 20 * 1024 * 1024,
        "scopes": ["analyze", "preview", "readiness", "confirm", "export"],
        "exp": int(time.time()) + 300,
    }
    header = _encode_segment({"alg": "HS256", "typ": "JWT"})
    encoded_payload = _encode_segment(payload)
    secret = os.getenv("CONVERSION_CONTEXT_SECRET", "pytest-conversion-context-secret")
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{header}.{encoded_payload}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{encoded_payload}.{encoded_signature}"


def _needs_conversion_context(url: object) -> bool:
    path = str(url).split("?", 1)[0]
    return path.startswith(
        (
            "/api/v1/uploads/",
            "/api/v1/mappings/",
            "/api/v1/conversions",
            "/api/v1/ai/",
            "/api/v1/master-data/",
            "/api/v1/sessions/",
        )
    )


@pytest.fixture(autouse=True)
def _authenticate_legacy_api_clients(request, monkeypatch):
    service_token = "pytest-converter-service-token"
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("OPERATION_STORE_ALLOW_LOCAL", "true")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", service_token)
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "pytest-conversion-context-secret")
    if request.node.get_closest_marker("no_converter_auth"):
        yield
        return

    local_operation = bool(request.node.get_closest_marker("local_converter_operation"))
    if local_operation:
        monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")
        monkeypatch.setenv("NODE_ENV", "test")
    else:
        monkeypatch.delenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", raising=False)
    original_request = TestClient.request

    def authenticated_request(self, method, url, **kwargs):
        headers = dict(kwargs.get("headers") or {})
        normalized_headers = {str(key).lower(): value for key, value in headers.items()}
        headers.setdefault(
            "x-converter-service-token",
            os.getenv("CONVERTER_SERVICE_TOKEN") or service_token,
        )
        if local_operation:
            headers.setdefault("x-converter-local-mode", "true")
        else:
            if (
                _needs_conversion_context(url)
                and "x-conversion-context" not in normalized_headers
            ):
                supplied = ""
                for payload_name in ("json", "data"):
                    payload = kwargs.get(payload_name)
                    if isinstance(payload, dict):
                        supplied = str(payload.get("conversion_context_token") or "")
                        if supplied:
                            break
                headers["x-conversion-context"] = supplied or _signed_conversion_context(
                    url, kwargs
                )
        kwargs["headers"] = headers
        return original_request(self, method, url, **kwargs)

    monkeypatch.setattr(TestClient, "request", authenticated_request)
    if not local_operation:
        import app.misa_workflow as workflow
        from app.master_data_client import (
            conversion_context_owner_scope,
            verify_conversion_context_token,
        )
        from app.misa_profiles import ProfileStore

        def owner_scope(token: str) -> str:
            return conversion_context_owner_scope(
                verify_conversion_context_token(token)
            )

        def find_profile(token, *, target_template_id, source_signature_hash):
            return ProfileStore().find_by_signature(
                target_template_id=target_template_id,
                source_signature_hash=source_signature_hash,
                owner_scope=owner_scope(token),
            )

        def save_profile(token, **payload):
            return ProfileStore().save_profile(
                **payload,
                owner_scope=owner_scope(token),
            )

        monkeypatch.setattr(workflow, "find_mapping_profile", find_profile)
        monkeypatch.setattr(workflow, "save_mapping_profile", save_profile)
        monkeypatch.setattr(
            workflow,
            "get_mapping_profile",
            lambda token, profile_id: ProfileStore().get_profile(
                profile_id,
                owner_scope=owner_scope(token),
            ),
        )
        monkeypatch.setattr(
            workflow,
            "mark_mapping_profile_used",
            lambda token, profile_id: ProfileStore().mark_used(
                profile_id,
                owner_scope=owner_scope(token),
            ),
        )
        monkeypatch.setattr(
            workflow,
            "quarantine_mapping_profile",
            lambda token, profile_id, reason: ProfileStore().quarantine_profile(
                profile_id,
                reason=reason,
                owner_scope=owner_scope(token),
            ),
        )
    yield
