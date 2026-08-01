import json
import hashlib
from io import BytesIO
import os
import shutil
import struct
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import olefile
import pytest
import xlrd
import xlwt

from app.conversion_types import CONVERSION_TYPES
from app import misa_biff, misa_templates
from app.excel_io import write_xls_from_template
from app.misa_certification import (
    create_manual_certification_record,
    current_writer_build_sha256,
)
from app.misa_templates import DISPLAY_FILENAMES, get_misa_template, list_misa_templates


def _manifest_payload():
    return json.loads(misa_templates.DEFAULT_MANIFEST_PATH.read_text(encoding="utf-8"))


def _rotation_metadata_args():
    return [
        "--source-kind",
        "partner_sample_derived",
        "--source-reference",
        "partner-template-test-reference",
        "--acquisition-date",
        "2026-07-31",
        "--misa-product",
        "unknown",
        "--misa-release",
        "unknown",
        "--reviewer",
        "test-reviewer",
        "--review-status",
        "accepted_for_project_use",
        "--trust-level",
        "partner_sample_derived",
        "--official-status",
        "not_claimed_official",
    ]


def _configure_trusted_copy(tmp_path, monkeypatch, template_id, payload):
    source = CONVERSION_TYPES[template_id].template_path
    destination = tmp_path / DISPLAY_FILENAMES[template_id]
    shutil.copyfile(source, destination)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.setenv("MISA_TEMPLATE_DIR", str(tmp_path))
    monkeypatch.setenv("MISA_TEMPLATE_MANIFEST_PATH", str(manifest_path))


def _property_stream_with_author(source_stream: bytes) -> bytes:
    author = b"private-fixture-user\0"
    author_value = struct.pack("<II", 30, len(author)) + author
    author_value += b"\0" * ((-len(author_value)) % 4)
    section_size = 32 + len(author_value)
    header = struct.pack("<HHI", 0xFFFE, 0, 0x00020006)
    header += b"\0" * 16
    header += struct.pack("<I", 1)
    header += source_stream[28:44]
    header += struct.pack("<I", 48)
    section = struct.pack("<II", section_size, 2)
    section += struct.pack("<IIII", 1, 24, 4, 32)
    section += struct.pack("<IhH", 2, 1252, 0)
    section += author_value
    payload = header + section
    assert len(payload) <= len(source_stream)
    return payload + (b"\0" * (len(source_stream) - len(payload)))


def _add_private_ole_metadata(path: Path) -> None:
    contents = path.read_bytes()
    workbook_stream = bytearray(misa_templates.workbook_stream(contents))
    for record in misa_templates.iter_misa_biff_records(contents):
        if record.record_id != 0x005C:
            continue
        value = b"private-fixture-user"
        start = record.offset + 4
        encoded = struct.pack("<H", len(value)) + b"\0" + value
        workbook_stream[start : start + len(record.payload)] = encoded.ljust(
            len(record.payload), b" "
        )
    with olefile.OleFileIO(str(path), write_mode=True) as compound:
        stream_name = "Workbook" if compound.exists("Workbook") else "Book"
        compound.write_stream(stream_name, bytes(workbook_stream))
        summary = "\x05SummaryInformation"
        source_summary = compound.openstream(summary).read()
        compound.write_stream(summary, _property_stream_with_author(source_summary))


def _formula_workbook_bytes(formula: str, *, row_index: int = 0) -> bytes:
    book = xlwt.Workbook()
    sheet = book.add_sheet("Sheet1")
    sheet.write(row_index, 0, xlwt.Formula(formula))
    output = BytesIO()
    book.save(output)
    return output.getvalue()


