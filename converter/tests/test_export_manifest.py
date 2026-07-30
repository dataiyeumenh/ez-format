import asyncio
from decimal import Decimal
from types import SimpleNamespace

import pytest
import xlrd

from app.export_manifest import build_export_manifest
from app.excel_io import InputTable
from app.misa_templates import list_misa_templates
from app import main, misa_workflow


def _manifest(**overrides):
    values = {
        "conversion_id": "run-1",
        "export_batch_id": "batch-1",
        "target_template_id": "bsn_sales",
        "template_hash": "a" * 64,
        "raw_file_hash": "b" * 64,
        "mapping_profile_id": "profile-1",
        "mapping_profile_version": 2,
        "validation_ruleset_version": "misa-readiness-v1",
        "output_rows": [
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH01", "Thành tiền": "100"},
            {"Số chứng từ (*)": "BH0001", "Mã hàng (*)": "HH02", "Thành tiền": "200"},
        ],
        "row_origins": [
            {"raw_sheet": "Raw", "raw_rows": [2]},
            {"raw_sheet": "Raw", "raw_rows": [3, 4]},
        ],
    }
    values.update(overrides)
    return build_export_manifest(**values)


def test_manifest_preserves_many_raw_rows_for_one_output_document():
    manifest = _manifest()

    assert len(manifest.document_groups) == 1
    assert manifest.rows[1].raw_row_ids != manifest.rows[0].raw_row_ids
    assert len(manifest.rows[1].raw_row_ids) == 2
    assert manifest.document_groups[0]["amount_total"] == "300"


def test_manifest_locator_is_minimal_and_preserves_accounting_strings():
    manifest = _manifest(
        output_rows=[
            {
                "Số chứng từ (*)": "000012",
                "Mã khách hàng": "KH0007",
                "Tên khách hàng": "Không được lưu",
                "Mã số thuế": "0100000000",
                "Địa chỉ": "Không được lưu",
                "Mã hàng (*)": "HH0003",
                "Thành tiền": Decimal("100.50"),
            }
        ],
        row_origins=[{"raw_sheet": "Raw", "raw_rows": [2]}],
    )

    locator = manifest.rows[0].locator
    assert locator == {
        "document_number": "000012",
        "invoice_number": None,
        "document_date": None,
        "invoice_date": None,
        "partner_code": "KH0007",
        "item_code": "HH0003",
        "amount": "100.50",
    }
    assert "tax" not in " ".join(locator).lower()
    with pytest.raises(Exception):
        manifest.conversion_id = "other-run"


def test_line_fingerprint_covers_complete_normalized_output_row():
    base = {
        "Số chứng từ (*)": "BH0001",
        "Mã hàng (*)": "HH01",
        "Thành tiền": "100",
        "TK Doanh thu/Có (*)": "001",
        "Thuế suất GTGT (%)": "10",
        "Số lượng": Decimal("2.00"),
        "Ghi chú": "",
    }

    def fingerprint(row):
        return _manifest(
            output_rows=[row],
            row_origins=[{"raw_sheet": "Raw", "raw_rows": [2]}],
        ).rows[0].line_fingerprint

    expected = fingerprint(base)
    assert fingerprint(dict(reversed(list(base.items())))) == expected
    assert fingerprint({**base, "TK Doanh thu/Có (*)": "002"}) != expected
    assert fingerprint({**base, "Thuế suất GTGT (%)": "5"}) != expected
    assert fingerprint({**base, "Số lượng": Decimal("3.00")}) != expected
    assert fingerprint({**base, "Ghi chú": "0"}) != expected


def test_manifest_marks_fallback_grouping_as_unknown():
    manifest = _manifest(
        output_rows=[{"Mã hàng (*)": "HH01", "Thành tiền": "0"}],
        row_origins=[{"raw_sheet": "Raw", "raw_rows": [2]}],
    )

    assert manifest.document_groups[0]["group_integrity"] == "unknown"
    assert manifest.document_groups[0]["amount_total"] == "0"


def test_group_integrity_depends_on_group_key_not_optional_amount():
    manifest = _manifest(
        output_rows=[{"Số chứng từ (*)": "BH001", "Mã khách hàng": "KH001"}],
        row_origins=[{"raw_sheet": "Raw", "raw_rows": [2]}],
    )

    assert manifest.document_groups[0]["group_integrity"] == "deterministic"
    assert manifest.document_groups[0]["amount_total"] is None


