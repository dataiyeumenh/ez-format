from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Mapping

from app.excel_io import write_xls_from_template
from app.misa_templates import get_misa_template, get_misa_template_for_export
from app.models import ExportManifestV1
from app.parsing import parse_date, parse_decimal


ALLOWED_TRANSFORMS = frozenset(
    {
        "set_value",
        "trim_text",
        "normalize_date",
        "normalize_decimal",
        "replace_code",
    }
)


class RetryBlockedError(ValueError):
    pass


@dataclass(frozen=True)
class RetryPreparation:
    before_rows: list[dict[str, Any]]
    rows: list[dict[str, Any]]
    row_origins: list[dict[str, Any]]
    selected_document_group_ids: tuple[str, ...]
    selected_output_row_numbers: tuple[int, ...]


def prepare_retry(
    *,
    manifest: ExportManifestV1 | dict[str, Any],
    selected_document_group_ids: list[str],
    confirmed_failed_group_ids: set[str],
    patches: list[dict[str, Any]],
    source_rows: list[dict[str, Any]] | None = None,
    row_origins: list[dict[str, Any]] | None = None,
    template_headers: list[str] | None = None,
    document_group_statuses: Mapping[str, str] | None = None,
) -> RetryPreparation:
    bound_manifest = (
        manifest
        if isinstance(manifest, ExportManifestV1)
        else ExportManifestV1.model_validate(manifest)
    )
    selected = _selected_groups(selected_document_group_ids)
    groups = _validated_groups(bound_manifest)
    missing = [group_id for group_id in selected if group_id not in groups]
    if missing:
        raise RetryBlockedError(f"missing document group: {missing[0]}")

    for group_id in selected:
        status = (
            str(document_group_statuses.get(group_id) or "unknown").lower()
            if document_group_statuses is not None
            else "failed" if group_id in confirmed_failed_group_ids else "unknown"
        )
        if status != "failed":
            raise RetryBlockedError(f"{status} import status blocks retry for {group_id}")
        if group_id not in confirmed_failed_group_ids:
            raise RetryBlockedError(f"unknown import confirmation for {group_id}")
        if str(groups[group_id].get("group_integrity") or "unknown") != "deterministic":
            raise RetryBlockedError(f"unknown group integrity blocks retry for {group_id}")

    original_rows = _source_rows(bound_manifest, source_rows)
    if len(original_rows) != len(bound_manifest.rows):
        raise RetryBlockedError("source row count does not match trusted manifest")
    origins = row_origins or [
        {"raw_sheet": "", "raw_rows": list(row.raw_row_ids)}
        for row in bound_manifest.rows
    ]
    if len(origins) != len(original_rows):
        raise RetryBlockedError("source row origins do not match trusted manifest")

    selected_numbers = tuple(
        row.output_row_number
        for row in sorted(bound_manifest.rows, key=lambda item: item.output_row_number)
        if row.document_group_id in selected
    )
    selected_number_set = set(selected_numbers)
    selected_rows = [deepcopy(original_rows[number - 1]) for number in selected_numbers]
    before_rows = deepcopy(selected_rows)
    selected_origins = [deepcopy(origins[number - 1]) for number in selected_numbers]
    output_index = {number: index for index, number in enumerate(selected_numbers)}
    headers = set(template_headers or get_misa_template(bound_manifest.target_template_id).headers)

    for patch in patches:
        _apply_patch(
            patch,
            rows=selected_rows,
            output_index=output_index,
            selected_numbers=selected_number_set,
            selected_groups=set(selected),
            manifest=bound_manifest,
            template_headers=headers,
        )

    return RetryPreparation(
        before_rows=before_rows,
        rows=selected_rows,
        row_origins=selected_origins,
        selected_document_group_ids=selected,
        selected_output_row_numbers=selected_numbers,
    )


def export_retry_workbook(
    preparation: RetryPreparation,
    *,
    manifest: ExportManifestV1 | dict[str, Any],
) -> bytes:
    bound_manifest = (
        manifest
        if isinstance(manifest, ExportManifestV1)
        else ExportManifestV1.model_validate(manifest)
    )
    template = get_misa_template_for_export(bound_manifest.target_template_id)
    if template.sha256 != bound_manifest.template_hash:
        raise RetryBlockedError("trusted template checksum mismatch")
    with TemporaryDirectory(prefix="ezformat-retry-") as directory:
        output_path = Path(directory) / "misa-retry.xls"
        write_xls_from_template(template.workbook, preparation.rows, output_path)
        return output_path.read_bytes()


