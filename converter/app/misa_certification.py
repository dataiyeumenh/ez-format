from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from importlib import metadata
from pathlib import Path, PurePosixPath
from typing import Any, Mapping


MISA_IMPORT_SOURCE_URLS = [
    "https://helpamis.misa.vn/kb/nhap-khau/",
    "https://helpamis.misa.vn/amis-mua-hang/kb/copy-du-lieu-tu-excel-vao-chung-tu/",
    "https://www.misa.vn/154745/tai-lieu-open-api-tich-hop-amis-ke-toan-doanh-nghiep/",
]
CERTIFICATION_SCHEMA_VERSION = 2
IMPORT_RESULT_SCHEMA_VERSION = 2
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SAFE_SUFFIX_PATTERN = re.compile(r"^\.[a-z0-9]{1,10}$")
_OLE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")
_CLOCK_SKEW = timedelta(minutes=5)
_MAX_IMPORT_TO_ISSUANCE = timedelta(days=7)
_MAX_CERTIFICATION_LIFETIME = timedelta(days=397)
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
_RESULT_ARTIFACT_KINDS = {
    "misa_import_log",
    "misa_import_report",
    "misa_import_screenshot",
}
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
    "import_run",
    "source_urls",
    "notes",
}


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
    }
    _assert_independent_evidence(evidence)
    import_run = _validated_import_run_bytes(
        evidence["import_result"]["contents"],
        template_sha256=evidence["template"]["sha256"],
        input_sha256=evidence["input"]["sha256"],
        output_sha256=evidence["output"]["sha256"],
        result_artifact_sha256=evidence["result_artifact"]["sha256"],
        result_artifact_contents=evidence["result_artifact"]["contents"],
    )

    issued_at = datetime.now(timezone.utc)
    expires_at = _aware_timestamp(expires_at_utc, "expires_at_utc")
    _validate_certification_window(issued_at, expires_at, now=issued_at)
    completed_at = _aware_timestamp(import_run["completed_at_utc"], "completed_at_utc")
    _validate_import_issuance_window(completed_at, issued_at)

    root = Path(artifact_dir).resolve(strict=False)
    references = {
        name: _bundle_evidence(root, item)
        for name, item in evidence.items()
    }
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
        **references,
        "import_run": import_run,
        "source_urls": MISA_IMPORT_SOURCE_URLS,
        "notes": notes or "Independent reviewed MISA import evidence.",
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
    template = _validated_record_file(
        payload.get("template"), root=root, kind="template", require_xls=True
    )
    input_evidence = _validated_record_file(
        payload.get("input"), root=root, kind="input"
    )
    output = _validated_record_file(
        payload.get("output"), root=root, kind="output", require_xls=True
    )
    import_result = _validated_record_file(
        payload.get("import_result"), root=root, kind="import result"
    )
    result_artifact = _validated_record_file(
        payload.get("result_artifact"), root=root, kind="result artifact"
    )
    evidence = {
        "template": template,
        "input": input_evidence,
        "output": output,
        "import_result": import_result,
        "result_artifact": result_artifact,
    }
    _assert_independent_evidence(evidence)
    if template["sha256"] != template_sha256:
        raise ValueError("MISA certification template SHA-256 mismatch")

    import_run = _validated_import_run_bytes(
        import_result["contents"],
        template_sha256=template["sha256"],
        input_sha256=input_evidence["sha256"],
        output_sha256=output["sha256"],
        result_artifact_sha256=result_artifact["sha256"],
        result_artifact_contents=result_artifact["contents"],
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
    if not isinstance(payload.get("notes"), str):
        raise ValueError("MISA certification notes are invalid")
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
) -> dict[str, Any]:
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
    if payload.get("writer_build_sha256") != current_writer_build_sha256():
        raise ValueError("MISA import result writer build SHA-256 mismatch")
    payload["template_provenance"] = _validated_provenance(
        payload.get("template_provenance")
    )
    completed_at = _aware_timestamp(payload.get("completed_at_utc"), "completed_at_utc")
    if completed_at > datetime.now(timezone.utc) + _CLOCK_SKEW:
        raise ValueError("MISA import result completed_at_utc is in the future")
    _validate_result_artifact(result_artifact_contents)
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


def _validate_result_artifact(contents: bytes) -> None:
    if len(contents) < 32:
        raise ValueError("MISA import result artifact is too small")
    text = contents.decode("utf-8", errors="ignore").strip().casefold()
    if not text:
        return
    if any(marker in text for marker in ("placeholder", "self-asserted", "todo evidence")):
        raise ValueError("MISA import result artifact is a self-asserted placeholder")


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