def _mutate_first_biff_record(contents: bytes, record_id: int, mutate) -> bytes:
    workbook = bytearray(misa_biff.workbook_stream(contents))
    record = next(
        item for item in misa_biff.iter_biff_records(contents) if item.record_id == record_id
    )
    replacement = mutate(bytearray(record.payload))
    assert len(replacement) == len(record.payload)
    start = record.offset + 4
    workbook[start : start + len(replacement)] = replacement
    output = BytesIO(contents)
    with olefile.OleFileIO(output, write_mode=True) as compound:
        stream_name = "Workbook" if compound.exists("Workbook") else "Book"
        compound.write_stream(stream_name, bytes(workbook))
    return output.getvalue()


def _create_test_certification(template, certification_dir: Path, tmp_path: Path) -> None:
    fixture_id = f"synthetic-{template.id}-provenance-test-001"
    input_path = tmp_path / f"{template.id}-input.csv"
    input_path.write_text("document\nSYN-CERT-001\n", encoding="utf-8")
    output_path = tmp_path / f"{template.id}-output.xls"
    write_xls_from_template(template.workbook, [{}], output_path)
    result_artifact_path = tmp_path / f"{template.id}-misa-receipt.json"
    result_artifact_path.write_text(
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
    fixture_attestation_path = tmp_path / f"{template.id}-fixture-attestation.json"
    fixture_attestation_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "synthetic_fixture_id": fixture_id,
                "fixture_kind": "synthetic",
                "privacy_classification": "synthetic_no_customer_data",
                "contains_customer_data": False,
                "generator": "converter/tests/test_misa_template_provenance.py",
                "reviewer": "provenance-fixture-reviewer",
                "approval_status": "approved",
                "approved_at_utc": (
                    datetime.now(timezone.utc) - timedelta(days=1)
                ).isoformat(),
                "input_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
                "output_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    fixture_manifest_path = tmp_path / f"{template.id}-fixture-manifest.json"
    common_manifest_fields = {
        "source_kind": "deterministic_synthetic",
        "fixture_kind": "synthetic",
        "privacy_classification": "synthetic_no_customer_data",
        "contains_customer_data": False,
        "generator": "converter/tests/test_misa_template_provenance.py",
        "reviewer": "provenance-fixture-reviewer",
        "approval_status": "approved",
        "approved_at_utc": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
    }
    fixture_manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "fixture_version": "pytest-provenance-1",
                "fixtures": {
                    f"{template.id}_input": {
                        **common_manifest_fields,
                        "sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
                        "path": f"converter/fixtures/certification-tests/{template.id}-input.csv",
                        "synthetic_fixture_id": f"synthetic-{template.id}-provenance-input-001",
                    },
                    f"{template.id}_output": {
                        **common_manifest_fields,
                        "sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                        "path": f"converter/fixtures/certification-tests/{template.id}-output.xls",
                        "synthetic_fixture_id": fixture_id,
                    },
                },
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    import_result_path = tmp_path / f"{template.id}-misa-result.json"
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
                    result_artifact_path.read_bytes()
                ).hexdigest(),
                "fixture_attestation_sha256": hashlib.sha256(
                    fixture_attestation_path.read_bytes()
                ).hexdigest(),
                "synthetic_fixture_id": fixture_id,
                "privacy_classification": "synthetic_no_customer_data",
                "misa_product": "AMIS Ke toan",
                "misa_release": "sandbox-2026-07",
                "completed_at_utc": (
                    datetime.now(timezone.utc) - timedelta(minutes=5)
                ).isoformat(),
                "reviewer": "qa-reviewer",
                "approver": "release-approver",
                "writer_build_sha256": current_writer_build_sha256(),
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
        conversion_type=template.id,
        template_path=template.path,
        input_path=input_path,
        output_path=output_path,
        import_result_path=import_result_path,
        result_artifact_path=result_artifact_path,
        fixture_attestation_path=fixture_attestation_path,
        fixture_manifest_path=fixture_manifest_path,
        artifact_dir=certification_dir,
        expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
    )


