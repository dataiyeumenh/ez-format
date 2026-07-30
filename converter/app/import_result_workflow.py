from __future__ import annotations

from typing import Any

from app.export_manifest import build_export_manifest
from app.import_repair_export import (
    RetryBlockedError,
    RetryPreparation,
    export_retry_workbook,
    prepare_retry,
)
from app.import_result_matching import MatchSuggestion, suggest_issue_matches
from app.import_result_models import (
    ImportResultColumnMapping,
    ImportResultInspection,
    NormalizedImportIssue,
)
from app.import_result_parser import inspect_import_result, normalize_import_result
from app.misa_readiness import build_readiness_report
from app.misa_workflow import ReadinessGateError, _resolve_confirmed_export
from app.models import ExportManifestV1


def analyze_import_result(*, content: bytes, filename: str) -> ImportResultInspection:
    return inspect_import_result(content, filename)


def normalize_bound_import_result(
    *,
    content: bytes,
    filename: str,
    mapping: ImportResultColumnMapping | dict[str, Any],
) -> list[NormalizedImportIssue]:
    return normalize_import_result(content, mapping, filename)


def suggest_bound_issue_matches(
    *,
    issue: NormalizedImportIssue,
    manifest: ExportManifestV1,
) -> MatchSuggestion:
    return suggest_issue_matches(issue, manifest)


def build_bound_retry_readiness(
    *,
    body: dict[str, Any],
    context_token: str,
) -> dict[str, Any]:
    preparation, report = _prepare_bound_retry(body=body, context_token=context_token)
    return {
        "status": report.status,
        "summary": {
            "fatal": 0,
            **report.summary.model_dump(mode="json"),
        },
        "issues": [issue.model_dump(mode="json") for issue in report.issues],
        "examples": _patch_examples(body, preparation),
        "selected_document_group_count": len(preparation.selected_document_group_ids),
        "selected_row_count": len(preparation.rows),
    }


def export_bound_retry_workbook(
    *,
    body: dict[str, Any],
    context_token: str,
) -> tuple[bytes, str]:
    preparation, report = _prepare_bound_retry(body=body, context_token=context_token)
    if report.summary.blocker > 0:
        raise RetryBlockedError("deterministic readiness blocker prevents retry export")
    if report.summary.warning > 0 and not bool(body.get("acknowledge_warnings")):
        raise RetryBlockedError("readiness warning acknowledgement is required")
    manifest = ExportManifestV1.model_validate(body.get("manifest"))
    content = export_retry_workbook(preparation, manifest=manifest)
    return content, "MISA retry.xls"


def _prepare_bound_retry(
    *,
    body: dict[str, Any],
    context_token: str,
) -> tuple[RetryPreparation, Any]:
    manifest = ExportManifestV1.model_validate(body.get("manifest"))
    selected = body.get("selected_document_group_ids")
    confirmed = body.get("confirmed_failed_group_ids")
    patches = body.get("patches")
    if not isinstance(selected, list) or not isinstance(confirmed, list) or not isinstance(patches, list):
        raise RetryBlockedError("retry payload is incomplete")
    if str(body.get("conversion_run_id") or "") != manifest.conversion_id:
        raise RetryBlockedError("manifest conversion binding mismatch")
    if str(body.get("profile_id") or "") != manifest.mapping_profile_id:
        raise RetryBlockedError("manifest profile binding mismatch")
    if str(body.get("target_template_id") or "") != manifest.target_template_id:
        raise RetryBlockedError("manifest template binding mismatch")

    try:
        resolved = _resolve_confirmed_export(
            upload_id=str(body.get("upload_id") or ""),
            profile_id=manifest.mapping_profile_id,
            edited_rows=None,
            acknowledge_warnings=True,
            conversion_context_token=context_token,
            session_id=str(body.get("session_id") or "") or None,
            revision=body.get("revision"),
            state_hash=body.get("state_hash"),
            requested_profile_version=manifest.mapping_profile_version,
            requested_profile_state_hash=manifest.mapping_profile_state_hash,
            vat_basis=body.get("vat_basis"),
        )
    except ReadinessGateError as exc:
        raise RetryBlockedError("original session readiness binding is not exportable") from exc

    rebuilt = build_export_manifest(
        conversion_id=manifest.conversion_id,
        export_batch_id=manifest.export_batch_id,
        target_template_id=manifest.target_template_id,
        template_hash=manifest.template_hash,
        raw_file_hash=manifest.raw_file_hash,
        mapping_profile_id=manifest.mapping_profile_id,
        mapping_profile_version=manifest.mapping_profile_version,
        mapping_profile_state_hash=manifest.mapping_profile_state_hash,
        validation_ruleset_version=manifest.validation_ruleset_version,
        output_rows=resolved.rows,
        row_origins=resolved.row_origins,
        misa_version=manifest.misa_version,
    )
    if rebuilt.model_dump(mode="json") != manifest.model_dump(mode="json"):
        raise RetryBlockedError("resolved session rows do not match trusted manifest")

    preparation = prepare_retry(
        manifest=manifest,
        selected_document_group_ids=[str(value) for value in selected],
        confirmed_failed_group_ids={str(value) for value in confirmed},
        document_group_statuses=(
            body.get("document_group_statuses")
            if isinstance(body.get("document_group_statuses"), dict)
            else None
        ),
        patches=patches,
        source_rows=resolved.rows,
        row_origins=resolved.row_origins,
        template_headers=resolved.template.headers,
    )
    report = build_readiness_report(
        resolved.table,
        manifest.target_template_id,
        {},
        {},
        {},
        edited_rows=preparation.rows,
        vat_basis=body.get("vat_basis"),
    )
    return preparation, report


def _patch_examples(
    body: dict[str, Any],
    preparation: RetryPreparation,
) -> list[dict[str, Any]]:
    examples: list[dict[str, Any]] = []
    row_by_number = dict(zip(preparation.selected_output_row_numbers, preparation.rows, strict=True))
    before_by_number = dict(
        zip(preparation.selected_output_row_numbers, preparation.before_rows, strict=True)
    )
    for patch in body.get("patches") or []:
        if not isinstance(patch, dict):
            continue
        number = patch.get("output_row_number")
        field = str(patch.get("field") or "")
        if isinstance(number, int) and number in row_by_number and field:
            examples.append(
                {
                    "document_group_id": str(patch.get("document_group_id") or ""),
                    "output_row_number": number,
                    "field": field,
                    "before": before_by_number[number].get(field),
                    "after": row_by_number[number].get(field),
                }
            )
        if len(examples) >= 20:
            break
    return examples
