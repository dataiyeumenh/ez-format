import hashlib
import importlib.metadata as package_metadata
import json
import shutil
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

import pytest

from app import misa_certification
from app.excel_io import write_xls_from_template
from app.misa_certification import (
    create_manual_certification_record,
    current_writer_build_sha256,
    validate_manual_certification_record,
)
from app.misa_templates import get_misa_template


TRUST = {
    "source_kind": "partner_sample_derived",
    "trust_level": "partner_sample_derived",
    "official_status": "not_claimed_official",
}
WRITER_DEPENDENCIES = ("xlrd", "xlwt", "xlutils", "olefile")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _evidence_files(
    tmp_path: Path,
    *,
    status: str = "misa_import_passed",
    import_overrides: dict | None = None,
    output_equals_template: bool = False,
):
    tmp_path.mkdir(parents=True, exist_ok=True)
    template = get_misa_template("sales_goods")
    input_path = tmp_path / "synthetic-certification-input.csv"
    input_path.write_text(
        "invoice,item,amount\nSYN-CERT-001,SYN-ITEM-001,100000\n",
        encoding="utf-8",
    )
    output_path = tmp_path / "sales_goods-output.xls"
    if output_equals_template:
        output_path.write_bytes(template.workbook.file_contents)
    else:
        write_xls_from_template(
            template.workbook,
            [{"Số chứng từ (*)": "SYN-CERT-001", "Mã hàng (*)": "SYN-ITEM-001"}],
            output_path,
        )
    result_artifact_path = tmp_path / "misa-import-result.txt"
    result_artifact_path.write_text(
        "MISA controlled import result\nstatus=success\nimported_rows=1\nreference=SYN-CERT-001\n",
        encoding="utf-8",
    )
    completed_at = datetime.now(timezone.utc) - timedelta(minutes=5)
    import_result_path = tmp_path / "misa-import-result.json"
    import_payload = {
        "schema_version": 2,
        "evidence_origin": "misa_sandbox_import",
        "result_artifact_kind": "misa_import_log",
        "status": status,
        "template_sha256": template.sha256,
        "output_sha256": _sha256(output_path),
        "input_sha256": _sha256(input_path),
        "result_artifact_sha256": _sha256(result_artifact_path),
        "misa_product": "AMIS Ke toan",
        "misa_release": "sandbox-2026-07",
        "completed_at_utc": completed_at.isoformat(),
        "reviewer": "qa-reviewer",
        "approver": "release-approver",
        "writer_build_sha256": current_writer_build_sha256(),
        "template_provenance": TRUST,
    }
    import_payload.update(import_overrides or {})
    import_result_path.write_text(
        json.dumps(import_payload, sort_keys=True),
        encoding="utf-8",
    )
    return template, input_path, output_path, import_result_path, result_artifact_path


def _create(tmp_path: Path, **evidence_options):
    evidence = _evidence_files(tmp_path, **evidence_options)
    template, input_path, output_path, import_result_path, result_artifact_path = evidence
    record_path = create_manual_certification_record(
        conversion_type="sales_goods",
        template_path=template.path,
        input_path=input_path,
        output_path=output_path,
        import_result_path=import_result_path,
        result_artifact_path=result_artifact_path,
        artifact_dir=tmp_path / "certifications",
        expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
    )
    return evidence, record_path


def _validate(record_path: Path, template_sha256: str):
    return validate_manual_certification_record(
        record_path,
        conversion_type="sales_goods",
        template_sha256=template_sha256,
        template_provenance=TRUST,
    )


def test_writer_dependencies_are_exactly_pinned_to_resolved_runtime_versions():
    requirements = (Path(__file__).resolve().parents[1] / "requirements.txt").read_text(
        encoding="utf-8"
    )

    for dependency in WRITER_DEPENDENCIES:
        assert f"{dependency}=={package_metadata.version(dependency)}" in requirements.splitlines()


