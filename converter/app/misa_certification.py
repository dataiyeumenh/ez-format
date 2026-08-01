from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from importlib import metadata
from io import BytesIO, StringIO
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

import openpyxl
import xlrd

from app.misa_biff import iter_biff_records, scan_ole_metadata


MISA_IMPORT_SOURCE_URLS = [
    "https://helpamis.misa.vn/kb/nhap-khau/",
    "https://helpamis.misa.vn/amis-mua-hang/kb/copy-du-lieu-tu-excel-vao-chung-tu/",
    "https://www.misa.vn/154745/tai-lieu-open-api-tich-hop-amis-ke-toan-doanh-nghiep/",
]
CERTIFICATION_SCHEMA_VERSION = 3
IMPORT_RESULT_SCHEMA_VERSION = 3
FIXTURE_ATTESTATION_SCHEMA_VERSION = 1
RESULT_RECEIPT_SCHEMA_VERSION = 1
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SAFE_SUFFIX_PATTERN = re.compile(r"^\.[a-z0-9]{1,10}$")
_OLE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")
_CLOCK_SKEW = timedelta(minutes=5)
_MAX_IMPORT_TO_ISSUANCE = timedelta(days=7)
_MAX_CERTIFICATION_LIFETIME = timedelta(days=397)
_MAX_ATTESTATION_BYTES = 16 * 1024
_MAX_FIXTURE_MANIFEST_BYTES = 256 * 1024
_MAX_IMPORT_RESULT_BYTES = 64 * 1024
_MAX_RESULT_RECEIPT_BYTES = 64 * 1024
_MAX_WORKBOOK_BYTES = 32 * 1024 * 1024
_MAX_SCANNED_CELLS = 500_000
_PLACEHOLDER_VALUES = {
    "unknown",
    "unrecorded",
    "placeholder",
    "self_asserted",
    "self-asserted",
    "n/a",
    "na",
    "todo",
}
_EVIDENCE_ORIGINS = {"misa_sandbox_import", "misa_controlled_import"}
_RESULT_ARTIFACT_KINDS = {"redacted_json_receipt"}
_SOURCE_KINDS = {
    "partner_sample_derived",
    "partner_supplied",
    "vendor_download",
    "internal_reviewed",
}
_OFFICIAL_STATUSES = {"not_claimed_official", "verified_official_source"}
_WRITER_SOURCE_FILES = (
    "converter.py",
    "excel_io.py",
    "import_repair_export.py",
    "misa_voucher_adapters.py",
    "misa_workflow.py",
)
_WRITER_DEPENDENCIES = ("xlrd", "xlwt", "xlutils", "olefile")
_WRITER_REQUIREMENTS_PATH = Path(__file__).resolve().parent.parent / "requirements.txt"
_PROVENANCE_FIELDS = {"source_kind", "trust_level", "official_status"}
_IMPORT_RUN_FIELDS = {
    "schema_version",
    "evidence_origin",
    "result_artifact_kind",
    "status",
    "template_sha256",
    "output_sha256",
    "input_sha256",
    "result_artifact_sha256",
    "fixture_attestation_sha256",
    "synthetic_fixture_id",
    "privacy_classification",
    "misa_product",
    "misa_release",
    "completed_at_utc",
    "reviewer",
    "approver",
    "writer_build_sha256",
    "template_provenance",
}
_RECORD_FIELDS = {
    "schema_version",
    "conversion_type",
    "status",
    "production_ready",
    "issued_at_utc",
    "expires_at_utc",
    "revocation_status",
    "revoked_at_utc",
    "revocation_reason",
    "template",
    "input",
    "output",
    "import_result",
    "result_artifact",
    "fixture_attestation",
    "fixture_manifest",
    "import_run",
    "source_urls",
    "notes",
}
_FIXTURE_ATTESTATION_FIELDS = {
    "schema_version",
    "synthetic_fixture_id",
    "fixture_kind",
    "privacy_classification",
    "contains_customer_data",
    "generator",
    "reviewer",
    "approval_status",
    "approved_at_utc",
    "input_sha256",
    "output_sha256",
}
_RESULT_RECEIPT_FIELDS = {
    "schema_version",
    "receipt_type",
    "status",
    "redacted",
    "synthetic_fixture_id",
    "imported_rows",
    "warnings_count",
}
_SYNTHETIC_FIXTURE_ID_PATTERN = re.compile(r"^synthetic-[a-z0-9][a-z0-9._-]{7,127}$")
_MANIFEST_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_EMAIL_PATTERN = re.compile(r"(?i)\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b")
_PATH_PATTERN = re.compile(r"(?i)(?:\b[a-z]:\\|\\\\|(?:^|\s)/(?:home|users|var|tmp)/)")
_CUSTOMER_MARKER_PATTERN = re.compile(
    r"(?i)\b(?:customer|client|tenant|company)\b|khách\s+hàng|nhà\s+cung\s+cấp|công\s+ty"
)
_SENSITIVE_HEADER_PATTERN = re.compile(
    r"(?i)customer|supplier|client|contact|email|phone|address|tax|"
    r"khách\s+hàng|nhà\s+cung\s+cấp|người\s+nhận|điện\s+thoại|địa\s+chỉ|mã\s+số\s+thuế"
)