def test_same_header_workbook_without_trusted_hash_is_rejected(tmp_path, monkeypatch):
    canonical = get_misa_template("sales_goods")
    synthetic_path = tmp_path / DISPLAY_FILENAMES[canonical.id]
    book = xlwt.Workbook()
    sheet = book.add_sheet(canonical.sheet_name)
    for column, header in enumerate(canonical.headers):
        sheet.write(canonical.workbook.header_row_index, column, header)
    book.save(str(synthetic_path))
    monkeypatch.setenv("MISA_TEMPLATE_DIR", str(tmp_path))

    with pytest.raises(RuntimeError, match="SHA-256"):
        get_misa_template(canonical.id)


def test_template_is_parsed_from_the_exact_hashed_buffer(tmp_path, monkeypatch):
    template_id = "sales_goods"
    canonical = get_misa_template(template_id)
    original_bytes = CONVERSION_TYPES[template_id].template_path.read_bytes()
    payload = _manifest_payload()
    _configure_trusted_copy(tmp_path, monkeypatch, template_id, payload)
    canonical_path = tmp_path / DISPLAY_FILENAMES[template_id]

    synthetic_path = tmp_path / "synthetic.xls"
    book = xlwt.Workbook()
    sheet = book.add_sheet(canonical.sheet_name)
    for column, header in enumerate(canonical.headers):
        sheet.write(canonical.workbook.header_row_index, column, header)
    book.save(str(synthetic_path))
    synthetic_bytes = synthetic_path.read_bytes()
    original_read_bytes = Path.read_bytes
    swapped = False

    def read_and_swap(path):
        nonlocal swapped
        data = original_read_bytes(path)
        if path == canonical_path and not swapped:
            swapped = True
            path.write_bytes(synthetic_bytes)
        return data

    monkeypatch.setattr(Path, "read_bytes", read_and_swap)

    verified = get_misa_template(template_id)

    assert swapped is True
    assert verified.workbook.file_contents == original_bytes


def test_export_never_reopens_mutated_verified_template_path(tmp_path, monkeypatch):
    template_id = "sales_goods"
    payload = _manifest_payload()
    _configure_trusted_copy(tmp_path, monkeypatch, template_id, payload)
    template = get_misa_template(template_id)
    template.path.write_bytes(b"mutated after verification")
    output_path = tmp_path / "immutable-export.xls"

    write_xls_from_template(template.workbook, [], output_path)

    output_book = pytest.importorskip("xlrd").open_workbook(
        file_contents=output_path.read_bytes(),
        formatting_info=True,
    )
    assert output_book.sheet_by_index(0).default_row_height == 300


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("canonical_filename", "renamed.xls", "canonical filename"),
        ("sheet_name", "Wrong sheet", "sheet"),
        ("header_row", 9, "header row"),
        ("column_count", 51, "column count"),
        ("headers", ["Wrong header"] * 52, "headers"),
    ],
)
def test_manifest_and_workbook_invariants_are_enforced(
    tmp_path, monkeypatch, field, value, message
):
    payload = _manifest_payload()
    payload["templates"]["sales_goods"][field] = value
    _configure_trusted_copy(tmp_path, monkeypatch, "sales_goods", payload)

    with pytest.raises(RuntimeError, match=message):
        get_misa_template("sales_goods")


def test_configured_directory_requires_canonical_filename(tmp_path, monkeypatch):
    shutil.copyfile(
        CONVERSION_TYPES["sales_goods"].template_path,
        tmp_path / CONVERSION_TYPES["sales_goods"].template_path.name,
    )
    monkeypatch.setenv("MISA_TEMPLATE_DIR", str(tmp_path))

    with pytest.raises(RuntimeError, match="canonical filename"):
        get_misa_template("sales_goods")


def test_manifest_must_cover_exact_supported_template_ids(tmp_path, monkeypatch):
    payload = _manifest_payload()
    payload["templates"]["unregistered_template"] = dict(
        payload["templates"]["sales_goods"]
    )
    _configure_trusted_copy(tmp_path, monkeypatch, "sales_goods", payload)

    with pytest.raises(RuntimeError, match="template IDs"):
        get_misa_template("sales_goods")


