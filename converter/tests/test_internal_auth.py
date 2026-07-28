from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import app.main as main
from app.excel_io import InputTable
from app.operation_store import OperationStore, unauthenticated_local_operations_enabled


SERVICE_TOKEN = "test-converter-service-token"
PRODUCTION_SERVICE_TOKEN = "p" * 32
CONTEXT_SECRET = "test-conversion-context-secret"
pytestmark = pytest.mark.no_converter_auth


def _context_token(**overrides: object) -> str:
    payload = {
        "purpose": "misa_conversion",
        "user_id": "user-1",
        "owner_scope": "user:user-1",
        "workspace_id": None,
        "snapshot_set_hash": None,
        "conversion_context_id": "context-1",
        "conversion_run_id": "run-1",
        "operation_session_id": "",
        "upload_id": "upload-1",
        "target_template_id": "bsn_sales",
        "max_file_bytes": 20 * 1024 * 1024,
        "scopes": ["analyze", "preview", "readiness", "confirm", "export"],
        "exp": int(time.time()) + 300,
    }
    payload.update(overrides)

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
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{body}.{encoded_signature}"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_REQUIRED", "true")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", CONTEXT_SECRET)
    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.delenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", raising=False)
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.fixture
def service_headers() -> dict[str, str]:
    return {"x-converter-service-token": SERVICE_TOKEN}


def test_every_non_health_api_route_has_internal_service_dependency():
    routes = [
        route
        for route in main.app.routes
        if isinstance(route, APIRoute) and route.path != "/healthz"
    ]

    assert routes
    missing = []
    for route in routes:
        dependency_names = {
            getattr(dependency.call, "__name__", "")
            for dependency in route.dependant.dependencies
        }
        expected = (
            "require_operation_service_or_local_session"
            if route.path.startswith("/api/v1/sessions/")
            else "require_internal_service"
        )
        if expected not in dependency_names:
            missing.append(f"{','.join(sorted(route.methods or []))} {route.path}")
        if (
            not route.path.startswith("/api/v1/sessions/")
            and "require_operation_service_or_local_session" in dependency_names
        ):
            missing.append(f"local-bypass {route.path}")
    assert missing == []


def test_analyze_without_service_token_returns_401(client: TestClient):
    response = client.post("/api/v1/uploads/analyze")
    assert response.status_code == 401


def test_export_without_service_token_returns_401(client: TestClient):
    response = client.post(
        "/api/v1/conversions/export", json={"upload_id": "upload-1"}
    )
    assert response.status_code == 401


def test_wrong_service_token_returns_401(client: TestClient):
    response = client.get(
        "/api/v1/templates",
        headers={"x-converter-service-token": "wrong-token"},
    )
    assert response.status_code == 401


def test_missing_service_token_config_fails_closed_when_required(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)
    response = client.get("/api/v1/capabilities")
    assert response.status_code == 401


def test_missing_service_token_config_fails_closed_by_default(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_REQUIRED", "false")
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.delenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", raising=False)

    response = client.get("/api/v1/capabilities")

    assert response.status_code == 401


def test_local_mode_never_bypasses_capabilities_service_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_REQUIRED", "false")
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")

    response = client.get(
        "/api/v1/capabilities",
        headers={"x-converter-local-mode": "true"},
    )

    assert response.status_code == 401


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/api/v1/templates", {}),
        ("post", "/api/v1/uploads/analyze", {}),
        (
            "post",
            "/api/v1/mappings/preview",
            {"json": {"upload_id": "missing", "target_template_id": "bsn_sales"}},
        ),
        (
            "post",
            "/api/v1/conversions/export",
            {"json": {"upload_id": "missing", "profile_id": "missing"}},
        ),
        ("post", "/api/v1/ai/explain-validation", {"json": {}}),
        ("get", "/api/v1/student/sessions/missing/overview", {}),
        ("get", "/api/v1/reconstructions/missing", {}),
        ("post", "/api/v1/master-data/parse", {}),
        ("post", "/api/v1/conversions/validate", {}),
    ],
)
def test_local_mode_never_bypasses_non_operation_routes(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    kwargs: dict[str, object],
):
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_REQUIRED", "false")
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")

    response = client.request(
        method,
        path,
        headers={"x-converter-local-mode": "true"},
        **kwargs,
    )

    assert response.status_code == 401


