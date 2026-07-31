import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import xlrd
import xlwt

from app.conversion_types import CONVERSION_TYPES
from app import misa_templates
from app.excel_io import write_xls_from_template
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
                "Sanitized structural derivative of a partner-provided sample committed as "
                f"converter/fixtures/templates/{entry['bundled_filename']}; "
                "no post-header customer values retained in this derivative"
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
    assert "synthetic-customer@example.invalid".encode("utf-16le") not in output_bytes
    scan = misa_templates.scan_misa_template_content(
        output_bytes,
        header_row_index=1,
    )
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


def test_production_release_fails_when_writer_cannot_preserve_advanced_biff(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS", "partner_sample_derived")

    with pytest.raises(RuntimeError, match="BIFF preservation"):
        misa_templates.verify_all_misa_templates(require_export_safe=True)


def test_release_capability_cli_fails_closed_for_current_writer():
    converter_root = CONVERSION_TYPES["sales_goods"].template_path.parents[2]
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.misa_templates",
            "verify",
            "--require-export-safe",
        ],
        cwd=converter_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "BIFF preservation" in result.stderr


def test_production_startup_fails_closed_on_unsupported_biff_writer():
    converter_root = CONVERSION_TYPES["sales_goods"].template_path.parents[2]
    env = dict(os.environ)
    env.update(
        {
            "NODE_ENV": "production",
            "MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS": "partner_sample_derived",
            "PYTHONIOENCODING": "utf-8",
        }
    )

    result = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=converter_root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "BIFF preservation" in result.stderr


def test_verifier_checks_every_supported_template():
    verifier = getattr(misa_templates, "verify_all_misa_templates", None)

    assert verifier is not None
    assert set(verifier()) == set(CONVERSION_TYPES)


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