def test_committed_bsn_sales_provenance_preserves_59_column_schema():
    payload = _manifest_payload()
    entry = payload["templates"]["bsn_sales"]
    template = get_misa_template("bsn_sales")

    assert entry["column_count"] == 59
    assert len(entry["headers"]) == 59
    assert len(template.headers) == 59
    lot_column = template.headers.index("Số lô")
    assert template.headers[lot_column : lot_column + 2] == ["Số lô", "Hạn sử dụng"]


def test_manifest_truthfully_labels_scrubbed_partner_sample_derivatives():
    payload = _manifest_payload()

    assert payload["schema_version"] == 3
    for template_id, entry in payload["templates"].items():
        provenance = entry["provenance"]
        assert provenance == {
            "source_kind": "partner_sample_derived",
            "source_reference": (
                "Metadata-scrubbed structural derivatives of partner-provided samples; "
                "no raw customer rows, OLE author properties, or BIFF user metadata "
                "retained in committed files"
            ),
            "acquisition_date": "unknown",
            "misa_product": "unknown",
            "misa_release": "unknown",
            "reviewer": "project-owner",
            "review_status": "accepted_for_project_use",
            "trust_level": "partner_sample_derived",
            "official_status": "not_claimed_official",
        }, template_id


def test_bundled_templates_have_no_post_header_values_or_binary_pii():
    scanner = getattr(misa_templates, "scan_misa_template_content", None)

    assert scanner is not None
    for template in list_misa_templates():
        scan = scanner(
            template.workbook.file_contents,
            header_row_index=template.workbook.header_row_index,
        )
        assert scan.post_header_workbook_value_count == 0, template.id
        assert scan.post_header_literal_record_count == 0, template.id
        assert scan.unreferenced_nonblank_sst_count == 0, template.id
        assert scan.ole_property_value_count == 0, template.id
        assert scan.ole_property_parse_error_count == 0, template.id
        assert scan.file_sharing_username_count == 0, template.id
        assert scan.write_access_username_count == 0, template.id


def test_biff_scanner_rejects_formula_on_or_before_header():
    contents = _formula_workbook_bytes("1+1", row_index=7)

    scan = misa_biff.scan_template_content(contents, header_row_index=7)

    assert scan.pre_header_formula_count == 1
    assert not scan.clean


def test_biff_scanner_rejects_formula_in_non_data_sheet():
    book = xlwt.Workbook()
    book.add_sheet("Primary")
    secondary = book.add_sheet("HiddenPayload")
    secondary.write(9, 0, xlwt.Formula("1+1"))
    output = BytesIO()
    book.save(output)

    scan = misa_biff.scan_template_content(output.getvalue(), header_row_index=7)

    assert scan.unsafe_formula_count == 1
    assert not scan.clean


@pytest.mark.parametrize(
    "formula",
    [
        'HYPERLINK("https://example.invalid/customer", "open")',
        'RTD("untrusted.server",, "customer")',
    ],
)
def test_biff_scanner_rejects_active_formula_functions_in_any_row(formula):
    contents = _formula_workbook_bytes(formula, row_index=9)

    scan = misa_biff.scan_template_content(contents, header_row_index=7)

    assert scan.unsafe_formula_count == 1
    assert not scan.clean


@pytest.mark.parametrize(
    ("supbook_payload", "expected_field"),
    [
        (b"\x01\x00\x00\x00", "external_link_count"),
        (b"\x00\x00\x00\x00", "dde_link_count"),
    ],
)
def test_biff_scanner_rejects_external_and_dde_supbooks(
    supbook_payload,
    expected_field,
):
    template = get_misa_template("sales_goods")
    contents = _mutate_first_biff_record(
        template.workbook.file_contents,
        0x01AE,
        lambda payload: bytearray(supbook_payload),
    )

    scan = misa_biff.scan_template_content(
        contents,
        header_row_index=template.workbook.header_row_index,
    )

    assert getattr(scan, expected_field) == 1
    assert not scan.clean