def test_group_integrity_is_unknown_when_any_member_lacks_verified_origin():
    manifest = _manifest(
        output_rows=[
            {
                "Số chứng từ (*)": "BH0001",
                "Mã khách hàng": "KH001",
                "Mã hàng (*)": "HH01",
                "Thành tiền": "100",
            },
            {
                "Số chứng từ (*)": "BH0001",
                "Mã khách hàng": "KH001",
                "Mã hàng (*)": "HH02",
                "Thành tiền": "200",
            },
        ],
        row_origins=[
            {"raw_sheet": "Raw", "raw_rows": [2]},
            {"raw_sheet": "", "raw_rows": []},
        ]
    )

    assert manifest.rows[0].raw_row_ids
    assert not manifest.rows[1].raw_row_ids
    assert manifest.document_groups[0]["group_integrity"] == "unknown"


def test_mapped_rows_keep_exact_source_row_origins():
    table = InputTable(
        headers=["Số CT", "Mã hàng", "Tiền"],
        rows=[
            {"Số CT": "BH001", "Mã hàng": "HH01", "Tiền": "100"},
            {"Số CT": "BH001", "Mã hàng": "HH02", "Tiền": "200"},
        ],
        sheet_name="Raw",
        header_row_index=3,
    )

    rows, origins = misa_workflow._mapped_rows_with_origins(
        table,
        ["Số chứng từ (*)", "Mã hàng (*)", "Thành tiền"],
        {"Số CT": "Số chứng từ (*)", "Mã hàng": "Mã hàng (*)", "Tiền": "Thành tiền"},
        {},
        {},
    )

    assert [row["Mã hàng (*)"] for row in rows] == ["HH01", "HH02"]
    assert origins == [
        {"raw_sheet": "Raw", "raw_rows": [5]},
        {"raw_sheet": "Raw", "raw_rows": [6]},
    ]


def _resolve_provenance_fixture(
    monkeypatch,
    *,
    edited_rows=None,
    trusted_session_rows=None,
):
    raw_rows = [
        {"Số CT": "BH001", "Mã KH": "KH001", "Mã hàng": "HH01", "Tiền": "100"},
        {"Số CT": "BH001", "Mã KH": "KH001", "Mã hàng": "HH02", "Tiền": "200"},
    ]
    table = InputTable(
        headers=["Số CT", "Mã KH", "Mã hàng", "Tiền"],
        rows=raw_rows,
        sheet_name="Raw",
        header_row_index=0,
    )
    profile = SimpleNamespace(
        target_template_id="bsn_sales",
        mapping={
            "Số CT": "Số chứng từ (*)",
            "Mã KH": "Mã khách hàng",
            "Mã hàng": "Mã hàng (*)",
            "Tiền": "Thành tiền",
        },
        defaults={},
        formulas={},
    )
    template = SimpleNamespace(
        id="bsn_sales",
        headers=["Số chứng từ (*)", "Mã khách hàng", "Mã hàng (*)", "Thành tiền"],
    )
    store = SimpleNamespace(
        materialize_rows_with_ids=lambda *_args, **_kwargs: trusted_session_rows or []
    )

    monkeypatch.setattr(misa_workflow, "_assert_student_upload_context", lambda *_a, **_k: None)
    monkeypatch.setattr(misa_workflow, "_assert_operation_state", lambda *_a, **_k: None)
    monkeypatch.setattr(misa_workflow, "_read_upload_table", lambda *_a, **_k: table)
    monkeypatch.setattr(
        misa_workflow,
        "_read_metadata",
        lambda *_a, **_k: {"raw_sha256": "b" * 64},
    )
    monkeypatch.setattr(
        misa_workflow,
        "_context_for_upload",
        lambda *_a, **_k: (None, "not_configured", None),
    )
    monkeypatch.setattr(
        misa_workflow,
        "_owner_scope_from_upload_metadata",
        lambda *_a, **_k: "user:pytest-user",
    )
    monkeypatch.setattr(
        misa_workflow,
        "ProfileStore",
        lambda: SimpleNamespace(get_profile=lambda *_a, **_k: profile),
    )
    monkeypatch.setattr(misa_workflow, "OperationStore", lambda **_k: store)
    monkeypatch.setattr(misa_workflow, "get_misa_template", lambda *_a, **_k: template)
    monkeypatch.setattr(
        misa_workflow,
        "sanitize_mapping_for_template",
        lambda _template_id, mapping: mapping,
    )
    monkeypatch.setattr(
        misa_workflow,
        "sanitize_defaults_for_template",
        lambda _template_id, defaults, _headers: defaults,
    )
    monkeypatch.setattr(
        misa_workflow,
        "resolve_master_data",
        lambda rows, *_a, **_k: SimpleNamespace(rows=rows, resolutions=[]),
    )
    monkeypatch.setattr(misa_workflow, "_source_system_for_upload", lambda *_a: "unknown")
    monkeypatch.setattr(
        misa_workflow,
        "build_readiness_report",
        lambda *_a, **_k: SimpleNamespace(
            summary=SimpleNamespace(blocker=0, warning=0)
        ),
    )
    monkeypatch.setattr(
        misa_workflow,
        "add_master_data_resolutions",
        lambda report, *_a, **_k: report,
    )

    return misa_workflow._resolve_confirmed_export(
        upload_id="upload-1",
        profile_id="profile-1",
        edited_rows=edited_rows,
        conversion_context_token=None,
        session_id="session-1" if trusted_session_rows is not None else None,
        revision=2,
        state_hash="state-2",
    )


