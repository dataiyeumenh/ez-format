from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from app.conversion_types import BACKEND_ROOT, CONVERSION_TYPES
from app.excel_io import TemplateWorkbook, read_template
from app.misa_biff import (
    advanced_biff_feature_names,
    probe_biff_features,
    scan_template_content,
    scrub_template_copy,
)


DEFAULT_TEMPLATE_DIR = BACKEND_ROOT / "fixtures" / "templates"
DEFAULT_MANIFEST_PATH = BACKEND_ROOT / "config" / "misa-template-manifest.json"
MANIFEST_SCHEMA_VERSION = 3
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_TRUST_LEVEL_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
_BIFF_FEATURE_NAMES = {
    "formulas",
    "defined_names",
    "drawings_objects",
    "data_validations",
}
_PROVENANCE_FIELDS = {
    "source_kind",
    "source_reference",
    "acquisition_date",
    "misa_product",
    "misa_release",
    "reviewer",
    "review_status",
    "trust_level",
    "official_status",
}

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
class TemplateTrustMetadata:
    source_kind: str
    source_reference: str
    acquisition_date: str
    misa_product: str
    misa_release: str
    reviewer: str
    review_status: str
    trust_level: str
    official_status: str


@dataclass(frozen=True)
class TemplateProvenance:
    canonical_filename: str
    bundled_filename: str
    sha256: str
    sheet_name: str
    header_row: int
    column_count: int
    headers: tuple[str, ...]
    trust: TemplateTrustMetadata
    biff_features: dict[str, dict[str, int | str]]


@dataclass(frozen=True)
class MisaTemplate:
    id: str
    label: str
    filename: str
    sha256: str
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


def get_misa_template(
    template_id: str,
    *,
    require_export_safe: bool = False,
) -> MisaTemplate:
    if template_id not in CONVERSION_TYPES:
        raise ValueError(f"Unsupported target_template_id: {template_id}")
    provenance = _template_provenance(template_id, configured_manifest_path())
    path = _template_path_for(template_id, configured_template_dir(), provenance)
    workbook = _verified_workbook(
        template_id,
        path,
        provenance,
        require_export_safe=(require_export_safe or _is_production()),
    )
    definition = CONVERSION_TYPES[template_id]
    return MisaTemplate(
        id=template_id,
        label=definition.label,
        filename=provenance.canonical_filename,
        sha256=provenance.sha256,
        path=path,
        workbook=workbook,
    )


def list_misa_templates() -> list[MisaTemplate]:
    return [get_misa_template(template_id) for template_id in CONVERSION_TYPES]


def verify_all_misa_templates(
    *,
    require_export_safe: bool = False,
) -> dict[str, str]:
    verified: dict[str, str] = {}
    for template_id in CONVERSION_TYPES:
        template = get_misa_template(
            template_id,
            require_export_safe=require_export_safe,
        )
        scan = scan_misa_template_content(
            template.workbook.file_contents,
            header_row_index=template.workbook.header_row_index,
        )
        if not scan.clean:
            raise MisaTemplateProvenanceError(
                f"MISA template contains post-header or residual binary values: {template_id}"
            )
        verified[template_id] = template.sha256
    return verified


probe_misa_template_biff = probe_biff_features
scan_misa_template_content = scan_template_content
scrub_misa_template_copy = scrub_template_copy