def test_biff_scanner_rejects_macro_sheet_boundsheet_record():
    template = get_misa_template("sales_goods")

    def make_macro_sheet(payload):
        payload[5] = 0x01
        return payload

    contents = _mutate_first_biff_record(
        template.workbook.file_contents,
        0x0085,
        make_macro_sheet,
    )

    scan = misa_biff.scan_template_content(
        contents,
        header_row_index=template.workbook.header_row_index,
    )

    assert scan.macro_sheet_count == 1
    assert not scan.clean


def test_scrubber_removes_values_without_changing_protected_biff_records(tmp_path):
    scrubber = getattr(misa_templates, "scrub_misa_template_copy", None)
    source_path = tmp_path / "source.xls"
    output_path = tmp_path / "scrubbed.xls"
    workbook = xlwt.Workbook()
    sheet = workbook.add_sheet("Template")
    style = xlwt.easyxf("font: bold on; align: vert centre")
    sheet.write_merge(0, 0, 0, 1, "Synthetic template", style)
    sheet.write(1, 0, "Customer", style)
    sheet.write(1, 1, "Calculated", style)
    sheet.write(2, 0, "synthetic-customer@example.invalid", style)
    sheet.write(2, 1, xlwt.Formula("1+1"), style)
    sheet.col(0).width = 6400
    sheet.row(2).height = 420
    workbook.save(str(source_path))
    source_bytes = source_path.read_bytes()

    assert scrubber is not None
    scrubber(
        source_path,
        output_path,
        header_row_index=1,
    )

    output_bytes = output_path.read_bytes()
    assert b"synthetic-customer@example.invalid" not in output_bytes
    scan = misa_templates.scan_misa_template_content(
        output_bytes,
        header_row_index=1,
    )
    assert scan.write_access_username_count == 0
    assert "synthetic-customer@example.invalid".encode("utf-16le") not in output_bytes
    assert scan.clean
    assert misa_templates.probe_misa_template_biff(output_bytes) == (
        misa_templates.probe_misa_template_biff(source_bytes)
    )
    source_sheet = xlrd.open_workbook(
        file_contents=source_bytes,
        formatting_info=True,
    ).sheet_by_index(0)
    output_sheet = xlrd.open_workbook(
        file_contents=output_bytes,
        formatting_info=True,
    ).sheet_by_index(0)
    assert output_sheet.merged_cells == source_sheet.merged_cells
    assert output_sheet.default_row_height == source_sheet.default_row_height
    assert output_sheet.colinfo_map.keys() == source_sheet.colinfo_map.keys()
    assert output_sheet.rowinfo_map.keys() == source_sheet.rowinfo_map.keys()
    assert output_sheet.colinfo_map[0].width == source_sheet.colinfo_map[0].width
    assert output_sheet.rowinfo_map[2].height == source_sheet.rowinfo_map[2].height


def test_ole_metadata_scrubber_removes_property_and_workbook_user_metadata(tmp_path):
    scrubber = getattr(misa_templates, "scrub_misa_ole_metadata_copy", None)
    template = get_misa_template("sales_goods")
    source = tmp_path / "writer-output-with-metadata.xls"
    output = tmp_path / "metadata-scrubbed.xls"
    shutil.copyfile(template.path, source)
    _add_private_ole_metadata(source)
    source_bytes = source.read_bytes()
    source_probe = misa_templates.probe_misa_template_biff(source_bytes)

    assert scrubber is not None
    source_scan = misa_templates.scan_misa_template_content(
        source_bytes,
        header_row_index=template.workbook.header_row_index,
    )
    assert source_scan.ole_property_value_count > 0
    assert source_scan.write_access_username_count > 0

    scrubber(source, output)

    output_bytes = output.read_bytes()
    output_scan = misa_templates.scan_misa_template_content(
        output_bytes,
        header_row_index=template.workbook.header_row_index,
    )
    assert output_scan.clean
    assert misa_templates.probe_misa_template_biff(output_bytes) == source_probe


