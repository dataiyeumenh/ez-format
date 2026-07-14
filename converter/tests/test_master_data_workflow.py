from pathlib import Path

from openpyxl import Workbook

from app.misa_profiles import MappingProfile
from app.master_data_client import ConversionContextError
from app.misa_workflow import (
    analyze_upload,
    confirm_mapping,
    preview_mapping,
    readiness_mapping,
)


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
    monkeypatch.setattr(
        "app.misa_workflow.verify_conversion_context_token",
        lambda _token: {
            "workspace_id": "workspace-1",
            "snapshot_set_hash": "snapshot-hash",
        },
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
    preview = preview_mapping(
        upload_id=analyze["upload_id"],
        target_template_id="bsn_sales",
        mapping=_mapping(),
        defaults={
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
        },
        conversion_context_token="context-token",
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
    report = readiness_mapping(
        upload_id=analyze["upload_id"],
        target_template_id="bsn_sales",
        mapping=_mapping(),
        defaults={
            "Hình thức bán hàng": "Bán hàng hóa trong nước",
            "Phương thức thanh toán": "Chưa thu tiền",
        },
        conversion_context_token="context-token",
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
    monkeypatch.setattr(
        "app.misa_workflow.verify_conversion_context_token",
        lambda _token: {
            "workspace_id": "workspace-2",
            "snapshot_set_hash": "other-hash",
        },
    )

    try:
        preview_mapping(
            upload_id=analyze["upload_id"],
            target_template_id="bsn_sales",
            mapping=_mapping(),
            conversion_context_token="other-token",
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

    result = confirm_mapping(
        upload_id=analyze["upload_id"],
        target_template_id="bsn_sales",
        mapping=_mapping(),
        defaults={"Hình thức bán hàng": "Bán hàng hóa trong nước"},
        conversion_context_token="context-token",
    )

    assert result == {"profile_id": "mongo-profile-1", "saved": True}
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
            conversion_context_token="context-token",
        )
    except ValueError as exc:
        assert "đã thay đổi" in str(exc)
    else:
        raise AssertionError("Expected stale context to fail")