def current_writer_build_sha256() -> str:
    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    components = [
        (f"app/{filename}", (root / filename).read_bytes())
        for filename in _WRITER_SOURCE_FILES
    ]
    components.append(("requirements.txt", _WRITER_REQUIREMENTS_PATH.read_bytes()))
    runtime = {
        "dependencies": {
            dependency: metadata.version(dependency)
            for dependency in _WRITER_DEPENDENCIES
        },
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
    }
    components.append(
        (
            "runtime.json",
            json.dumps(runtime, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        )
    )
    for label, contents in components:
        digest.update(label.encode("ascii"))
        digest.update(b"\0")
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return digest.hexdigest()


def create_manual_certification_record(
    *,
    conversion_type: str,
    template_path: Path,
    input_path: Path,
    output_path: Path,
    import_result_path: Path,
    result_artifact_path: Path,
    fixture_attestation_path: Path,
    fixture_manifest_path: Path,
    artifact_dir: Path,
    expires_at_utc: str,
    notes: str | None = None,
) -> Path:
    evidence = {
        "template": _source_evidence_file(template_path, kind="template", require_xls=True),
        "input": _source_evidence_file(input_path, kind="input"),
        "output": _source_evidence_file(output_path, kind="output", require_xls=True),
        "import_result": _source_evidence_file(
            import_result_path,
            kind="import result",
        ),
        "result_artifact": _source_evidence_file(
            result_artifact_path,
            kind="result artifact",
        ),
        "fixture_attestation": _source_evidence_file(
            fixture_attestation_path,
            kind="fixture attestation",
        ),
        "fixture_manifest": _source_evidence_file(
            fixture_manifest_path,
            kind="fixture manifest",
        ),
    }
    _assert_independent_evidence(evidence)
    for name in (
        "import_result",
        "result_artifact",
        "fixture_attestation",
        "fixture_manifest",
    ):
        if evidence[name]["suffix"] != ".json":
            raise ValueError(f"MISA certification {name.replace('_', ' ')} must be JSON")
    _scan_fixture_privacy(evidence["template"], kind="template")
    _scan_fixture_privacy(evidence["input"], kind="input")
    _scan_fixture_privacy(evidence["output"], kind="output")
    attestation = _validated_fixture_attestation_bytes(
        evidence["fixture_attestation"]["contents"],
        input_sha256=evidence["input"]["sha256"],
        output_sha256=evidence["output"]["sha256"],
    )
    _validated_fixture_manifest_bytes(
        evidence["fixture_manifest"]["contents"],
        input_sha256=evidence["input"]["sha256"],
        output_sha256=evidence["output"]["sha256"],
        synthetic_fixture_id=attestation["synthetic_fixture_id"],
    )
    import_run = _validated_import_run_bytes(
        evidence["import_result"]["contents"],
        template_sha256=evidence["template"]["sha256"],
        input_sha256=evidence["input"]["sha256"],
        output_sha256=evidence["output"]["sha256"],
        result_artifact_sha256=evidence["result_artifact"]["sha256"],
        result_artifact_contents=evidence["result_artifact"]["contents"],
        fixture_attestation_sha256=evidence["fixture_attestation"]["sha256"],
        synthetic_fixture_id=attestation["synthetic_fixture_id"],
    )

    issued_at = datetime.now(timezone.utc)
    expires_at = _aware_timestamp(expires_at_utc, "expires_at_utc")
    _validate_certification_window(issued_at, expires_at, now=issued_at)
    completed_at = _aware_timestamp(import_run["completed_at_utc"], "completed_at_utc")
    _validate_import_issuance_window(completed_at, issued_at)

    root = Path(artifact_dir).resolve(strict=False)
    references = {
        name: _bundle_evidence(root, evidence[name])
        for name in (
            "output",
            "import_result",
            "result_artifact",
            "fixture_attestation",
            "fixture_manifest",
        )
    }
    certification_notes = notes or "Approved synthetic fixture; redacted MISA import receipt."
    if len(certification_notes.encode("utf-8")) > 2_048:
        raise ValueError("MISA certification notes exceed the size limit")
    _assert_privacy_safe_value(certification_notes, kind="notes", sensitive=False)
    payload: dict[str, Any] = {
        "schema_version": CERTIFICATION_SCHEMA_VERSION,
        "conversion_type": _required_text(conversion_type, "conversion_type"),
        "status": "misa_import_passed",
        "production_ready": True,
        "issued_at_utc": issued_at.isoformat(),
        "expires_at_utc": expires_at.isoformat(),
        "revocation_status": "not_revoked",
        "revoked_at_utc": None,
        "revocation_reason": None,
        "template": {"sha256": evidence["template"]["sha256"]},
        "input": {
            "sha256": evidence["input"]["sha256"],
            "synthetic_fixture_id": attestation["synthetic_fixture_id"],
        },
        **references,
        "import_run": import_run,
        "source_urls": MISA_IMPORT_SOURCE_URLS,
        "notes": certification_notes,
    }
    record_path = root / f"{conversion_type}_misa_certification.json"
    _write_new_file(
        record_path,
        (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        ),
        allow_identical_existing=False,
    )
    return record_path


def validate_manual_certification_record(
    record_path: Path,
    *,
    conversion_type: str,
    template_sha256: str,
    template_provenance: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    record_path = Path(record_path).resolve(strict=False)
    payload = _read_json_object(record_path, "certification record")
    if (
        set(payload) != _RECORD_FIELDS
        or payload.get("schema_version") != CERTIFICATION_SCHEMA_VERSION
    ):
        raise ValueError("MISA certification record schema is invalid")
    if payload.get("conversion_type") != conversion_type:
        raise ValueError("MISA certification conversion type mismatch")
    if (
        payload.get("status") != "misa_import_passed"
        or payload.get("production_ready") is not True
    ):
        raise ValueError("MISA certification is not a successful import")
    if payload.get("revocation_status") != "not_revoked":
        raise ValueError("MISA certification is revoked")
    if payload.get("revoked_at_utc") is not None or payload.get("revocation_reason") is not None:
        raise ValueError("MISA certification revocation fields are invalid")

    now = datetime.now(timezone.utc)
    issued_at = _aware_timestamp(payload.get("issued_at_utc"), "issued_at_utc")
    expires_at = _aware_timestamp(payload.get("expires_at_utc"), "expires_at_utc")
    if issued_at > now + _CLOCK_SKEW:
        raise ValueError("MISA certification issued_at_utc is in the future")
    _validate_certification_window(issued_at, expires_at, now=now)

    root = record_path.parent
    template = _validated_hash_reference(payload.get("template"), kind="template")
    input_evidence = _validated_input_reference(payload.get("input"))
    output = _validated_record_file(
        payload.get("output"), root=root, kind="output", require_xls=True
    )
    import_result = _validated_record_file(
        payload.get("import_result"), root=root, kind="import result"
    )
    result_artifact = _validated_record_file(
        payload.get("result_artifact"), root=root, kind="result artifact"
    )
    fixture_attestation = _validated_record_file(
        payload.get("fixture_attestation"), root=root, kind="fixture attestation"
    )
    fixture_manifest = _validated_record_file(
        payload.get("fixture_manifest"), root=root, kind="fixture manifest"
    )
    for name, item in {
        "import result": import_result,
        "result artifact": result_artifact,
        "fixture attestation": fixture_attestation,
        "fixture manifest": fixture_manifest,
    }.items():
        if item["suffix"] != ".json":
            raise ValueError(f"MISA certification {name} must be JSON")
    evidence = {
        "template": template,
        "input": input_evidence,
        "output": output,
        "import_result": import_result,
        "result_artifact": result_artifact,
        "fixture_attestation": fixture_attestation,
        "fixture_manifest": fixture_manifest,
    }
    _assert_independent_evidence(evidence)
    _scan_fixture_privacy(output, kind="output")
    if template["sha256"] != template_sha256:
        raise ValueError("MISA certification template SHA-256 mismatch")

    attestation = _validated_fixture_attestation_bytes(
        fixture_attestation["contents"],
        input_sha256=input_evidence["sha256"],
        output_sha256=output["sha256"],
    )
    if input_evidence["synthetic_fixture_id"] != attestation["synthetic_fixture_id"]:
        raise ValueError("MISA certification input fixture attestation mismatch")
    _validated_fixture_manifest_bytes(
        fixture_manifest["contents"],
        input_sha256=input_evidence["sha256"],
        output_sha256=output["sha256"],
        synthetic_fixture_id=attestation["synthetic_fixture_id"],
    )

    import_run = _validated_import_run_bytes(
        import_result["contents"],
        template_sha256=template["sha256"],
        input_sha256=input_evidence["sha256"],
        output_sha256=output["sha256"],
        result_artifact_sha256=result_artifact["sha256"],
        result_artifact_contents=result_artifact["contents"],
        fixture_attestation_sha256=fixture_attestation["sha256"],
        synthetic_fixture_id=attestation["synthetic_fixture_id"],
    )
    if payload.get("import_run") != import_run:
        raise ValueError("MISA certification import run metadata mismatch")
    completed_at = _aware_timestamp(import_run["completed_at_utc"], "completed_at_utc")
    _validate_import_issuance_window(completed_at, issued_at)
    if template_provenance is not None:
        expected_provenance = _validated_provenance(dict(template_provenance))
        if import_run["template_provenance"] != expected_provenance:
            raise ValueError("MISA certification template provenance mismatch")
    if payload.get("source_urls") != MISA_IMPORT_SOURCE_URLS:
        raise ValueError("MISA certification source URLs are invalid")
    if not isinstance(payload.get("notes"), str) or len(payload["notes"].encode("utf-8")) > 2_048:
        raise ValueError("MISA certification notes are invalid")
    _assert_privacy_safe_value(payload["notes"], kind="notes", sensitive=False)
    return payload


def _source_evidence_file(
    path: Path,
    *,
    kind: str,
    require_xls: bool = False,
) -> dict[str, Any]:
    resolved = Path(path).resolve(strict=False)
    if not resolved.is_file():
        raise ValueError(f"MISA certification evidence file does not exist: {kind}")
    contents = resolved.read_bytes()
    if not contents:
        raise ValueError(f"MISA certification evidence file is empty: {kind}")
    if require_xls and (
        resolved.suffix.lower() != ".xls" or not contents.startswith(_OLE_SIGNATURE)
    ):
        raise ValueError(f"MISA certification evidence is not a BIFF .xls file: {kind}")
    suffix = resolved.suffix.lower()
    if not _SAFE_SUFFIX_PATTERN.fullmatch(suffix):
        suffix = ".bin"
    return {
        "contents": contents,
        "sha256": hashlib.sha256(contents).hexdigest(),
        "suffix": suffix,
    }


def _bundle_evidence(root: Path, item: dict[str, Any]) -> dict[str, str]:
    relative = PurePosixPath(
        "evidence",
        "sha256",
        f"{item['sha256']}{item['suffix']}",
    )
    destination = root.joinpath(*relative.parts)
    _write_new_file(destination, item["contents"], allow_identical_existing=True)
    return {"path": relative.as_posix(), "sha256": item["sha256"]}


def _write_new_file(
    path: Path,
    contents: bytes,
    *,
    allow_identical_existing: bool,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(contents)
    except FileExistsError as exc:
        if allow_identical_existing and path.read_bytes() == contents:
            return
        raise ValueError(f"MISA certification immutable path already exists: {path.name}") from exc


def _validated_hash_reference(value: object, *, kind: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"sha256"}:
        raise ValueError(f"MISA certification {kind} evidence is invalid")
    sha256 = value.get("sha256")
    if not isinstance(sha256, str) or not _SHA256_PATTERN.fullmatch(sha256):
        raise ValueError(f"MISA certification {kind} SHA-256 is invalid")
    return {"sha256": sha256}


def _validated_input_reference(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"sha256", "synthetic_fixture_id"}:
        raise ValueError("MISA certification input evidence is invalid")
    sha256 = value.get("sha256")
    if not isinstance(sha256, str) or not _SHA256_PATTERN.fullmatch(sha256):
        raise ValueError("MISA certification input SHA-256 is invalid")
    fixture_id = _validated_synthetic_fixture_id(value.get("synthetic_fixture_id"))
    return {"sha256": sha256, "synthetic_fixture_id": fixture_id}


def _validated_record_file(
    value: object,
    *,
    root: Path,
    kind: str,
    require_xls: bool = False,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"path", "sha256"}:
        raise ValueError(f"MISA certification {kind} evidence is invalid")
    expected_sha256 = value.get("sha256")
    if not isinstance(expected_sha256, str) or not _SHA256_PATTERN.fullmatch(
        expected_sha256
    ):
        raise ValueError(f"MISA certification {kind} SHA-256 is invalid")
    relative = _validated_relative_path(value.get("path"), expected_sha256, kind)
    resolved_root = root.resolve(strict=False)
    path = resolved_root.joinpath(*relative.parts).resolve(strict=False)
    if not path.is_relative_to(resolved_root):
        raise ValueError(f"MISA certification {kind} evidence path escapes root")
    actual = _source_evidence_file(path, kind=kind, require_xls=require_xls)
    if actual["sha256"] != expected_sha256:
        raise ValueError(f"MISA certification {kind} SHA-256 mismatch")
    return actual


def _validated_relative_path(
    value: object,
    expected_sha256: str,
    kind: str,
) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError(f"MISA certification {kind} evidence path is not portable")
    relative = PurePosixPath(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"MISA certification {kind} evidence path is not portable")
    if relative.parts[:2] != ("evidence", "sha256") or len(relative.parts) != 3:
        raise ValueError(f"MISA certification {kind} evidence path is invalid")
    if not relative.name.startswith(f"{expected_sha256}."):
        raise ValueError(f"MISA certification {kind} evidence path is not content-addressed")
    return relative


def _validated_import_run_bytes(
    contents: bytes,
    *,
    template_sha256: str,
    input_sha256: str,
    output_sha256: str,
    result_artifact_sha256: str,
    result_artifact_contents: bytes,
    fixture_attestation_sha256: str,
    synthetic_fixture_id: str,
) -> dict[str, Any]:
    if len(contents) > _MAX_IMPORT_RESULT_BYTES:
        raise ValueError("MISA import result evidence exceeds the size limit")
    payload = _read_json_bytes(contents, "import result")
    if (
        set(payload) != _IMPORT_RUN_FIELDS
        or payload.get("schema_version") != IMPORT_RESULT_SCHEMA_VERSION
    ):
        raise ValueError("MISA import result evidence schema is invalid")
    if payload.get("status") != "misa_import_passed":
        raise ValueError("MISA import result status must be misa_import_passed")
    bindings = {
        "template_sha256": template_sha256,
        "input_sha256": input_sha256,
        "output_sha256": output_sha256,
        "result_artifact_sha256": result_artifact_sha256,
        "fixture_attestation_sha256": fixture_attestation_sha256,
    }
    for field, expected in bindings.items():
        if payload.get(field) != expected:
            label = field.removesuffix("_sha256").replace("_", " ")
            raise ValueError(f"MISA import result is not bound to the {label} SHA-256")
    for field in ("misa_product", "misa_release", "reviewer", "approver"):
        _non_placeholder_text(payload.get(field), field)
    if payload["reviewer"].strip().casefold() == payload["approver"].strip().casefold():
        raise ValueError("MISA import result reviewer and approver must be independent")
    if payload.get("evidence_origin") not in _EVIDENCE_ORIGINS:
        raise ValueError("MISA import result evidence origin is invalid")
    if payload.get("result_artifact_kind") not in _RESULT_ARTIFACT_KINDS:
        raise ValueError("MISA import result artifact kind is invalid")
    if payload.get("synthetic_fixture_id") != synthetic_fixture_id:
        raise ValueError("MISA import result synthetic fixture attestation mismatch")
    if payload.get("privacy_classification") != "synthetic_no_customer_data":
        raise ValueError("MISA import result privacy classification is invalid")
    if payload.get("writer_build_sha256") != current_writer_build_sha256():
        raise ValueError("MISA import result writer build SHA-256 mismatch")
    payload["template_provenance"] = _validated_provenance(
        payload.get("template_provenance")
    )
    completed_at = _aware_timestamp(payload.get("completed_at_utc"), "completed_at_utc")
    if completed_at > datetime.now(timezone.utc) + _CLOCK_SKEW:
        raise ValueError("MISA import result completed_at_utc is in the future")
    _validate_result_artifact(
        result_artifact_contents,
        synthetic_fixture_id=synthetic_fixture_id,
    )
    return payload


def _validated_provenance(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != _PROVENANCE_FIELDS:
        raise ValueError("MISA certification template provenance is invalid")
    normalized = {
        field: _required_text(value.get(field), f"template_provenance.{field}")
        for field in _PROVENANCE_FIELDS
    }
    if normalized["source_kind"] not in _SOURCE_KINDS:
        raise ValueError("MISA certification template source kind is invalid")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{1,63}", normalized["trust_level"]):
        raise ValueError("MISA certification template trust level is invalid")
    if normalized["official_status"] not in _OFFICIAL_STATUSES:
        raise ValueError("MISA certification template official status is invalid")
    return normalized


def _validated_fixture_attestation_bytes(
    contents: bytes,
    *,
    input_sha256: str,
    output_sha256: str,
) -> dict[str, Any]:
    if len(contents) > _MAX_ATTESTATION_BYTES:
        raise ValueError("MISA synthetic fixture attestation exceeds the size limit")
    payload = _read_json_bytes(contents, "synthetic fixture attestation")
    if (
        set(payload) != _FIXTURE_ATTESTATION_FIELDS
        or payload.get("schema_version") != FIXTURE_ATTESTATION_SCHEMA_VERSION
    ):
        raise ValueError("MISA synthetic fixture attestation schema is invalid")
    fixture_id = _validated_synthetic_fixture_id(payload.get("synthetic_fixture_id"))
    if payload.get("fixture_kind") != "synthetic":
        raise ValueError("MISA synthetic fixture attestation fixture kind is invalid")
    if payload.get("privacy_classification") != "synthetic_no_customer_data":
        raise ValueError("MISA synthetic fixture attestation privacy classification is invalid")
    if payload.get("contains_customer_data") is not False:
        raise ValueError("MISA synthetic fixture attestation permits customer data")
    generator = _attestation_text(payload.get("generator"), "generator")
    reviewer = _attestation_text(payload.get("reviewer"), "reviewer")
    if generator.casefold() == reviewer.casefold():
        raise ValueError("MISA synthetic fixture attestation reviewer must be independent")
    if payload.get("approval_status") != "approved":
        raise ValueError("MISA synthetic fixture attestation is not approved")
    approved_at = _aware_timestamp(payload.get("approved_at_utc"), "approved_at_utc")
    if approved_at > datetime.now(timezone.utc) + _CLOCK_SKEW:
        raise ValueError("MISA synthetic fixture attestation approval is in the future")
    for field, expected in {
        "input_sha256": input_sha256,
        "output_sha256": output_sha256,
    }.items():
        if payload.get(field) != expected:
            raise ValueError(f"MISA synthetic fixture attestation {field} mismatch")
    payload["synthetic_fixture_id"] = fixture_id
    payload["generator"] = generator
    payload["reviewer"] = reviewer
    return payload


def _validated_fixture_manifest_bytes(
    contents: bytes,
    *,
    input_sha256: str,
    output_sha256: str,
    synthetic_fixture_id: str,
) -> dict[str, Any]:
    if len(contents) > _MAX_FIXTURE_MANIFEST_BYTES:
        raise ValueError("MISA synthetic fixture manifest exceeds the size limit")
    payload = _read_json_bytes(contents, "synthetic fixture manifest")
    if set(payload) != {"schema_version", "fixture_version", "fixtures"}:
        raise ValueError("MISA synthetic fixture manifest schema is invalid")
    if payload.get("schema_version") != 2:
        raise ValueError("MISA synthetic fixture manifest schema is invalid")
    fixture_version = _non_placeholder_text(
        payload.get("fixture_version"),
        "fixture manifest version",
    )
    if not _MANIFEST_TOKEN_PATTERN.fullmatch(fixture_version):
        raise ValueError("MISA synthetic fixture manifest version is invalid")
    fixtures = payload.get("fixtures")
    if not isinstance(fixtures, dict) or not 1 <= len(fixtures) <= 256:
        raise ValueError("MISA synthetic fixture manifest fixtures are invalid")

    entries_by_sha256: dict[str, list[dict[str, Any]]] = {}
    required_fields = {
        "sha256",
        "path",
        "source_kind",
        "fixture_kind",
        "privacy_classification",
        "contains_customer_data",
        "generator",
        "reviewer",
        "approval_status",
        "approved_at_utc",
        "synthetic_fixture_id",
    }
    optional_fields = {
        "derived_from",
        "target_template_id",
        "template_sha256",
        "row_count",
        "column_count",
    }
    for name, entry in fixtures.items():
        if (
            not isinstance(name, str)
            or not _MANIFEST_TOKEN_PATTERN.fullmatch(name)
            or not isinstance(entry, dict)
        ):
            raise ValueError("MISA synthetic fixture manifest entry is invalid")
        if not required_fields.issubset(entry) or not set(entry).issubset(
            required_fields | optional_fields
        ):
            raise ValueError("MISA synthetic fixture manifest entry schema is invalid")
        sha256 = entry.get("sha256")
        if not isinstance(sha256, str) or not _SHA256_PATTERN.fullmatch(sha256):
            raise ValueError("MISA synthetic fixture manifest SHA-256 is invalid")
        path_text = entry.get("path")
        if not isinstance(path_text, str) or "\\" in path_text or ":" in path_text:
            raise ValueError("MISA synthetic fixture manifest path is not portable")
        relative = PurePosixPath(path_text)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError("MISA synthetic fixture manifest path is not portable")
        _assert_privacy_safe_value(path_text, kind="fixture manifest path", sensitive=False)
        if entry.get("source_kind") != "deterministic_synthetic":
            raise ValueError("MISA synthetic fixture manifest source kind is invalid")
        if entry.get("fixture_kind") != "synthetic":
            raise ValueError("MISA synthetic fixture manifest fixture kind is invalid")
        if entry.get("privacy_classification") != "synthetic_no_customer_data":
            raise ValueError("MISA synthetic fixture manifest privacy classification is invalid")
        if entry.get("contains_customer_data") is not False:
            raise ValueError("MISA synthetic fixture manifest permits customer data")
        generator = _attestation_text(entry.get("generator"), "fixture manifest generator")
        reviewer = _attestation_text(entry.get("reviewer"), "fixture manifest reviewer")
        if generator.casefold() == reviewer.casefold():
            raise ValueError("MISA synthetic fixture manifest reviewer must be independent")
        if entry.get("approval_status") != "approved":
            raise ValueError("MISA synthetic fixture manifest entry is not approved")
        approved_at = _aware_timestamp(
            entry.get("approved_at_utc"),
            "fixture manifest approved_at_utc",
        )
        if approved_at > datetime.now(timezone.utc) + _CLOCK_SKEW:
            raise ValueError("MISA synthetic fixture manifest approval is in the future")
        fixture_id = _validated_synthetic_fixture_id(entry.get("synthetic_fixture_id"))
        for field in ("derived_from", "target_template_id"):
            if field in entry and (
                not isinstance(entry[field], str)
                or not _MANIFEST_TOKEN_PATTERN.fullmatch(entry[field])
            ):
                raise ValueError(f"MISA synthetic fixture manifest {field} is invalid")
        if "template_sha256" in entry and (
            not isinstance(entry["template_sha256"], str)
            or not _SHA256_PATTERN.fullmatch(entry["template_sha256"])
        ):
            raise ValueError("MISA synthetic fixture manifest template SHA-256 is invalid")
        for field in ("row_count", "column_count"):
            value = entry.get(field)
            if field in entry and (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not 0 <= value <= 1_000_000
            ):
                raise ValueError(f"MISA synthetic fixture manifest {field} is invalid")
        normalized = dict(entry)
        normalized["synthetic_fixture_id"] = fixture_id
        entries_by_sha256.setdefault(sha256, []).append(normalized)

    input_entries = entries_by_sha256.get(input_sha256, [])
    output_entries = entries_by_sha256.get(output_sha256, [])
    if len(input_entries) != 1 or len(output_entries) != 1:
        raise ValueError("MISA synthetic fixture manifest does not approve the input and output")
    if output_entries[0]["synthetic_fixture_id"] != synthetic_fixture_id:
        raise ValueError("MISA synthetic fixture manifest output fixture ID mismatch")
    return payload


def _validated_synthetic_fixture_id(value: object) -> str:
    fixture_id = _attestation_text(value, "synthetic_fixture_id")
    if not _SYNTHETIC_FIXTURE_ID_PATTERN.fullmatch(fixture_id):
        raise ValueError("MISA synthetic fixture attestation fixture ID is invalid")
    return fixture_id


def _attestation_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"MISA synthetic fixture attestation {field} is required")
    text = value.strip()
    if text.casefold() in _PLACEHOLDER_VALUES:
        raise ValueError(f"MISA synthetic fixture attestation {field} is a placeholder")
    return text


def _assert_independent_evidence(evidence: Mapping[str, Mapping[str, Any]]) -> None:
    template_hash = evidence["template"]["sha256"]
    output_hash = evidence["output"]["sha256"]
    if output_hash == template_hash:
        raise ValueError("MISA certification output must differ from template")
    primary_hashes = {
        evidence[name]["sha256"]
        for name in ("template", "input", "output", "result_artifact")
    }
    if len(primary_hashes) != 4:
        raise ValueError("MISA certification evidence artifacts must be independent")


def _validate_result_artifact(contents: bytes, *, synthetic_fixture_id: str) -> None:
    if len(contents) > _MAX_RESULT_RECEIPT_BYTES:
        raise ValueError("MISA import result receipt exceeds the size limit")
    payload = _read_json_bytes(contents, "import result receipt")
    if (
        set(payload) != _RESULT_RECEIPT_FIELDS
        or payload.get("schema_version") != RESULT_RECEIPT_SCHEMA_VERSION
    ):
        raise ValueError("MISA import result receipt schema is invalid")
    if (
        payload.get("receipt_type") != "misa_import_receipt"
        or payload.get("status") != "success"
        or payload.get("redacted") is not True
    ):
        raise ValueError("MISA import result receipt is not a redacted success receipt")
    if payload.get("synthetic_fixture_id") != synthetic_fixture_id:
        raise ValueError("MISA import result receipt fixture attestation mismatch")
    for field in ("imported_rows", "warnings_count"):
        value = payload.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1_000_000:
            raise ValueError(f"MISA import result receipt {field} is invalid")
    for value in payload.values():
        if isinstance(value, str):
            _assert_privacy_safe_value(value, kind="result receipt", sensitive=False)


def _scan_fixture_privacy(item: Mapping[str, Any], *, kind: str) -> None:
    contents = item["contents"]
    suffix = item["suffix"]
    if len(contents) > _MAX_WORKBOOK_BYTES:
        raise ValueError(f"MISA certification {kind} privacy scan size limit exceeded")
    try:
        if suffix == ".xls":
            metadata_scan = scan_ole_metadata(contents)
            unsafe_metadata = (
                metadata_scan.ole_property_value_count
                or metadata_scan.ole_property_parse_error_count
                or metadata_scan.unknown_ole_stream_count
                or metadata_scan.unsafe_ole_stream_count
                or metadata_scan.property_stream_residual_count
            )
            if unsafe_metadata:
                raise ValueError(f"MISA certification {kind} privacy scan found workbook metadata")
            _scan_biff_user_metadata(contents, kind=kind)
            workbook = xlrd.open_workbook(file_contents=contents, on_demand=True)
            for sheet in workbook.sheets():
                _scan_tabular_rows(
                    (sheet.row_values(index) for index in range(sheet.nrows)),
                    kind=kind,
                )
        elif suffix in {".xlsx", ".xlsm"}:
            workbook = openpyxl.load_workbook(
                BytesIO(contents),
                read_only=True,
                data_only=False,
            )
            for value in vars(workbook.properties).values():
                if isinstance(value, str):
                    _assert_privacy_safe_value(value, kind=f"{kind} metadata", sensitive=False)
            for sheet in workbook.worksheets:
                _scan_tabular_rows(sheet.iter_rows(values_only=True), kind=kind)
            workbook.close()
        elif suffix in {".csv", ".tsv", ".txt"}:
            text = contents.decode("utf-8-sig")
            delimiter = "\t" if suffix == ".tsv" else ","
            _scan_tabular_rows(csv.reader(StringIO(text), delimiter=delimiter), kind=kind)
        else:
            raise ValueError(f"MISA certification {kind} privacy scan format is unsupported")
    except (UnicodeDecodeError, xlrd.XLRDError, OSError, ValueError) as exc:
        if isinstance(exc, ValueError) and "privacy scan" in str(exc):
            raise
        raise ValueError(f"MISA certification {kind} privacy scan failed") from exc


def _scan_biff_user_metadata(contents: bytes, *, kind: str) -> None:
    for record in iter_biff_records(contents):
        if record.record_id not in {0x005B, 0x005C}:
            continue
        ascii_decoded = record.payload.decode("latin-1", errors="ignore").strip(" \t\r\n\0")
        values = {ascii_decoded} if ascii_decoded else set()
        if record.payload.count(b"\0") * 4 >= len(record.payload):
            decoded = record.payload.decode("utf-16le", errors="ignore").strip(" \t\r\n\0")
            if decoded:
                values.add(decoded)
        if any(value.casefold() != "none" and not value.upper().startswith("SYN-") for value in values):
            raise ValueError(f"MISA certification {kind} privacy scan found workbook user metadata")


def _scan_tabular_rows(rows: Any, *, kind: str) -> None:
    buffered = [tuple(row) for row in rows]
    cell_count = sum(len(row) for row in buffered)
    if cell_count > _MAX_SCANNED_CELLS:
        raise ValueError(f"MISA certification {kind} privacy scan cell limit exceeded")
    if not buffered:
        return
    header_index = max(
        range(min(len(buffered), 50)),
        key=lambda index: sum(
            isinstance(value, str) and bool(value.strip()) for value in buffered[index]
        ),
    )
    headers = [str(value or "").strip() for value in buffered[header_index]]
    for row_index, row in enumerate(buffered):
        for column_index, value in enumerate(row):
            if value in (None, "") or row_index == header_index:
                continue
            header = headers[column_index] if column_index < len(headers) else ""
            sensitive = row_index > header_index and bool(_SENSITIVE_HEADER_PATTERN.search(header))
            _assert_privacy_safe_value(value, kind=kind, sensitive=sensitive)


def _assert_privacy_safe_value(value: object, *, kind: str, sensitive: bool) -> None:
    text = str(value).strip()
    if not text:
        return
    synthetic = text.upper().startswith("SYN-") or "@example.invalid" in text.casefold()
    if _PATH_PATTERN.search(text):
        raise ValueError(f"MISA certification {kind} privacy scan found a filesystem path")
    if _EMAIL_PATTERN.search(text) and not synthetic:
        raise ValueError(f"MISA certification {kind} privacy scan found an email address")
    if _CUSTOMER_MARKER_PATTERN.search(text) and not synthetic:
        raise ValueError(f"MISA certification {kind} privacy scan found a customer marker")
    if sensitive and not synthetic:
        raise ValueError(f"MISA certification {kind} privacy scan found non-synthetic identity data")


def _validate_certification_window(
    issued_at: datetime,
    expires_at: datetime,
    *,
    now: datetime,
) -> None:
    if expires_at <= issued_at:
        raise ValueError("MISA certification expires_at_utc must follow issued_at_utc")
    if expires_at - issued_at > _MAX_CERTIFICATION_LIFETIME:
        raise ValueError("MISA certification lifetime is not sane")
    if expires_at <= now:
        raise ValueError("MISA certification is expired")


def _validate_import_issuance_window(completed_at: datetime, issued_at: datetime) -> None:
    if completed_at > issued_at + _CLOCK_SKEW:
        raise ValueError("MISA import result completed_at_utc follows certification issuance")
    if issued_at - completed_at > _MAX_IMPORT_TO_ISSUANCE:
        raise ValueError("MISA import result is too old for certification issuance")


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        contents = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"MISA {label} is missing or invalid") from exc
    return _read_json_bytes(contents, label)


def _read_json_bytes(contents: bytes, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(contents.decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise ValueError(f"MISA {label} is missing or invalid") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"MISA {label} must be a JSON object")
    return payload


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"MISA certification {field} is required")
    return value.strip()


def _non_placeholder_text(value: object, field: str) -> str:
    text = _required_text(value, field)
    if text.casefold() in _PLACEHOLDER_VALUES:
        raise ValueError(f"MISA import result {field} must be explicit")
    return text


def _aware_timestamp(value: object, field: str) -> datetime:
    text = _required_text(value, field)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"MISA certification {field} is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"MISA certification {field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create portable evidence-bound MISA template certification",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--conversion-type", required=True)
    create.add_argument("--template", required=True)
    create.add_argument("--input", required=True)
    create.add_argument("--output", required=True)
    create.add_argument("--import-result", required=True)
    create.add_argument("--result-artifact", required=True)
    create.add_argument("--fixture-attestation", required=True)
    create.add_argument("--fixture-manifest", required=True)
    create.add_argument("--artifact-dir", required=True)
    create.add_argument("--expires-at", required=True)
    create.add_argument("--notes")
    args = parser.parse_args(argv)
    try:
        record_path = create_manual_certification_record(
            conversion_type=args.conversion_type,
            template_path=Path(args.template),
            input_path=Path(args.input),
            output_path=Path(args.output),
            import_result_path=Path(args.import_result),
            result_artifact_path=Path(args.result_artifact),
            fixture_attestation_path=Path(args.fixture_attestation),
            fixture_manifest_path=Path(args.fixture_manifest),
            artifact_dir=Path(args.artifact_dir),
            expires_at_utc=args.expires_at,
            notes=args.notes,
        )
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(record_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