def test_biff_file_sharing_username_is_blank_after_metadata_scrub():
    username = b"private-fixture-user"
    payload = struct.pack("<HHBB", 0, 0, len(username), 0) + username
    record = struct.pack("<HH", 0x005B, len(payload)) + payload

    assert misa_biff._file_sharing_username_is_nonblank(payload)
    scrubbed = misa_biff._scrub_workbook_user_metadata(record)
    scrubbed_payload = scrubbed[4:]
    assert not misa_biff._file_sharing_username_is_nonblank(scrubbed_payload)


def test_manifest_biff_probes_match_preserved_binary_records():
    probe = getattr(misa_templates, "probe_misa_template_biff", None)
    payload = _manifest_payload()

    assert probe is not None
    advanced_template_count = 0
    for template in list_misa_templates():
        actual = probe(template.workbook.file_contents)
        assert payload["templates"][template.id]["biff_features"] == actual
        if any(feature["record_count"] for feature in actual.values()):
            advanced_template_count += 1
    assert advanced_template_count > 0


def test_production_requires_configured_accepted_template_trust_level(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS", raising=False)

    with pytest.raises(RuntimeError, match="accepted trust level"):
        get_misa_template("sales_goods")


def test_production_accepts_explicit_derived_trust_for_feature_free_template(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS", "partner_sample_derived")

    assert get_misa_template("bsn_sales").id == "bsn_sales"


def test_production_trust_env_must_exactly_match_manifest_vocabulary(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv(
        "MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS",
        "partner_sample_derived,partner_supplied",
    )

    with pytest.raises(RuntimeError, match="exactly match manifest trust levels"):
        get_misa_template("bsn_sales")


def test_production_release_fails_until_every_template_has_certification(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS", "partner_sample_derived")
    monkeypatch.setenv("MISA_TEMPLATE_CERTIFICATION_DIR", str(tmp_path / "missing"))

    with pytest.raises(RuntimeError, match="certification evidence"):
        misa_templates.verify_all_misa_templates(require_export_safe=True)


def test_release_capability_cli_fails_closed_for_current_writer(tmp_path):
    converter_root = CONVERSION_TYPES["sales_goods"].template_path.parents[2]
    env = dict(os.environ)
    env["MISA_TEMPLATE_CERTIFICATION_DIR"] = str(tmp_path / "missing")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.misa_templates",
            "verify",
            "--require-export-safe",
        ],
        cwd=converter_root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "certification evidence" in result.stderr


def test_production_startup_stays_healthy_but_reports_degraded_templates(tmp_path):
    converter_root = CONVERSION_TYPES["sales_goods"].template_path.parents[2]
    env = dict(os.environ)
    env.update(
        {
            "NODE_ENV": "production",
            "MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS": "partner_sample_derived",
            "MISA_TEMPLATE_CERTIFICATION_DIR": str(tmp_path / "certifications"),
            "PYTHONIOENCODING": "utf-8",
        }
    )

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import json; from app.main import healthz; print(json.dumps(healthz()))",
        ],
        cwd=converter_root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "degraded"
    assert payload["misa_templates"]["status"] == "degraded"
    assert set(payload["misa_templates"]["unavailable"]) == set(CONVERSION_TYPES)


def test_template_capability_registry_reports_each_uncertified_template(tmp_path, monkeypatch):
    monkeypatch.setenv("MISA_TEMPLATE_CERTIFICATION_DIR", str(tmp_path / "certifications"))

    registry = misa_templates.template_capability_registry()

    assert set(registry) == set(CONVERSION_TYPES)
    assert all(not capability.available for capability in registry.values())
    assert all(
        "certification evidence" in str(capability.unavailable_reason)
        for capability in registry.values()
    )


def test_production_export_checks_only_the_selected_template(tmp_path, monkeypatch):
    certification_dir = tmp_path / "certifications"
    template = get_misa_template("bsn_sales")
    _create_test_certification(template, certification_dir, tmp_path)
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS", "partner_sample_derived")
    monkeypatch.setenv("MISA_TEMPLATE_CERTIFICATION_DIR", str(certification_dir))

    registry = misa_templates.template_capability_registry()
    assert registry["bsn_sales"].available is True
    assert registry["sales_goods"].available is False
    assert misa_templates.template_health_payload()["status"] == "degraded"
    assert misa_templates.get_misa_template_for_export("bsn_sales").id == "bsn_sales"
    with pytest.raises(RuntimeError, match="certification evidence"):
        misa_templates.get_misa_template_for_export("sales_goods")


def test_verifier_checks_every_supported_template():
    verifier = getattr(misa_templates, "verify_all_misa_templates", None)

    assert verifier is not None
    assert set(verifier()) == set(CONVERSION_TYPES)
    assert set(verifier(require_export_safe=True)) == set(CONVERSION_TYPES)


@pytest.mark.parametrize("failure", ["missing_manifest", "hash_mismatch"])
def test_production_import_fails_closed_on_untrusted_templates(tmp_path, failure):
    manifest_path = tmp_path / "manifest.json"
    if failure == "hash_mismatch":
        payload = _manifest_payload()
        payload["templates"]["sales_goods"]["sha256"] = "0" * 64
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")
    env = dict(os.environ)
    env.update(
        {
            "NODE_ENV": "production",
            "MISA_TEMPLATE_MANIFEST_PATH": str(manifest_path),
            "MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS": "partner_sample_derived",
            "PYTHONIOENCODING": "utf-8",
        }
    )

    result = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=CONVERSION_TYPES["sales_goods"].template_path.parents[2],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "MISA template" in result.stderr


def test_manifest_rotation_requires_explicit_regenerate_and_review_commands(tmp_path):
    candidate_path = tmp_path / "candidate.json"
    converter_root = CONVERSION_TYPES["sales_goods"].template_path.parents[2]
    regenerate = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.misa_templates",
            "regenerate-manifest",
            "--template-dir",
            "fixtures/templates",
            "--output",
            str(candidate_path),
            "--manifest-version",
            "test-reviewed-rotation",
            *_rotation_metadata_args(),
        ],
        cwd=converter_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert regenerate.returncode == 0, regenerate.stderr
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    assert candidate["manifest_version"] == "test-reviewed-rotation"
    assert candidate["templates"]["bsn_sales"]["column_count"] == 59
    assert candidate["templates"]["bsn_sales"]["provenance"]["reviewer"] == (
        "test-reviewer"
    )

    review = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.misa_templates",
            "review-manifest",
            "--template-dir",
            "fixtures/templates",
            "--candidate",
            str(candidate_path),
        ],
        cwd=converter_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert review.returncode == 0, review.stderr
    assert "review passed" in review.stdout.lower()


def test_regenerate_command_requires_explicit_provenance_metadata(tmp_path):
    converter_root = CONVERSION_TYPES["sales_goods"].template_path.parents[2]
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.misa_templates",
            "regenerate-manifest",
            "--template-dir",
            "fixtures/templates",
            "--output",
            str(tmp_path / "candidate.json"),
            "--manifest-version",
            "missing-metadata",
        ],
        cwd=converter_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "required" in result.stderr.lower()


def test_regenerate_command_never_overwrites_active_manifest():
    converter_root = CONVERSION_TYPES["sales_goods"].template_path.parents[2]
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.misa_templates",
            "regenerate-manifest",
            "--template-dir",
            "fixtures/templates",
            "--output",
            str(misa_templates.DEFAULT_MANIFEST_PATH),
            "--manifest-version",
            "must-not-write",
            *_rotation_metadata_args(),
        ],
        cwd=converter_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "refuses to overwrite active manifest" in result.stderr.lower()
