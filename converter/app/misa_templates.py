from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.conversion_types import BACKEND_ROOT, CONVERSION_TYPES
from app.excel_io import TemplateWorkbook, read_template


DEFAULT_TEMPLATE_DIR = BACKEND_ROOT / "fixtures" / "templates"
DEFAULT_MANIFEST_PATH = BACKEND_ROOT / "config" / "misa-template-manifest.json"
MANIFEST_SCHEMA_VERSION = 1
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

DISPLAY_FILENAMES = {
    "bsn_sales": "BSN - Form import bán hàng.xls",
    "bsn_purchase": "BSN - Form import mua hàng.xls",
    "misa_purchase_domestic": "mua_hang_trong_nuoc_full.xls",
    "sales_service": "Form bán hàng dịch vụ.xls",
    "sales_goods": "Form bán hàng hóa.xls",
    "purchase_service": "Form mua dịch vụ.xls",
    "purchase_goods": "Form mua hàng hóa.xls",
}


class MisaTemplateProvenanceError(RuntimeError):
    pass


@dataclass(frozen=True)
class TemplateProvenance:
    canonical_filename: str
    bundled_filename: str
    sha256: str
    sheet_name: str
    header_row: int
    column_count: int
    headers: tuple[str, ...]


@dataclass(frozen=True)
class MisaTemplate:
    id: str
    label: str
    filename: str
    path: Path
    workbook: TemplateWorkbook

    @property
    def sheet_name(self) -> str:
        return self.workbook.sheet_name

    @property
    def header_row(self) -> int:
        return self.workbook.header_row_index + 1

    @property
    def data_start_row(self) -> int:
        return self.workbook.header_row_index + 2

    @property
    def headers(self) -> list[str]:
        return self.workbook.headers


def configured_template_dir() -> Path:
    configured = os.getenv("MISA_TEMPLATE_DIR", "").strip()
    return _configured_path(configured, DEFAULT_TEMPLATE_DIR)


def configured_manifest_path() -> Path:
    configured = os.getenv("MISA_TEMPLATE_MANIFEST_PATH", "").strip()
    return _configured_path(configured, DEFAULT_MANIFEST_PATH)


def template_path_for(template_id: str) -> Path:
    if template_id not in CONVERSION_TYPES:
        raise ValueError(f"Unsupported target_template_id: {template_id}")
    provenance = _template_provenance(template_id, configured_manifest_path())
    return _template_path_for(template_id, configured_template_dir(), provenance)


def get_misa_template(template_id: str) -> MisaTemplate:
    if template_id not in CONVERSION_TYPES:
        raise ValueError(f"Unsupported target_template_id: {template_id}")
    provenance = _template_provenance(template_id, configured_manifest_path())
    path = _template_path_for(template_id, configured_template_dir(), provenance)
    workbook = _verified_workbook(template_id, path, provenance)
    definition = CONVERSION_TYPES[template_id]
    return MisaTemplate(
        id=template_id,
        label=definition.label,
        filename=provenance.canonical_filename,
        path=path,
        workbook=workbook,
    )


def list_misa_templates() -> list[MisaTemplate]:
    return [get_misa_template(template_id) for template_id in CONVERSION_TYPES]


def verify_all_misa_templates() -> dict[str, str]:
    verified: dict[str, str] = {}
    for template_id in CONVERSION_TYPES:
        template = get_misa_template(template_id)
        verified[template_id] = hashlib.sha256(template.path.read_bytes()).hexdigest()
    return verified