def test_context_verification_is_not_skipped_without_explicit_local_mode(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_REQUIRED", "false")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")
    monkeypatch.setattr(main, "preview_mapping", lambda **_kwargs: {})

    response = client.post(
        "/api/v1/mappings/preview",
        headers=service_headers,
        json={
            "upload_id": "upload-1",
            "target_template_id": "bsn_sales",
            "mapping": {},
        },
    )

    assert response.status_code == 401


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/api/v1/student/sessions/missing/overview", {}),
        ("get", "/api/v1/reconstructions/missing", {}),
        (
            "post",
            "/api/v1/ai/explain-validation",
            {
                "json": {
                    "ok": True,
                    "summary": {},
                    "errors": [],
                    "warnings": [],
                    "detected_columns": {},
                }
            },
        ),
        ("get", "/api/v1/sessions/missing/revisions", {}),
        (
            "post",
            "/api/v1/mappings/preview",
            {"json": {"upload_id": "missing", "target_template_id": "bsn_sales"}},
        ),
    ],
)
def test_representative_routes_require_service_token(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    kwargs: dict[str, object],
):
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_REQUIRED", "false")
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.delenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", raising=False)

    response = client.request(method, path, **kwargs)

    assert response.status_code == 401


def test_context_required_when_unauthenticated_mode_is_false(
    client: TestClient, service_headers: dict[str, str]
):
    response = client.post(
        "/api/v1/mappings/preview",
        headers=service_headers,
        json={"upload_id": "upload-1"},
    )
    assert response.status_code == 401