def test_same_count_reorder_keeps_server_side_row_origins(monkeypatch):
    resolved = _resolve_provenance_fixture(
        monkeypatch,
        trusted_session_rows=[
            {
                "row_id": "r2",
                "values": {"Số CT": "BH001", "Mã KH": "KH001", "Mã hàng": "HH02", "Tiền": "200"},
                "source_origin": {"raw_sheet": "Raw", "raw_rows": [3]},
            },
            {
                "row_id": "r1",
                "values": {"Số CT": "BH001", "Mã KH": "KH001", "Mã hàng": "HH01", "Tiền": "100"},
                "source_origin": {"raw_sheet": "Raw", "raw_rows": [2]},
            },
        ],
    )

    assert [row["Mã hàng (*)"] for row in resolved.rows] == ["HH02", "HH01"]
    assert resolved.row_origins == [
        {"raw_sheet": "Raw", "raw_rows": [3]},
        {"raw_sheet": "Raw", "raw_rows": [2]},
    ]


def test_same_count_replacement_has_unknown_group_provenance(monkeypatch):
    resolved = _resolve_provenance_fixture(
        monkeypatch,
        trusted_session_rows=[
            {
                "row_id": "r1",
                "values": {"Số CT": "BH001", "Mã KH": "KH001", "Mã hàng": "HH01", "Tiền": "100"},
                "source_origin": {"raw_sheet": "Raw", "raw_rows": [2]},
            },
            {
                "row_id": "replacement",
                "values": {"Số CT": "BH001", "Mã KH": "KH001", "Mã hàng": "REPLACED", "Tiền": "200"},
            },
        ],
    )
    manifest = _manifest(output_rows=resolved.rows, row_origins=resolved.row_origins)

    assert resolved.row_origins == [
        {"raw_sheet": "Raw", "raw_rows": [2]},
        {"raw_sheet": "", "raw_rows": []},
    ]
    assert manifest.rows[0].raw_row_ids
    assert not manifest.rows[1].raw_row_ids
    assert manifest.document_groups[0]["group_integrity"] == "unknown"


def test_manifest_workflow_uses_resolved_export_rows_and_hashes(tmp_path, monkeypatch):
    template_path = tmp_path / "template.xls"
    template_path.write_bytes(b"real-template-bytes")
    resolved = SimpleNamespace(
        template=SimpleNamespace(
            id="bsn_sales",
            workbook=SimpleNamespace(path=template_path),
        ),
        metadata={"raw_sha256": "b" * 64, "profile_state_hash": "c" * 64},
        profile_version=2,
        rows=[{"Số chứng từ (*)": "BH001", "Mã hàng (*)": "HH01", "Thành tiền": "100"}],
        row_origins=[{"raw_sheet": "Raw", "raw_rows": [2]}],
    )
    monkeypatch.setattr(
        misa_workflow,
        "_resolve_confirmed_export",
        lambda **_kwargs: resolved,
        raising=False,
    )
    monkeypatch.setattr(
        misa_workflow,
        "_export_resolved_confirmed_profile",
        lambda **_kwargs: (b"xls", "result.xls"),
    )

    manifest = misa_workflow.manifest_for_confirmed_profile(
        upload_id="upload-1",
        profile_id="profile-1",
        context_token="trusted-token",
        conversion_id="run-1",
        export_batch_id="batch-1",
    )

    assert len(manifest.rows) == len(resolved.rows)
    assert manifest.raw_file_hash == "b" * 64
    assert manifest.mapping_profile_state_hash == "c" * 64
    assert manifest.template_hash != "a" * 64
    assert manifest.document_groups[0]["amount_total"] == "100"