def regenerate_manifest_candidate(
    *,
    template_dir: Path,
    output_path: Path,
    manifest_version: str,
) -> Path:
    active_path = configured_manifest_path()
    if _same_path(output_path, active_path):
        raise MisaTemplateProvenanceError(
            "Regenerate refuses to overwrite active manifest; write and review a candidate"
        )
    if not manifest_version.strip():
        raise MisaTemplateProvenanceError("Candidate manifest version is required")
    active = _load_manifest(active_path)
    if manifest_version == active["manifest_version"]:
        raise MisaTemplateProvenanceError("Candidate manifest version must change")

    candidate = copy.deepcopy(active)
    candidate["manifest_version"] = manifest_version
    for template_id in CONVERSION_TYPES:
        provenance = _template_provenance_from_manifest(template_id, active)
        path = _template_path_for(template_id, template_dir, provenance)
        _verified_workbook(template_id, path, provenance, verify_hash=False)
        candidate["templates"][template_id]["sha256"] = hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output_path.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(candidate, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except FileExistsError as exc:
        raise MisaTemplateProvenanceError(
            f"Candidate manifest already exists: {output_path}"
        ) from exc
    return output_path


def review_manifest_candidate(*, template_dir: Path, candidate_path: Path) -> None:
    active = _load_manifest(configured_manifest_path())
    candidate = _load_manifest(candidate_path)
    if candidate["manifest_version"] == active["manifest_version"]:
        raise MisaTemplateProvenanceError("Candidate manifest version was not rotated")
    for template_id in CONVERSION_TYPES:
        active_entry = active["templates"][template_id]
        candidate_entry = candidate["templates"][template_id]
        for field in set(active_entry) - {"sha256"}:
            if candidate_entry.get(field) != active_entry[field]:
                raise MisaTemplateProvenanceError(
                    f"Candidate auto-learned {field} for {template_id}; "
                    "manual schema review required"
                )
        provenance = _template_provenance_from_manifest(template_id, candidate)
        path = _template_path_for(template_id, template_dir, provenance)
        _verified_workbook(template_id, path, provenance)


def _configured_path(configured: str, default: Path) -> Path:
    if not configured:
        return default
    path = Path(configured)
    return path if path.is_absolute() else BACKEND_ROOT / path


def _template_path_for(
    template_id: str,
    configured_dir: Path,
    provenance: TemplateProvenance,
) -> Path:
    if _same_path(configured_dir, DEFAULT_TEMPLATE_DIR):
        filename = provenance.bundled_filename
    else:
        filename = provenance.canonical_filename
    path = configured_dir / filename
    if not path.is_file():
        raise MisaTemplateProvenanceError(
            f"MISA template canonical filename is missing for {template_id}: {path}"
        )
    return path


def _same_path(left: Path, right: Path) -> bool:
    return left.resolve(strict=False) == right.resolve(strict=False)


def _template_provenance(template_id: str, manifest_path: Path) -> TemplateProvenance:
    manifest = _load_manifest(manifest_path)
    return _template_provenance_from_manifest(template_id, manifest)


def _template_provenance_from_manifest(
    template_id: str,
    manifest: dict[str, Any],
) -> TemplateProvenance:
    raw_entry = manifest["templates"][template_id]
    expected_fields = {
        "canonical_filename",
        "bundled_filename",
        "sha256",
        "sheet_name",
        "header_row",
        "column_count",
        "headers",
    }
    if not isinstance(raw_entry, dict) or set(raw_entry) != expected_fields:
        raise MisaTemplateProvenanceError(
            f"MISA template manifest entry fields are invalid for {template_id}"
        )

    canonical_filename = raw_entry["canonical_filename"]
    bundled_filename = raw_entry["bundled_filename"]
    if canonical_filename != DISPLAY_FILENAMES[template_id]:
        raise MisaTemplateProvenanceError(
            f"MISA template canonical filename mismatch for {template_id}"
        )
    if bundled_filename != CONVERSION_TYPES[template_id].template_path.name:
        raise MisaTemplateProvenanceError(
            f"MISA template bundled filename mismatch for {template_id}"
        )
    if Path(canonical_filename).name != canonical_filename:
        raise MisaTemplateProvenanceError(
            f"MISA template canonical filename is unsafe for {template_id}"
        )

    sha256 = raw_entry["sha256"]
    sheet_name = raw_entry["sheet_name"]
    header_row = raw_entry["header_row"]
    column_count = raw_entry["column_count"]
    headers = raw_entry["headers"]
    if not isinstance(sha256, str) or not _SHA256_PATTERN.fullmatch(sha256):
        raise MisaTemplateProvenanceError(
            f"MISA template SHA-256 is invalid for {template_id}"
        )
    if not isinstance(sheet_name, str) or not sheet_name:
        raise MisaTemplateProvenanceError(
            f"MISA template sheet invariant is invalid for {template_id}"
        )
    if isinstance(header_row, bool) or not isinstance(header_row, int) or header_row < 1:
        raise MisaTemplateProvenanceError(
            f"MISA template header row invariant is invalid for {template_id}"
        )
    if (
        isinstance(column_count, bool)
        or not isinstance(column_count, int)
        or column_count < 1
    ):
        raise MisaTemplateProvenanceError(
            f"MISA template column count invariant is invalid for {template_id}"
        )
    if not isinstance(headers, list) or any(
        not isinstance(header, str) or not header for header in headers
    ):
        raise MisaTemplateProvenanceError(
            f"MISA template headers invariant is invalid for {template_id}"
        )
    if len(headers) != column_count:
        raise MisaTemplateProvenanceError(
            f"MISA template column count invariant is invalid for {template_id}"
        )
    required_headers = set(CONVERSION_TYPES[template_id].required_output_headers)
    if not required_headers.issubset(headers):
        raise MisaTemplateProvenanceError(
            f"MISA template headers omit required schema for {template_id}"
        )
    return TemplateProvenance(
        canonical_filename=canonical_filename,
        bundled_filename=bundled_filename,
        sha256=sha256,
        sheet_name=sheet_name,
        header_row=header_row,
        column_count=column_count,
        headers=tuple(headers),
    )


def _load_manifest(manifest_path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(
            manifest_path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (OSError, UnicodeError, ValueError) as exc:
        raise MisaTemplateProvenanceError(
            f"MISA template manifest is missing or invalid: {manifest_path}"
        ) from exc
    if not isinstance(manifest, dict):
        raise MisaTemplateProvenanceError("MISA template manifest root must be an object")
    if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise MisaTemplateProvenanceError("MISA template manifest schema version is invalid")
    if not isinstance(manifest.get("manifest_version"), str) or not manifest["manifest_version"]:
        raise MisaTemplateProvenanceError("MISA template manifest version is invalid")
    templates = manifest.get("templates")
    if not isinstance(templates, dict) or set(templates) != set(CONVERSION_TYPES):
        raise MisaTemplateProvenanceError(
            "MISA template manifest template IDs do not match supported template IDs"
        )
    return manifest


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate manifest key: {key}")
        result[key] = value
    return result


def _verified_workbook(
    template_id: str,
    path: Path,
    provenance: TemplateProvenance,
    *,
    verify_hash: bool = True,
) -> TemplateWorkbook:
    try:
        actual_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise MisaTemplateProvenanceError(
            f"MISA template cannot be read for {template_id}: {path}"
        ) from exc
    if verify_hash and actual_sha256 != provenance.sha256:
        raise MisaTemplateProvenanceError(
            f"MISA template SHA-256 mismatch for {template_id}: {path}"
        )
    try:
        workbook = read_template(path)
    except Exception as exc:
        raise MisaTemplateProvenanceError(
            f"MISA template workbook is invalid for {template_id}: {path}"
        ) from exc
    if workbook.sheet_name != provenance.sheet_name:
        raise MisaTemplateProvenanceError(
            f"MISA template sheet invariant mismatch for {template_id}"
        )
    if workbook.header_row_index + 1 != provenance.header_row:
        raise MisaTemplateProvenanceError(
            f"MISA template header row invariant mismatch for {template_id}"
        )
    if len(workbook.headers) != provenance.column_count:
        raise MisaTemplateProvenanceError(
            f"MISA template column count invariant mismatch for {template_id}"
        )
    if tuple(workbook.headers) != provenance.headers:
        raise MisaTemplateProvenanceError(
            f"MISA template headers invariant mismatch for {template_id}"
        )
    return workbook


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify and rotate trusted MISA templates")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("verify", help="Verify all configured templates and hashes")

    regenerate = subparsers.add_parser(
        "regenerate-manifest",
        help="Write a hash-only rotation candidate without changing trusted schema",
    )
    regenerate.add_argument("--template-dir", required=True)
    regenerate.add_argument("--output", required=True)
    regenerate.add_argument("--manifest-version", required=True)

    review = subparsers.add_parser(
        "review-manifest",
        help="Verify a candidate against trusted schema and template bytes",
    )
    review.add_argument("--template-dir", required=True)
    review.add_argument("--candidate", required=True)
    args = parser.parse_args(argv)

    try:
        if args.command == "verify":
            print(json.dumps(verify_all_misa_templates(), sort_keys=True))
        elif args.command == "regenerate-manifest":
            output = regenerate_manifest_candidate(
                template_dir=_configured_path(args.template_dir, DEFAULT_TEMPLATE_DIR),
                output_path=Path(args.output).resolve(strict=False),
                manifest_version=args.manifest_version,
            )
            print(f"Candidate manifest written for review: {output}")
        else:
            review_manifest_candidate(
                template_dir=_configured_path(args.template_dir, DEFAULT_TEMPLATE_DIR),
                candidate_path=Path(args.candidate).resolve(strict=False),
            )
            print("MISA template manifest review passed")
    except (MisaTemplateProvenanceError, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if os.getenv("NODE_ENV", "").strip().lower() == "production":
    verify_all_misa_templates()


if __name__ == "__main__":
    raise SystemExit(_main())