def _selected_groups(values: list[str]) -> tuple[str, ...]:
    selected = tuple(str(value or "").strip() for value in values)
    if not selected or any(not value for value in selected):
        raise RetryBlockedError("missing selected document group")
    if len(set(selected)) != len(selected):
        raise RetryBlockedError("duplicate selected document group")
    return selected


def _validated_groups(manifest: ExportManifestV1) -> dict[str, dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    row_numbers = {row.output_row_number for row in manifest.rows}
    if row_numbers != set(range(1, len(manifest.rows) + 1)):
        raise RetryBlockedError("manifest output rows are not contiguous")
    for raw_group in manifest.document_groups:
        group = dict(raw_group)
        group_id = str(group.get("document_group_id") or "").strip()
        numbers = group.get("output_row_numbers")
        if (
            not group_id
            or group_id in groups
            or not isinstance(numbers, list)
            or not numbers
            or any(not isinstance(number, int) or number not in row_numbers for number in numbers)
            or len(set(numbers)) != len(numbers)
            or int(group.get("line_count") or 0) != len(numbers)
        ):
            raise RetryBlockedError("invalid document group manifest")
        manifest_numbers = {
            row.output_row_number
            for row in manifest.rows
            if row.document_group_id == group_id
        }
        if manifest_numbers != set(numbers):
            raise RetryBlockedError("document group rows do not match manifest")
        groups[group_id] = group
    if {row.document_group_id for row in manifest.rows} != set(groups):
        raise RetryBlockedError("manifest has missing document group")
    return groups


def _source_rows(
    manifest: ExportManifestV1,
    source_rows: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if source_rows is not None:
        if any(not isinstance(row, dict) for row in source_rows):
            raise RetryBlockedError("source rows must be flat objects")
        return source_rows
    return [dict(row.locator) for row in manifest.rows]


def _apply_patch(
    patch: dict[str, Any],
    *,
    rows: list[dict[str, Any]],
    output_index: dict[int, int],
    selected_numbers: set[int],
    selected_groups: set[str],
    manifest: ExportManifestV1,
    template_headers: set[str],
) -> None:
    if not isinstance(patch, dict):
        raise RetryBlockedError("nested patch mutation is forbidden")
    transform = str(patch.get("transform") or "set_value").strip()
    if transform not in ALLOWED_TRANSFORMS:
        raise RetryBlockedError("transform is not allowlisted")
    field = str(patch.get("field") or "").strip()
    if field not in template_headers:
        raise RetryBlockedError("patch field is outside target template headers")
    group_id = str(patch.get("document_group_id") or "").strip()
    if group_id not in selected_groups:
        raise RetryBlockedError("patch document group is not selected")

    requested_number = patch.get("output_row_number")
    if requested_number is not None:
        if not isinstance(requested_number, int) or requested_number not in selected_numbers:
            raise RetryBlockedError("patch output row is outside selected groups")
        manifest_row = manifest.rows[requested_number - 1]
        if manifest_row.document_group_id != group_id:
            raise RetryBlockedError("patch output row does not belong to document group")
        target_numbers = [requested_number]
    else:
        target_numbers = [
            row.output_row_number
            for row in manifest.rows
            if row.document_group_id == group_id and row.output_row_number in selected_numbers
        ]

    _assert_flat_patch_values(patch)
    for number in target_numbers:
        row = rows[output_index[number]]
        row[field] = _transformed_value(row.get(field), transform, patch)


def _assert_flat_patch_values(patch: dict[str, Any]) -> None:
    for key in ("value", "from", "to"):
        value = patch.get(key)
        if isinstance(value, (dict, list, tuple, set)):
            raise RetryBlockedError("nested patch mutation is forbidden")
        if isinstance(value, str) and value.lstrip().startswith("="):
            raise RetryBlockedError("formula patch is forbidden")


def _transformed_value(current: Any, transform: str, patch: dict[str, Any]) -> Any:
    if transform == "set_value":
        return patch.get("value")
    if transform == "trim_text":
        return str(current or "").strip()
    if transform == "normalize_date":
        parsed = parse_date(current)
        if parsed is None:
            raise RetryBlockedError("normalize_date cannot parse current value")
        return parsed
    if transform == "normalize_decimal":
        parsed = parse_decimal(current)
        if parsed is None:
            raise RetryBlockedError("normalize_decimal cannot parse current value")
        return parsed
    if transform == "replace_code":
        expected = patch.get("from")
        if current != expected:
            raise RetryBlockedError("replace_code source does not match current value")
        return patch.get("to")
    raise RetryBlockedError("transform is not allowlisted")