@pytest.mark.parametrize("drift", ["dependency", "requirements", "python"])
def test_certification_validation_rejects_writer_fingerprint_drift(
    tmp_path,
    monkeypatch,
    drift,
):
    evidence, record_path = _create(tmp_path)

    if drift == "dependency":
        resolved_version = package_metadata.version

        def drifted_version(distribution_name):
            version = resolved_version(distribution_name)
            return f"{version}+drift" if distribution_name == "xlwt" else version

        monkeypatch.setattr(package_metadata, "version", drifted_version)
    elif drift == "requirements":
        requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
        drifted_requirements = tmp_path / "requirements.txt"
        drifted_requirements.write_bytes(requirements.read_bytes() + b"# drift\n")
        monkeypatch.setattr(
            misa_certification,
            "_WRITER_REQUIREMENTS_PATH",
            drifted_requirements,
            raising=False,
        )
    else:
        monkeypatch.setattr(
            misa_certification.sys,
            "version_info",
            SimpleNamespace(
                major=misa_certification.sys.version_info.major,
                minor=misa_certification.sys.version_info.minor + 1,
            ),
        )

    with pytest.raises(ValueError, match="writer build SHA-256 mismatch"):
        _validate(record_path, evidence[0].sha256)


def test_certification_bundles_portable_content_addressed_immutable_evidence(tmp_path):
    evidence, record_path = _create(tmp_path)
    template, input_path, output_path, import_result_path, result_artifact_path = evidence

    payload = _validate(record_path, template.sha256)

    assert payload["status"] == "misa_import_passed"
    assert payload["production_ready"] is True
    assert payload["revocation_status"] == "not_revoked"
    assert payload["template"]["sha256"] == template.sha256
    assert payload["output"]["sha256"] == _sha256(output_path)
    assert payload["input"]["sha256"] == _sha256(input_path)
    assert payload["import_result"]["sha256"] == _sha256(import_result_path)
    assert payload["result_artifact"]["sha256"] == _sha256(result_artifact_path)
    for field in ("template", "input", "output", "import_result", "result_artifact"):
        relative = payload[field]["path"]
        assert PurePosixPath(relative).is_absolute() is False
        assert "\\" not in relative
        assert ".." not in PurePosixPath(relative).parts
        assert relative.startswith("evidence/sha256/")
        bundled = record_path.parent / Path(*PurePosixPath(relative).parts)
        assert _sha256(bundled) == payload[field]["sha256"]

    for source in (input_path, output_path, import_result_path, result_artifact_path):
        source.write_bytes(b"source changed after certification")
    assert _validate(record_path, template.sha256)["production_ready"] is True

    moved_root = tmp_path / "portable-copy"
    shutil.move(str(record_path.parent), moved_root)
    moved_record = moved_root / record_path.name
    assert _validate(moved_record, template.sha256)["production_ready"] is True


def test_manual_misa_certification_rejects_arbitrary_status(tmp_path):
    evidence = _evidence_files(tmp_path, status="approved")

    with pytest.raises(ValueError, match="misa_import_passed"):
        create_manual_certification_record(
            conversion_type="sales_goods",
            template_path=evidence[0].path,
            input_path=evidence[1],
            output_path=evidence[2],
            import_result_path=evidence[3],
            result_artifact_path=evidence[4],
            artifact_dir=tmp_path / "certifications",
            expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
        )


@pytest.mark.parametrize(
    "missing",
    ["template", "input", "output", "import_result", "result_artifact"],
)
def test_manual_misa_certification_rejects_missing_evidence_files(tmp_path, missing):
    evidence = _evidence_files(tmp_path)
    paths = {
        "template": evidence[0].path,
        "input": evidence[1],
        "output": evidence[2],
        "import_result": evidence[3],
        "result_artifact": evidence[4],
    }
    paths[missing] = tmp_path / f"missing-{missing}"

    with pytest.raises(ValueError, match="evidence file does not exist"):
        create_manual_certification_record(
            conversion_type="sales_goods",
            template_path=paths["template"],
            input_path=paths["input"],
            output_path=paths["output"],
            import_result_path=paths["import_result"],
            result_artifact_path=paths["result_artifact"],
            artifact_dir=tmp_path / "certifications",
            expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
        )


def test_manual_misa_certification_rejects_import_run_for_other_output(tmp_path):
    evidence = _evidence_files(tmp_path, import_overrides={"output_sha256": "0" * 64})

    with pytest.raises(ValueError, match="not bound to the output"):
        create_manual_certification_record(
            conversion_type="sales_goods",
            template_path=evidence[0].path,
            input_path=evidence[1],
            output_path=evidence[2],
            import_result_path=evidence[3],
            result_artifact_path=evidence[4],
            artifact_dir=tmp_path / "certifications",
            expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
        )