def test_manifest_workflow_exports_edited_rows_from_one_resolved_snapshot(tmp_path, monkeypatch):
    template = next(item for item in list_misa_templates() if item.id == "bsn_sales")
    edited_rows = [
        {
            "Số chứng từ (*)": "EDITED-001",
            "Mã hàng (*)": "HH01",
            "Thành tiền": Decimal("125.50"),
        },
        {
            "Số chứng từ (*)": "EDITED-001",
            "Mã hàng (*)": "HH02",
            "Thành tiền": Decimal("74.50"),
        },
    ]
    resolved = SimpleNamespace(
        metadata={"raw_sha256": "b" * 64},
        owner_scope="user:pytest-user",
        profile_token=None,
        profile_kind="v1",
        profile_version=2,
        profile_v2=None,
        template=template,
        rows=edited_rows,
        row_origins=[
            {"raw_sheet": "Raw", "raw_rows": [2]},
            {"raw_sheet": "Raw", "raw_rows": [3]},
        ],
    )
    calls = []
    artifact_writes = []

    def fake_resolve(**kwargs):
        calls.append(kwargs)
        assert kwargs["edited_rows"] is edited_rows
        return resolved

    monkeypatch.setattr(misa_workflow, "UPLOAD_ROOT", tmp_path / "uploads")
    monkeypatch.setattr(misa_workflow, "_resolve_confirmed_export", fake_resolve)
    monkeypatch.setattr(misa_workflow.ProfileStore, "mark_used", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        misa_workflow,
        "OperationStore",
        lambda **_kwargs: SimpleNamespace(
            put_artifact=lambda _session_id, **kwargs: artifact_writes.append(kwargs)
        ),
    )
    (misa_workflow.UPLOAD_ROOT / "upload-edited").mkdir(parents=True)

    manifest = misa_workflow.manifest_for_confirmed_profile(
        upload_id="upload-edited",
        profile_id="profile-1",
        context_token="trusted-token",
        conversion_id="run-1",
        export_batch_id="batch-1",
        edited_rows=edited_rows,
        session_id="session-1",
        revision=4,
    )

    exported = xlrd.open_workbook(
        str(misa_workflow.UPLOAD_ROOT / "upload-edited" / "misa_export.xls")
    ).sheet_by_index(0)
    headers = exported.row_values(template.workbook.header_row_index)
    data_start = template.data_start_row - 1
    assert len(calls) == 1
    assert [(item["kind"], item["revision"]) for item in artifact_writes] == [
        ("output", 1),
        ("manifest", 1),
    ]
    assert exported.cell_value(data_start, headers.index("Số chứng từ (*)")) == "EDITED-001"
    assert exported.cell_value(data_start + 1, headers.index("Mã hàng (*)")) == "HH02"
    assert len(manifest.rows) == exported.nrows - data_start == 2
    assert manifest.document_groups[0]["amount_total"] == "200.00"
    assert manifest.document_groups[0]["raw_row_ids"] == [
        manifest.rows[0].raw_row_ids[0],
        manifest.rows[1].raw_row_ids[0],
    ]


def test_manifest_endpoint_reuses_trusted_export_binding(monkeypatch):
    captured = {}
    claims = {"conversion_run_id": "run-1"}
    monkeypatch.setattr(
        main,
        "_conversion_context_for_request",
        lambda *_args, **_kwargs: ("trusted-token", claims),
    )
    monkeypatch.setattr(
        main,
        "_read_export_binding",
        lambda *_args, **_kwargs: {
            "target_template_id": "bsn_sales",
            "operation_session_id": "session-1",
            "profile_id": "profile-1",
        },
    )
    monkeypatch.setattr(main, "_assert_export_binding", lambda **kwargs: captured.update(binding=kwargs))
    monkeypatch.setattr(
        main,
        "manifest_for_confirmed_profile",
        lambda **kwargs: captured.update(workflow=kwargs) or _manifest(),
        raising=False,
    )

    result = asyncio.run(
        main.create_export_manifest(
            {
                "upload_id": "upload-1",
                "profile_id": "profile-1",
                "conversion_run_id": "run-1",
                "export_batch_id": "batch-1",
                "target_template_id": "bsn_sales",
                "rows": [
                    {
                        "Số chứng từ (*)": "CLIENT-ROW",
                        "row_id": "r1",
                        "source_origin": {"raw_sheet": "Raw", "raw_rows": [2]},
                    }
                ],
            },
            "browser-token",
        )
    )

    assert result.conversion_id == "run-1"
    assert captured["workflow"]["context_token"] == "trusted-token"
    assert captured["workflow"]["edited_rows"] is None
    assert captured["binding"]["requested_conversion_run_id"] == "run-1"
