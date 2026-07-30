import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

from openpyxl import Workbook

from app.misa_profiles import MappingProfile
from app.master_data_client import ConversionContextError
from app.misa_workflow import (
    analyze_upload,
    confirm_mapping,
    export_confirmed_profile,
    preview_mapping,
    readiness_mapping,
)
from app import misa_workflow


def _raw_file(path: Path, item_code: str) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Số hóa đơn", "Ngày", "Mã hàng", "Số lượng", "Đơn giá"])
    sheet.append(["HD001", "13/07/2026", item_code, 1, 100000])
    workbook.save(path)
    return path.read_bytes()


def _mapping() -> dict:
    return {
        "Số hóa đơn": "Số chứng từ (*)",
        "Ngày": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
        "Mã hàng": "Mã hàng (*)",
        "Số lượng": "Số lượng",
        "Đơn giá": "Đơn giá",
    }


def _context(alias_raw: str | None = None) -> dict:
    aliases = []
    if alias_raw:
        aliases.append(
            {
                "normalizedRawValue": alias_raw,
                "targetCode": "HH001",
                "normalizedTargetCode": "HH001",
            }
        )
    return {
        "workspace": {"id": "workspace-1", "name": "BAE"},
        "snapshotSetHash": "snapshot-hash",
        "catalogs": {
            "item": {
                "entries": [
                    {
                        "code": "HH001",
                        "normalizedCode": "HH001",
                        "name": "Bánh gạo",
                        "normalizedName": "banh gao",
                        "active": True,
                    }
                ],
                "aliases": aliases,
            }
        },
    }


def _patch_context(monkeypatch, context: dict):
    from app.master_data_client import verify_conversion_context_token

    def verify_test_context(token: str) -> dict:
        if token == "context-token":
            return {
                "workspace_id": "workspace-1",
                "snapshot_set_hash": "snapshot-hash",
            }
        return verify_conversion_context_token(token)

    monkeypatch.setattr(
        "app.misa_workflow.verify_conversion_context_token",
        verify_test_context,
    )
    monkeypatch.setattr(
        "app.misa_workflow.fetch_master_data_context", lambda _token: context
    )
    monkeypatch.setattr(
        "app.misa_workflow.find_mapping_profile", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        "app.misa_workflow.mark_mapping_profile_used", lambda *_args, **_kwargs: None
    )


def _operation_state(analyzed: dict) -> dict[str, object]:
    session = analyzed["session"]
    assert session is not None
    return {
        "session_id": session["session_id"],
        "revision": session["active_revision"],
        "state_hash": session["state_hash"],
    }