def test_invalid_mapping_context_is_rejected_even_in_local_mode(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    called = False

    def fake_preview_mapping(**_kwargs):
        nonlocal called
        called = True
        return {}

    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")
    monkeypatch.setattr(main, "preview_mapping", fake_preview_mapping)

    response = client.post(
        "/api/v1/mappings/preview",
        headers={
            **service_headers,
            "x-converter-local-mode": "true",
            "x-conversion-context": "invalid",
        },
        json={
            "upload_id": "upload-1",
            "session_id": "session-1",
            "revision": 1,
            "state_hash": "state-1",
            "target_template_id": "bsn_sales",
            "conversion_run_id": "run-1",
        },
    )

    assert response.status_code == 401
    assert called is False


def test_mapping_requires_session_revision_and_state_before_workflow_access(
    client: TestClient,
    service_headers: dict[str, str],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    store = OperationStore()
    session = store.create_session(
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["code"], rows=[{"code": "A"}]),
        raw_sha256="hash",
        initial_context={"conversion_run_id": "run-1"},
    )
    called = False

    def fake_preview_mapping(**_kwargs):
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(main, "preview_mapping", fake_preview_mapping)
    token = _context_token(operation_session_id=session.session_id)

    response = client.post(
        "/api/v1/mappings/preview",
        headers={**service_headers, "x-conversion-context": token},
        json={
            "upload_id": "upload-1",
            "target_template_id": "bsn_sales",
            "conversion_run_id": "run-1",
        },
    )

    assert response.status_code == 409
    assert called is False


def test_request_body_context_does_not_replace_required_header(
    client: TestClient, service_headers: dict[str, str]
):
    response = client.post(
        "/api/v1/mappings/preview",
        headers=service_headers,
        json={
            "upload_id": "upload-1",
            "conversion_context_token": _context_token(),
        },
    )
    assert response.status_code == 401


def test_analyze_rejects_template_binding_before_reading_upload(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    called = False

    def fake_analyze_upload(**_kwargs):
        nonlocal called
        called = True
        return {"upload_id": "upload-1"}

    monkeypatch.setattr(main, "analyze_upload", fake_analyze_upload)
    headers = {
        **service_headers,
        "x-conversion-context": _context_token(target_template_id="purchase_domestic"),
    }
    response = client.post(
        "/api/v1/uploads/analyze",
        headers=headers,
        data={"target_template_id": "bsn_sales"},
        files={"file": ("input.xlsx", b"small", "application/octet-stream")},
    )

    assert response.status_code == 409
    assert called is False


def test_analyze_allows_blank_target_only_for_initial_auto_detection(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    captured = {}

    def fake_analyze_upload(**kwargs):
        captured.update(kwargs)
        return {
            "upload_id": "upload-1",
            "target_template_id": "bsn_sales",
            "operation_session_id": kwargs["operation_session_id"],
            "session": {"session_id": kwargs["operation_session_id"]},
        }

    monkeypatch.setattr(main, "analyze_upload", fake_analyze_upload)
    headers = {
        **service_headers,
        "x-conversion-context": _context_token(
            operation_session_id="trusted-session",
            upload_id="",
            target_template_id="",
            scopes=["analyze"],
        ),
    }

    response = client.post(
        "/api/v1/uploads/analyze",
        headers=headers,
        data={
            "conversion_run_id": "run-1",
            "operation_session_id": "trusted-session",
        },
        files={"file": ("input.xlsx", b"small", "application/octet-stream")},
    )

    assert response.status_code == 200
    assert captured.get("target_template_id") is None
    assert captured["operation_session_id"] == "trusted-session"
    assert captured["conversion_run_id"] == "run-1"


def test_analyze_rejects_preallocated_session_mismatch_before_reading_upload(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    called = False

    def fake_analyze_upload(**_kwargs):
        nonlocal called
        called = True
        return {"upload_id": "upload-1"}

    monkeypatch.setattr(main, "analyze_upload", fake_analyze_upload)
    headers = {
        **service_headers,
        "x-conversion-context": _context_token(
            operation_session_id="trusted-session",
            upload_id="",
        ),
    }
    response = client.post(
        "/api/v1/uploads/analyze",
        headers=headers,
        data={
            "target_template_id": "bsn_sales",
            "conversion_run_id": "run-1",
            "operation_session_id": "browser-session-must-not-win",
        },
        files={"file": ("input.xlsx", b"small", "application/octet-stream")},
    )

    assert response.status_code == 409
    assert called is False


def test_analyze_rejects_preallocated_session_without_run_binding_before_upload(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    called = False

    def fake_analyze_upload(**_kwargs):
        nonlocal called
        called = True
        return {"upload_id": "upload-1"}

    monkeypatch.setattr(main, "analyze_upload", fake_analyze_upload)
    headers = {
        **service_headers,
        "x-conversion-context": _context_token(
            operation_session_id="trusted-session",
            upload_id="",
        ),
    }
    response = client.post(
        "/api/v1/uploads/analyze",
        headers=headers,
        data={
            "target_template_id": "bsn_sales",
            "operation_session_id": "trusted-session",
        },
        files={"file": ("input.xlsx", b"small", "application/octet-stream")},
    )

    assert response.status_code == 409
    assert called is False


def test_analyze_forwards_only_matching_preallocated_session_binding(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    captured = {}

    def fake_analyze_upload(**kwargs):
        captured.update(kwargs)
        return {
            "upload_id": "upload-1",
            "operation_session_id": kwargs["operation_session_id"],
            "session": {"session_id": kwargs["operation_session_id"]},
        }

    monkeypatch.setattr(main, "analyze_upload", fake_analyze_upload)
    headers = {
        **service_headers,
        "x-conversion-context": _context_token(
            operation_session_id="trusted-session",
            upload_id="",
        ),
    }
    response = client.post(
        "/api/v1/uploads/analyze",
        headers=headers,
        data={
            "target_template_id": "bsn_sales",
            "conversion_run_id": "run-1",
            "operation_session_id": "trusted-session",
        },
        files={"file": ("input.xlsx", b"small", "application/octet-stream")},
    )

    assert response.status_code == 200
    assert captured["operation_session_id"] == "trusted-session"
    assert captured["conversion_run_id"] == "run-1"


def test_operation_session_checks_upload_and_template_binding_before_table_access(
    client: TestClient,
    service_headers: dict[str, str],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    store = OperationStore()
    session = store.create_session(
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["code"], rows=[{"code": "A"}]),
        raw_sha256="hash",
    )
    token = _context_token(
        operation_session_id=session.session_id,
        upload_id="different-upload",
        scopes=["preview"],
    )

    response = client.get(
        f"/api/v1/sessions/{session.session_id}/revisions",
        headers={**service_headers, "x-conversion-context": token},
    )

    assert response.status_code == 404


def test_explicit_local_mode_allows_only_stored_local_operation_session(
    client: TestClient,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "local-dev-service-token")
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    store = OperationStore()
    local_session = store.create_session(
        upload_id="local-upload",
        owner_scope="local:default",
        user_id=None,
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["code"], rows=[{"code": "A"}]),
        raw_sha256="local-hash",
    )
    secure_session = store.create_session(
        upload_id="secure-upload",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["code"], rows=[{"code": "B"}]),
        raw_sha256="secure-hash",
        initial_context={"conversion_run_id": "run-1"},
    )
    headers = {"x-converter-local-mode": "true"}

    local_response = client.get(
        f"/api/v1/sessions/{local_session.session_id}/revisions",
        headers=headers,
    )
    secure_response = client.get(
        f"/api/v1/sessions/{secure_session.session_id}/revisions",
        headers=headers,
    )

    assert local_response.status_code == 200
    assert secure_response.status_code == 401


def test_operation_session_rejects_different_conversion_run(
    client: TestClient,
    service_headers: dict[str, str],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    store = OperationStore()
    session = store.create_session(
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["code"], rows=[{"code": "A"}]),
        raw_sha256="hash",
        initial_context={"conversion_run_id": "run-A"},
    )
    token = _context_token(
        operation_session_id=session.session_id,
        conversion_run_id="run-B",
    )

    response = client.get(
        f"/api/v1/sessions/{session.session_id}/revisions",
        headers={**service_headers, "x-conversion-context": token},
    )

    assert response.status_code == 404


@pytest.mark.parametrize("method", ["post", "delete"])
def test_comparison_mutations_reject_preview_only_context(
    client: TestClient,
    service_headers: dict[str, str],
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
):
    monkeypatch.setenv("OPERATION_SESSION_DIR", str(tmp_path / "sessions"))
    store = OperationStore()
    session = store.create_session(
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="bsn_sales",
        target_template_version="v1",
        source_signature={},
        table=InputTable(headers=["code"], rows=[{"code": "A"}]),
        raw_sha256="hash",
    )
    token = _context_token(
        operation_session_id=session.session_id,
        scopes=["preview"],
    )
    headers = {**service_headers, "x-conversion-context": token}
    path = f"/api/v1/sessions/{session.session_id}/comparison-files"
    if method == "post":
        response = client.post(
            path,
            headers=headers,
            data={"role": "sales", "revision": "1", "state_hash": session.state_hash},
            files={"file": ("comparison.xlsx", b"not-read", "application/octet-stream")},
        )
    else:
        response = client.delete(
            f"{path}/missing",
            headers=headers,
            params={"revision": 1, "state_hash": session.state_hash},
        )

    assert response.status_code in {401, 403}


def test_export_requires_stored_template_binding_when_body_omits_target(
    client: TestClient,
    service_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    called = False

    def fake_export(**_kwargs):
        nonlocal called
        called = True
        return b"xls", "export.xls"

    monkeypatch.setattr(main, "export_confirmed_profile", fake_export)
    monkeypatch.setattr(
        main,
        "_read_export_binding",
        lambda _upload_id, **_kwargs: {
            "target_template_id": "purchase_domestic",
            "operation_session_id": "",
            "profile_id": "profile-1",
        },
        raising=False,
    )
    response = client.post(
        "/api/v1/conversions/export",
        headers={**service_headers, "x-conversion-context": _context_token()},
        json={
            "upload_id": "upload-1",
            "profile_id": "profile-1",
            "acknowledge_warnings": True,
        },
    )

    assert response.status_code == 409
    assert called is False


def test_local_mode_is_only_allowed_when_explicitly_enabled_outside_production(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "true")
    monkeypatch.setenv("NODE_ENV", "production")
    assert unauthenticated_local_operations_enabled() is False


def test_production_startup_rejects_unsafe_flags(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", PRODUCTION_SERVICE_TOKEN)
    monkeypatch.setenv("ALLOW_LEGACY_ROW_EXPORT", "true")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false")
    assertion = getattr(main, "_assert_secure_production_config", None)

    assert callable(assertion)
    with pytest.raises(RuntimeError, match="ALLOW_LEGACY_ROW_EXPORT"):
        assertion()


@pytest.mark.parametrize(
    "service_token",
    ["short-local-token", "replace-with-a-long-random-secret"],
)
def test_production_startup_rejects_weak_or_placeholder_service_token(
    monkeypatch: pytest.MonkeyPatch, service_token: str
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", service_token)
    monkeypatch.setenv("ALLOW_LEGACY_ROW_EXPORT", "false")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "c" * 32)
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")

    with pytest.raises(RuntimeError, match="CONVERTER_SERVICE_TOKEN"):
        main._assert_secure_production_config()


def test_production_startup_requires_dedicated_context_secret(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", PRODUCTION_SERVICE_TOKEN)
    monkeypatch.setenv("ALLOW_LEGACY_ROW_EXPORT", "false")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false")
    monkeypatch.delenv("CONVERSION_CONTEXT_SECRET", raising=False)
    monkeypatch.setenv("JWT_SECRET", "general-auth-secret")
    monkeypatch.setenv("CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK", "true")

    with pytest.raises(RuntimeError, match="CONVERSION_CONTEXT_SECRET"):
        main._assert_secure_production_config()


def test_production_startup_rejects_weak_context_secret(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", PRODUCTION_SERVICE_TOKEN)
    monkeypatch.setenv("ALLOW_LEGACY_ROW_EXPORT", "false")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "weak-secret")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")

    with pytest.raises(RuntimeError, match="at least 32 characters"):
        main._assert_secure_production_config()


def test_production_startup_requires_student_anonymization_secret_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", PRODUCTION_SERVICE_TOKEN)
    monkeypatch.setenv("ALLOW_LEGACY_ROW_EXPORT", "false")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS", "false")
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "c" * 32)
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.delenv("STUDENT_ANONYMIZATION_SECRET", raising=False)
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")

    with pytest.raises(RuntimeError, match="STUDENT_ANONYMIZATION_SECRET"):
        main._assert_secure_production_config()


def test_healthz_contains_only_status_values(monkeypatch: pytest.MonkeyPatch):
    response = TestClient(main.app).get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "capabilities": {"converter": True, "operations": True},
    }