def test_certification_validation_fails_after_bundled_evidence_tampering(tmp_path):
    evidence, record_path = _create(tmp_path)
    payload = json.loads(record_path.read_text(encoding="utf-8"))
    bundled_output = record_path.parent / Path(*PurePosixPath(payload["output"]["path"]).parts)
    bundled_output.write_bytes(bundled_output.read_bytes() + b"tampered")

    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        _validate(record_path, evidence[0].sha256)


@pytest.mark.parametrize("unsafe_path", ["C:\\customer\\template.xls", "../template.xls"])
def test_certification_validation_rejects_nonportable_evidence_paths(
    tmp_path,
    unsafe_path,
):
    evidence, record_path = _create(tmp_path)
    payload = json.loads(record_path.read_text(encoding="utf-8"))
    payload["template"]["path"] = unsafe_path
    record_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="portable"):
        _validate(record_path, evidence[0].sha256)


def test_certification_rejects_output_identical_to_template(tmp_path):
    evidence = _evidence_files(tmp_path, output_equals_template=True)

    with pytest.raises(ValueError, match="must differ from template"):
        create_manual_certification_record(
            conversion_type="sales_goods",
            template_path=evidence[0].path,
            input_path=evidence[1],
            output_path=evidence[2],
            import_result_path=evidence[3],
            result_artifact_path=evidence[4],
            artifact_dir=tmp_path / "certifications",
            expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"evidence_origin": "self_asserted_placeholder"},
        {"result_artifact_kind": "self_asserted_text"},
        {"reviewer": "same-person", "approver": "same-person"},
        {"schema_version": 1},
    ],
)
def test_certification_rejects_placeholder_or_non_independent_import_evidence(
    tmp_path,
    overrides,
):
    evidence = _evidence_files(tmp_path, import_overrides=overrides)

    with pytest.raises(ValueError):
        create_manual_certification_record(
            conversion_type="sales_goods",
            template_path=evidence[0].path,
            input_path=evidence[1],
            output_path=evidence[2],
            import_result_path=evidence[3],
            result_artifact_path=evidence[4],
            artifact_dir=tmp_path / "certifications",
            expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
        )


def test_certification_rejects_future_expired_and_revoked_timestamps(tmp_path):
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    evidence = _evidence_files(tmp_path, import_overrides={"completed_at_utc": future})
    with pytest.raises(ValueError, match="future"):
        create_manual_certification_record(
            conversion_type="sales_goods",
            template_path=evidence[0].path,
            input_path=evidence[1],
            output_path=evidence[2],
            import_result_path=evidence[3],
            result_artifact_path=evidence[4],
            artifact_dir=tmp_path / "future-certifications",
            expires_at_utc=(datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
        )

    valid_evidence, record_path = _create(tmp_path / "valid")
    payload = json.loads(record_path.read_text(encoding="utf-8"))
    payload["issued_at_utc"] = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    payload["expires_at_utc"] = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    record_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="future"):
        _validate(record_path, valid_evidence[0].sha256)

    payload["issued_at_utc"] = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    payload["expires_at_utc"] = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    record_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="expired"):
        _validate(record_path, valid_evidence[0].sha256)

    payload["issued_at_utc"] = datetime.now(timezone.utc).isoformat()
    payload["expires_at_utc"] = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    payload["revocation_status"] = "revoked"
    payload["revoked_at_utc"] = datetime.now(timezone.utc).isoformat()
    payload["revocation_reason"] = "writer incident"
    record_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="revoked"):
        _validate(record_path, valid_evidence[0].sha256)


def test_manual_certification_cli_accepts_only_complete_evidence(tmp_path):
    evidence = _evidence_files(tmp_path)
    artifact_dir = tmp_path / "certifications"

    exit_code = misa_certification._main(
        [
            "create",
            "--conversion-type",
            "sales_goods",
            "--template",
            str(evidence[0].path),
            "--input",
            str(evidence[1]),
            "--output",
            str(evidence[2]),
            "--import-result",
            str(evidence[3]),
            "--result-artifact",
            str(evidence[4]),
            "--artifact-dir",
            str(artifact_dir),
            "--expires-at",
            (datetime.now(timezone.utc) + timedelta(days=90)).isoformat(),
        ]
    )

    assert exit_code == 0
    assert (artifact_dir / "sales_goods_misa_certification.json").is_file()