def regenerate_manifest_candidate(
    *,
    template_dir: Path,
    output_path: Path,
    manifest_version: str,
    trust: TemplateTrustMetadata,
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
        workbook = _verified_workbook(
            template_id,
            path,
            provenance,
            verify_hash=False,
            verify_biff=False,
        )
        scan = scan_misa_template_content(
            workbook.file_contents,
            header_row_index=workbook.header_row_index,
        )
        if not scan.clean:
            raise MisaTemplateProvenanceError(
                f"MISA template rotation contains post-header or residual binary values: "
                f"{template_id}"
            )
        candidate["templates"][template_id]["sha256"] = hashlib.sha256(
            workbook.file_contents
        ).hexdigest()
        candidate["templates"][template_id]["biff_features"] = probe_biff_features(
            workbook.file_contents
        )
        candidate["templates"][template_id]["provenance"] = _trust_payload(trust)
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
        for field in set(active_entry) - {"sha256", "provenance", "biff_features"}:
            if candidate_entry.get(field) != active_entry[field]:
                raise MisaTemplateProvenanceError(
                    f"Candidate auto-learned {field} for {template_id}; "
                    "manual schema review required"
                )
        provenance = _template_provenance_from_manifest(template_id, candidate)
        if provenance.trust.review_status != "accepted_for_project_use":
            raise MisaTemplateProvenanceError(
                f"Candidate review status is not accepted for {template_id}"
            )
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
        "provenance",
        "biff_features",
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
    trust = _trust_metadata(template_id, raw_entry["provenance"])
    biff_features = _biff_features_metadata(template_id, raw_entry["biff_features"])
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
    _enforce_production_trust(template_id, trust)
    return TemplateProvenance(
        canonical_filename=canonical_filename,
        bundled_filename=bundled_filename,
        sha256=sha256,
        sheet_name=sheet_name,
        header_row=header_row,
        column_count=column_count,
        headers=tuple(headers),
        trust=trust,
        biff_features=biff_features,
    )


def _trust_metadata(template_id: str, value: Any) -> TemplateTrustMetadata:
    if not isinstance(value, dict) or set(value) != _PROVENANCE_FIELDS:
        raise MisaTemplateProvenanceError(
            f"MISA template provenance metadata is invalid for {template_id}"
        )
    if any(not isinstance(value[field], str) or not value[field].strip() for field in value):
        raise MisaTemplateProvenanceError(
            f"MISA template provenance metadata is incomplete for {template_id}"
        )
    trust = TemplateTrustMetadata(**{field: value[field].strip() for field in value})
    if trust.source_kind not in {
        "partner_sample_derived",
        "partner_supplied",
        "vendor_download",
        "internal_reviewed",
    }:
        raise MisaTemplateProvenanceError(
            f"MISA template source kind is invalid for {template_id}"
        )
    if trust.acquisition_date != "unknown":
        try:
            date.fromisoformat(trust.acquisition_date)
        except ValueError as exc:
            raise MisaTemplateProvenanceError(
                f"MISA template acquisition date is invalid for {template_id}"
            ) from exc
    if trust.review_status not in {
        "accepted_for_project_use",
        "pending_review",
        "rejected",
    }:
        raise MisaTemplateProvenanceError(
            f"MISA template review status is invalid for {template_id}"
        )
    if trust.review_status == "accepted_for_project_use" and trust.reviewer.lower() in {
        "unknown",
        "unrecorded",
    }:
        raise MisaTemplateProvenanceError(
            f"MISA template accepted review lacks reviewer for {template_id}"
        )
    if not _TRUST_LEVEL_PATTERN.fullmatch(trust.trust_level):
        raise MisaTemplateProvenanceError(
            f"MISA template trust level is invalid for {template_id}"
        )
    if trust.official_status not in {
        "not_claimed_official",
        "verified_official_source",
    }:
        raise MisaTemplateProvenanceError(
            f"MISA template official status is invalid for {template_id}"
        )
    if trust.source_kind in {"partner_sample_derived", "partner_supplied"} and (
        trust.official_status != "not_claimed_official"
    ):
        raise MisaTemplateProvenanceError(
            f"Partner-supplied MISA template cannot claim official status: {template_id}"
        )
    if trust.official_status == "verified_official_source" and (
        trust.source_kind != "vendor_download"
        or not trust.source_reference.lower().startswith("https://")
        or trust.acquisition_date == "unknown"
        or trust.misa_product == "unknown"
        or trust.misa_release == "unknown"
    ):
        raise MisaTemplateProvenanceError(
            f"Official MISA template claim lacks verifiable metadata: {template_id}"
        )
    return trust


def _trust_payload(trust: TemplateTrustMetadata) -> dict[str, str]:
    return {field: getattr(trust, field) for field in _PROVENANCE_FIELDS}


def _biff_features_metadata(
    template_id: str,
    value: Any,
) -> dict[str, dict[str, int | str]]:
    if not isinstance(value, dict) or set(value) != _BIFF_FEATURE_NAMES:
        raise MisaTemplateProvenanceError(
            f"MISA template BIFF feature probe is invalid for {template_id}"
        )
    normalized: dict[str, dict[str, int | str]] = {}
    for feature in _BIFF_FEATURE_NAMES:
        details = value[feature]
        if not isinstance(details, dict) or set(details) != {"record_count", "sha256"}:
            raise MisaTemplateProvenanceError(
                f"MISA template BIFF feature probe is invalid for {template_id}"
            )
        record_count = details["record_count"]
        digest = details["sha256"]
        if (
            isinstance(record_count, bool)
            or not isinstance(record_count, int)
            or record_count < 0
            or not isinstance(digest, str)
            or not _SHA256_PATTERN.fullmatch(digest)
        ):
            raise MisaTemplateProvenanceError(
                f"MISA template BIFF feature probe is invalid for {template_id}"
            )
        normalized[feature] = {"record_count": record_count, "sha256": digest}
    return normalized


def _enforce_production_trust(
    template_id: str,
    trust: TemplateTrustMetadata,
) -> None:
    if not _is_production():
        return
    accepted = {
        item.strip()
        for item in os.getenv("MISA_TEMPLATE_ACCEPTED_TRUST_LEVELS", "").split(",")
        if item.strip()
    }
    if not accepted or trust.trust_level not in accepted:
        raise MisaTemplateProvenanceError(
            f"MISA template accepted trust level is not configured for {template_id}"
        )
    if trust.review_status != "accepted_for_project_use":
        raise MisaTemplateProvenanceError(
            f"MISA template review status is not accepted for {template_id}"
        )


def _is_production() -> bool:
    return os.getenv("NODE_ENV", "").strip().lower() == "production"


def _enforce_biff_export_capability(
    template_id: str,
    probe: dict[str, dict[str, int | str]],
) -> None:
    unsupported = advanced_biff_feature_names(probe)
    if unsupported:
        raise MisaTemplateProvenanceError(
            "MISA template BIFF preservation is unavailable with the current "
            f"xlutils.copy writer for {template_id}: {', '.join(unsupported)}"
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
    verify_biff: bool = True,
    require_export_safe: bool = False,
) -> TemplateWorkbook:
    try:
        file_contents = path.read_bytes()
        actual_sha256 = hashlib.sha256(file_contents).hexdigest()
    except OSError as exc:
        raise MisaTemplateProvenanceError(
            f"MISA template cannot be read for {template_id}: {path}"
        ) from exc
    if verify_hash and actual_sha256 != provenance.sha256:
        raise MisaTemplateProvenanceError(
            f"MISA template SHA-256 mismatch for {template_id}: {path}"
        )
    try:
        workbook = read_template(path, file_contents=file_contents)
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
    actual_biff_features = probe_biff_features(file_contents)
    if verify_biff and actual_biff_features != provenance.biff_features:
        raise MisaTemplateProvenanceError(
            f"MISA template BIFF feature probe mismatch for {template_id}"
        )
    if require_export_safe:
        _enforce_biff_export_capability(template_id, actual_biff_features)
    return workbook


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify and rotate trusted MISA templates")
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser(
        "verify",
        help="Verify all configured templates and hashes",
    )
    verify.add_argument(
        "--require-export-safe",
        action="store_true",
        help="Fail when the current writer cannot preserve detected BIFF features",
    )

    regenerate = subparsers.add_parser(
        "regenerate-manifest",
        help="Write a hash-only rotation candidate without changing trusted schema",
    )
    regenerate.add_argument("--template-dir", required=True)
    regenerate.add_argument("--output", required=True)
    regenerate.add_argument("--manifest-version", required=True)
    regenerate.add_argument("--source-kind", required=True)
    regenerate.add_argument("--source-reference", required=True)
    regenerate.add_argument("--acquisition-date", required=True)
    regenerate.add_argument("--misa-product", required=True)
    regenerate.add_argument("--misa-release", required=True)
    regenerate.add_argument("--reviewer", required=True)
    regenerate.add_argument("--review-status", required=True)
    regenerate.add_argument("--trust-level", required=True)
    regenerate.add_argument("--official-status", required=True)

    review = subparsers.add_parser(
        "review-manifest",
        help="Verify a candidate against trusted schema and template bytes",
    )
    review.add_argument("--template-dir", required=True)
    review.add_argument("--candidate", required=True)
    args = parser.parse_args(argv)

    try:
        if args.command == "verify":
            print(
                json.dumps(
                    verify_all_misa_templates(
                        require_export_safe=args.require_export_safe,
                    ),
                    sort_keys=True,
                )
            )
        elif args.command == "regenerate-manifest":
            output = regenerate_manifest_candidate(
                template_dir=_configured_path(args.template_dir, DEFAULT_TEMPLATE_DIR),
                output_path=Path(args.output).resolve(strict=False),
                manifest_version=args.manifest_version,
                trust=_trust_metadata(
                    "rotation",
                    {
                        field: getattr(args, field)
                        for field in _PROVENANCE_FIELDS
                    },
                ),
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


if _is_production():
    verify_all_misa_templates(require_export_safe=True)


if __name__ == "__main__":
    raise SystemExit(_main())
