import json
import os
import shutil
import subprocess
import sys

import pytest
import xlwt

from app.conversion_types import CONVERSION_TYPES
from app import misa_templates
from app.misa_templates import DISPLAY_FILENAMES, get_misa_template


def _manifest_payload():
    return json.loads(misa_templates.DEFAULT_MANIFEST_PATH.read_text(encoding="utf-8"))


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
        ],
        cwd=converter_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "refuses to overwrite active manifest" in result.stderr.lower()