def _context_token(analyzed: dict) -> str:
    session = analyzed["session"]
    assert session is not None
    from app.operation_store import OperationStore

    stored = OperationStore().load_session(session["session_id"])
    payload = {
        "purpose": "misa_conversion",
        "user_id": str(stored.user_id or ""),
        "owner_scope": stored.owner_scope,
        "workspace_id": str(stored.workspace_id or ""),
        "snapshot_set_hash": "snapshot-hash",
        "conversion_context_id": "context-id",
        "conversion_run_id": str(
            stored.revisions[0].context.get("conversion_run_id") or ""
        ),
        "operation_session_id": session["session_id"],
        "upload_id": analyzed["upload_id"],
        "target_template_id": stored.target_template_id,
        "max_file_bytes": 20 * 1024 * 1024,
        "scopes": ["analyze", "preview", "readiness", "confirm", "export"],
        "exp": int(time.time()) + 300,
    }

    def encode(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = encode({"alg": "HS256", "typ": "JWT"})
    body = encode(payload)
    secret = os.getenv("CONVERSION_CONTEXT_SECRET", "pytest-conversion-context-secret")
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{header}.{body}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{header}.{body}.{encoded_signature}"


def test_preview_applies_confirmed_master_data_alias(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    _patch_context(monkeypatch, _context(alias_raw="ten hang raw"))
    content = _raw_file(tmp_path / "raw.xlsx", "Tên hàng raw")

    analyze = analyze_upload(
        filename="raw.xlsx",
        content=content,
        requested_target_template_id="bsn_sales",
        conversion_context_token="context-token",
    )
    context_token = _context_token(analyze)
    preview = preview_mapping(
        upload_id=analyze["upload_id"],
        target_template_id="bsn_sales",
        mapping=_mapping(),
        defaults={
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
        },
        conversion_context_token=context_token,
        **_operation_state(analyze),
    )

    assert preview["rows"][0]["Mã hàng (*)"] == "HH001"
    item_resolution = next(
        item
        for item in preview["master_data"]["resolutions"]
        if item["catalog_type"] == "item"
    )
    assert item_resolution["status"] == "verified"


def test_readiness_blocks_unknown_required_master_data_code(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    _patch_context(monkeypatch, _context())
    content = _raw_file(tmp_path / "raw.xlsx", "UNKNOWN")

    analyze = analyze_upload(
        filename="raw.xlsx",
        content=content,
        requested_target_template_id="bsn_sales",
        conversion_context_token="context-token",
    )
    context_token = _context_token(analyze)
    report = readiness_mapping(
        upload_id=analyze["upload_id"],
        target_template_id="bsn_sales",
        mapping=_mapping(),
        defaults={
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
        },
        conversion_context_token=context_token,
        **_operation_state(analyze),
    )

    assert report["summary"]["blocker"] >= 1
    assert any(
        issue["code"] == "master_data_required_code_missing"
        for issue in report["issues"]
    )


def test_context_cannot_change_after_analyze(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    _patch_context(monkeypatch, _context())
    content = _raw_file(tmp_path / "raw.xlsx", "HH001")
    analyze = analyze_upload(
        filename="raw.xlsx",
        content=content,
        requested_target_template_id="bsn_sales",
        conversion_context_token="context-token",
    )
    context_token = _context_token(analyze)
    from app.operation_store import OperationStore

    stored = OperationStore().load_session(analyze["session"]["session_id"])
    monkeypatch.setattr(
        "app.misa_workflow.verify_conversion_context_token",
        lambda _token: {
            "workspace_id": "workspace-1",
            "snapshot_set_hash": "other-hash",
            "user_id": str(stored.user_id or ""),
            "owner_scope": stored.owner_scope,
            "operation_session_id": stored.session_id,
            "upload_id": analyze["upload_id"],
            "target_template_id": stored.target_template_id,
            "conversion_run_id": str(
                stored.revisions[0].context.get("conversion_run_id") or ""
            ),
            "scopes": ["preview"],
        },
    )

    try:
        preview_mapping(
            upload_id=analyze["upload_id"],
            target_template_id="bsn_sales",
            mapping=_mapping(),
            conversion_context_token=context_token,
            **_operation_state(analyze),
        )
    except ValueError as exc:
        assert "không khớp" in str(exc)
    else:
        raise AssertionError("Expected context mismatch to fail")


def test_confirm_saves_workspace_mapping_profile_in_node_backend(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    _patch_context(monkeypatch, _context())
    captured = {}

    def save_profile(_token, **payload):
        captured.update(payload)
        return MappingProfile(
            id="mongo-profile-1",
            name=payload["name"],
            target_template_id=payload["target_template_id"],
            source_signature_hash=payload["source_signature_hash"],
            source_headers=payload["source_headers"],
            sheet_name=payload["sheet_name"],
            header_row=payload["header_row"],
            mapping=payload["mapping"],
            defaults=payload["defaults"],
            formulas=payload["formulas"],
            confidence=payload["confidence"],
            usage_count=0,
            workspace_id="workspace-1",
        )

    monkeypatch.setattr("app.misa_workflow.save_mapping_profile", save_profile)
    content = _raw_file(tmp_path / "raw.xlsx", "HH001")
    analyze = analyze_upload(
        filename="raw.xlsx",
        content=content,
        requested_target_template_id="bsn_sales",
        conversion_context_token="context-token",
    )
    context_token = _context_token(analyze)

    result = confirm_mapping(
        upload_id=analyze["upload_id"],
        target_template_id="bsn_sales",
        mapping=_mapping(),
        defaults={"Hình thức bán hàng": "Bán hàng hóa trong nước"},
        conversion_context_token=context_token,
        **_operation_state(analyze),
    )

    assert result["profile_id"] == "mongo-profile-1"
    assert result["saved"] is True
    assert result["mapping_profile_kind"] == "v1"
    assert result["session"]["session_id"] == analyze["session"]["session_id"]
    assert captured["source_signature_hash"] == analyze["detected"]["source_signature_hash"]


def test_preview_rejects_stale_master_data_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    _patch_context(monkeypatch, _context())
    content = _raw_file(tmp_path / "raw.xlsx", "HH001")
    analyze = analyze_upload(
        filename="raw.xlsx",
        content=content,
        requested_target_template_id="bsn_sales",
        conversion_context_token="context-token",
    )
    context_token = _context_token(analyze)

    def stale_context(_token):
        raise ConversionContextError(
            "Danh mục hoặc alias MISA đã thay đổi",
            status_code=409,
        )

    monkeypatch.setattr("app.misa_workflow.fetch_master_data_context", stale_context)

    try:
        preview_mapping(
            upload_id=analyze["upload_id"],
            target_template_id="bsn_sales",
            mapping=_mapping(),
            conversion_context_token=context_token,
            **_operation_state(analyze),
        )
    except ValueError as exc:
        assert "đã thay đổi" in str(exc)
    else:
        raise AssertionError("Expected stale context to fail")


def test_export_derives_workspace_owner_from_legacy_upload_metadata(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    _patch_context(monkeypatch, _context())
    content = _raw_file(tmp_path / "raw.xlsx", "HH001")
    analyzed = analyze_upload(
        filename="raw.xlsx",
        content=content,
        requested_target_template_id="bsn_sales",
        conversion_context_token="context-token",
    )
    context_token = _context_token(analyzed)
    suggestion = analyzed["mapping_suggestion"]
    metadata_path = misa_workflow._metadata_path(analyzed["upload_id"])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.pop("owner_scope", None)
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    monkeypatch.setattr(
        "app.misa_workflow.get_mapping_profile",
        lambda *_args, **_kwargs: MappingProfile(
            id="mongo-profile-1",
            name="Legacy workspace profile",
            target_template_id="bsn_sales",
            source_signature_hash=analyzed["detected"]["source_signature_hash"],
            source_headers=analyzed["detected"]["headers"],
            sheet_name=analyzed["detected"]["sheet_name"],
            header_row=analyzed["detected"]["header_row"],
            mapping=suggestion["mapping"],
            defaults=suggestion["defaults"],
            formulas=suggestion["formulas"],
            confidence=1.0,
            usage_count=0,
            owner_scope="workspace:workspace-1",
            workspace_id="workspace-1",
        ),
    )
    readiness = SimpleNamespace(summary=SimpleNamespace(blocker=0, warning=0))
    monkeypatch.setattr(
        "app.misa_workflow.build_readiness_report", lambda *_args, **_kwargs: readiness
    )
    monkeypatch.setattr(
        "app.misa_workflow.add_master_data_resolutions",
        lambda report, *_args, **_kwargs: report,
    )

    content, filename = export_confirmed_profile(
        analyzed["upload_id"],
        "mongo-profile-1",
        acknowledge_warnings=True,
        conversion_context_token=context_token,
        **_operation_state(analyzed),
    )

    assert content
    assert filename.endswith(".xls")
