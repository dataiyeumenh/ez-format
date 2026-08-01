from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


TEST_CONVERSION_CONTEXT_SECRET = "pytest-conversion-context-secret-32-bytes-minimum"
TEST_OPERATION_LIFECYCLE_SECRET = "pytest-operation-lifecycle-hmac-secret-32-bytes-minimum"
os.environ["OPERATION_FENCE_HMAC_SECRET"] = TEST_OPERATION_LIFECYCLE_SECRET


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "no_converter_auth: disable converter service-token/local-mode injection",
    )
    config.addinivalue_line(
        "markers",
        "local_converter_operation: explicitly exercise local operation-session bypass",
    )


@pytest.fixture(scope="session", autouse=True)
def _certified_misa_templates(tmp_path_factory):
    from app.conversion_types import CONVERSION_TYPES
    from app.excel_io import write_xls_from_template
    from app.misa_certification import (
        create_manual_certification_record,
        current_writer_build_sha256,
    )
    from app.misa_templates import get_misa_template

    root = tmp_path_factory.mktemp("misa-template-certifications")
    certification_dir = root / "certifications"
    source_dir = root / "synthetic"
    source_dir.mkdir()
    writer_sha256 = current_writer_build_sha256()
    now = datetime.now(timezone.utc)
    fixture_manifest_path = source_dir / "fixture-manifest.json"
    fixture_manifest_entries: dict[str, dict[str, object]] = {}

    previous_certification_dir = os.environ.get("MISA_TEMPLATE_CERTIFICATION_DIR")
    previous_node_env = os.environ.get("NODE_ENV")
    os.environ["MISA_TEMPLATE_CERTIFICATION_DIR"] = str(certification_dir)
    os.environ["NODE_ENV"] = "test"
    try:
        for template_id in CONVERSION_TYPES:
            template = get_misa_template(template_id)
            fixture_id = f"synthetic-{template_id}-pytest-001"
            input_path = source_dir / f"{template_id}-input.csv"
            input_path.write_text(
                f"template_id,document\n{template_id},SYN-{template_id.upper()}-001\n",
                encoding="utf-8",
            )
            output_path = source_dir / f"{template_id}-output.xls"
            required_row = {
                header: f"SYN-{template_id.upper()}-{index:03d}"
                for index, header in enumerate(template.headers, start=1)
                if "(*)" in header
            }
            if not required_row:
                required_row[template.headers[0]] = f"SYN-{template_id.upper()}-001"
            write_xls_from_template(template.workbook, [required_row], output_path)

            receipt_path = source_dir / f"{template_id}-receipt.json"
            receipt_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "receipt_type": "misa_import_receipt",
                        "status": "success",
                        "redacted": True,
                        "synthetic_fixture_id": fixture_id,
                        "imported_rows": 1,
                        "warnings_count": 0,
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            attestation_path = source_dir / f"{template_id}-attestation.json"
            attestation_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "synthetic_fixture_id": fixture_id,
                        "fixture_kind": "synthetic",
                        "privacy_classification": "synthetic_no_customer_data",
                        "contains_customer_data": False,
                        "generator": "converter/tests/conftest.py",
                        "reviewer": "pytest-fixture-privacy-reviewer",
                        "approval_status": "approved",
                        "approved_at_utc": (now - timedelta(days=1)).isoformat(),
                        "input_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
                        "output_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            common_manifest_fields = {
                "source_kind": "deterministic_synthetic",
                "fixture_kind": "synthetic",
                "privacy_classification": "synthetic_no_customer_data",
                "contains_customer_data": False,
                "generator": "converter/tests/conftest.py",
                "reviewer": "pytest-fixture-privacy-reviewer",
                "approval_status": "approved",
                "approved_at_utc": (now - timedelta(days=1)).isoformat(),
            }
            fixture_manifest_entries[f"{template_id}_input"] = {
                **common_manifest_fields,
                "sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
                "path": f"converter/fixtures/certification-tests/{template_id}-input.csv",
                "synthetic_fixture_id": f"synthetic-{template_id}-pytest-input-001",
            }
            fixture_manifest_entries[f"{template_id}_output"] = {
                **common_manifest_fields,
                "sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                "path": f"converter/fixtures/certification-tests/{template_id}-output.xls",
                "synthetic_fixture_id": fixture_id,
            }
            fixture_manifest_path.write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "fixture_version": "pytest-all-templates-1",
                        "fixtures": fixture_manifest_entries,
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            import_result_path = source_dir / f"{template_id}-import-result.json"
            import_result_path.write_text(
                json.dumps(
                    {
                        "schema_version": 3,
                        "evidence_origin": "misa_sandbox_import",
                        "result_artifact_kind": "redacted_json_receipt",
                        "status": "misa_import_passed",
                        "template_sha256": template.sha256,
                        "output_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                        "input_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
                        "result_artifact_sha256": hashlib.sha256(
                            receipt_path.read_bytes()
                        ).hexdigest(),
                        "fixture_attestation_sha256": hashlib.sha256(
                            attestation_path.read_bytes()
                        ).hexdigest(),
                        "synthetic_fixture_id": fixture_id,
                        "privacy_classification": "synthetic_no_customer_data",
                        "misa_product": "MISA synthetic test fixture",
                        "misa_release": "pytest-controlled",
                        "completed_at_utc": (now - timedelta(minutes=5)).isoformat(),
                        "reviewer": "pytest-import-reviewer",
                        "approver": "pytest-release-approver",
                        "writer_build_sha256": writer_sha256,
                        "template_provenance": {
                            "source_kind": template.trust.source_kind,
                            "trust_level": template.trust.trust_level,
                            "official_status": template.trust.official_status,
                        },
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            create_manual_certification_record(
                conversion_type=template_id,
                template_path=template.path,
                input_path=input_path,
                output_path=output_path,
                import_result_path=import_result_path,
                result_artifact_path=receipt_path,
                fixture_attestation_path=attestation_path,
                fixture_manifest_path=fixture_manifest_path,
                artifact_dir=certification_dir,
                expires_at_utc=(now + timedelta(days=90)).isoformat(),
            )
        yield certification_dir
    finally:
        if previous_certification_dir is None:
            os.environ.pop("MISA_TEMPLATE_CERTIFICATION_DIR", None)
        else:
            os.environ["MISA_TEMPLATE_CERTIFICATION_DIR"] = previous_certification_dir
        if previous_node_env is None:
            os.environ.pop("NODE_ENV", None)
        else:
            os.environ["NODE_ENV"] = previous_node_env
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
    if (
        not session_id
        and upload_id
        and (
            path.startswith("/api/v1/mappings/")
            or path == "/api/v1/conversions/export"
        )
    ):
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
        if (
            path.startswith("/api/v1/mappings/")
            or path == "/api/v1/conversions/export"
        ) and session is not None:
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
    secret = os.getenv("CONVERSION_CONTEXT_SECRET", TEST_CONVERSION_CONTEXT_SECRET)
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
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", TEST_CONVERSION_CONTEXT_SECRET)
    monkeypatch.setenv("OPERATION_FENCE_HMAC_SECRET", TEST_OPERATION_LIFECYCLE_SECRET)
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
