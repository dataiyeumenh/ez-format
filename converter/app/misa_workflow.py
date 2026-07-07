from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from app.ai_mapping_client import (
    AiMappingError,
    ai_enabled,
    ai_required,
    request_mapping_suggestion,
)
from app.conversion_types import BACKEND_ROOT
from app.excel_io import InputTable, read_input_table, write_xls_from_template
from app.misa_mapping import (
    BSN_SALES_DIRECT_MAPPING,
    MappingSuggestion,
    SourceSignature,
    ai_suggestion_payload,
    apply_mapping,
    detect_target_template_id,
    heuristic_suggestion,
    normalize_ai_suggestion,
    profile_suggestion,
    sanitize_defaults_for_template,
    sanitize_mapping_for_template,
    source_signature,
    validate_mapping,
)
from app.misa_readiness import build_readiness_report
from app.misa_profiles import ProfileStore
from app.misa_templates import get_misa_template, list_misa_templates
from app.models import MisaReadinessReport
from app.normalization import normalize_header


UPLOAD_ROOT = BACKEND_ROOT / ".artifacts" / "uploads"
EXPORT_MEDIA_TYPE = "application/vnd.ms-excel"
DETERMINISTIC_BSN_SALES_RAW_HEADERS = (
    "Mã hóa đơn",
    "Thời gian",
    "Tên khách hàng",
    "Mã hàng",
    "Số lượng",
    "Đơn giá",
)


class ReadinessGateError(ValueError):
    def __init__(self, report: MisaReadinessReport) -> None:
        self.report = report
        super().__init__("MISA readiness gate failed")


def templates_payload() -> dict[str, Any]:
    return {
        "items": [
            {
                "id": template.id,
                "label": template.label,
                "filename": template.filename,
                "sheet_name": template.sheet_name,
                "header_row": template.header_row,
                "data_start_row": template.data_start_row,
                "headers": template.headers,
            }
            for template in list_misa_templates()
        ]
    }


def save_upload(filename: str, content: bytes) -> tuple[str, Path]:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".xls", ".xlsx"}:
        raise ValueError("Only .xls and .xlsx files are supported.")
    upload_id = str(uuid.uuid4())
    directory = _upload_dir(upload_id)
    directory.mkdir(parents=True, exist_ok=True)
    input_path = directory / f"input{suffix}"
    input_path.write_bytes(content)
    metadata = {"upload_id": upload_id, "filename": filename, "input_path": str(input_path)}
    _write_metadata(upload_id, metadata)
    return upload_id, input_path


def analyze_upload(
    *,
    filename: str,
    content: bytes,
    requested_target_template_id: str | None = None,
) -> dict[str, Any]:
    upload_id, input_path = save_upload(filename, content)
    table = read_input_table(input_path)
    target_template_id = detect_target_template_id(table, requested_target_template_id)
    template = get_misa_template(target_template_id)
    signature = source_signature(table)
    store = ProfileStore()

    profile = store.find_by_signature(
        target_template_id=target_template_id,
        source_signature_hash=signature.hash,
    )
    if profile:
        store.mark_used(profile.id)
        suggestion = profile_suggestion(profile)
        profile_issues = validate_mapping(target_template_id, suggestion.mapping, template.headers)
        if _has_missing_required_mapping(profile_issues):
            suggestion = _repair_profile_suggestion_with_heuristic(
                table=table,
                target_template_id=target_template_id,
                template_headers=template.headers,
                suggestion=suggestion,
            )
    else:
        suggestion = heuristic_suggestion(table, target_template_id, template.headers)
        heuristic_issues = validate_mapping(target_template_id, suggestion.mapping, template.headers)
        if ai_enabled() and _should_request_ai_mapping(
            table=table,
            target_template_id=target_template_id,
            suggestion=suggestion,
            issues=heuristic_issues,
        ):
            try:
                ai_payload = request_mapping_suggestion(
                    ai_suggestion_payload(table, target_template_id, template.headers)
                )
                suggestion = normalize_ai_suggestion(
                    ai_payload,
                    suggestion,
                    target_template_id=target_template_id,
                    target_headers=template.headers,
                )
            except AiMappingError as exc:
                if ai_required():
                    raise
                suggestion.warnings.append(f"AI Gateway unavailable, dùng heuristic: {exc}")

    issues = validate_mapping(target_template_id, suggestion.mapping, template.headers)
    metadata = _read_metadata(upload_id)
    metadata.update(
        {
            "target_template_id": target_template_id,
            "signature": signature.__dict__,
            "suggestion": suggestion.model_dump(),
            "issues": issues,
        }
    )
    _write_metadata(upload_id, metadata)
    store.record_run(
        run_id=upload_id,
        upload_filename=filename,
        target_template_id=target_template_id,
        profile_id=suggestion.profile_id,
        mapping_source=suggestion.source,
        status="analyzed",
        issues=issues,
    )
    return {
        "upload_id": upload_id,
        "detected": {
            "sheet_name": signature.sheet_name,
            "header_row": signature.header_row,
            "row_count": signature.row_count,
            "source_signature_hash": signature.hash,
            "headers": signature.headers,
        },
        "target_template_id": target_template_id,
        "target_headers": template.headers,
        "mapping_suggestion": suggestion.model_dump(),
        "issues": issues,
    }


def preview_mapping(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
) -> dict[str, Any]:
    table = _read_upload_table(upload_id)
    template = get_misa_template(target_template_id)
    issues = validate_mapping(target_template_id, mapping, template.headers)
    rows = apply_mapping(
        table,
        template.headers,
        mapping,
        sanitize_defaults_for_template(target_template_id, defaults, template.headers),
        formulas,
    )
    return {
        "headers": template.headers,
        "rows": rows,
        "issues": issues,
        "stats": {
            "source_rows": len(table.rows),
            "output_rows": len(rows),
        },
    }


def readiness_mapping(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    edited_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    table = _read_upload_table(upload_id)
    report = build_readiness_report(
        table,
        target_template_id,
        mapping,
        defaults or {},
        formulas or {},
        edited_rows=edited_rows,
    )
    return report.model_dump(mode="json")


def confirm_mapping(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    profile_name: str | None = None,
) -> dict[str, Any]:
    metadata = _read_metadata(upload_id)
    signature_payload = metadata.get("signature")
    if isinstance(signature_payload, dict):
        signature = SourceSignature(
            sheet_name=str(signature_payload.get("sheet_name") or ""),
            header_row=int(signature_payload.get("header_row") or 1),
            row_count=int(signature_payload.get("row_count") or 0),
            headers=[str(header) for header in signature_payload.get("headers") or []],
            hash=str(signature_payload.get("hash") or ""),
        )
    else:
        signature = source_signature(_read_upload_table(upload_id))
    store = ProfileStore()
    previous = metadata.get("suggestion")
    template = get_misa_template(target_template_id)
    clean_defaults = sanitize_defaults_for_template(
        target_template_id,
        defaults,
        template.headers,
    )
    profile = store.save_profile(
        name=profile_name or f"{target_template_id} profile",
        target_template_id=target_template_id,
        source_signature_hash=signature.hash,
        source_headers=signature.headers,
        sheet_name=signature.sheet_name,
        header_row=signature.header_row,
        mapping=mapping,
        defaults=clean_defaults,
        formulas=formulas or {},
        confidence=1.0,
        previous=previous,
    )
    metadata["profile_id"] = profile.id
    metadata["confirmed"] = {
        "mapping": mapping,
        "defaults": clean_defaults,
        "formulas": formulas or {},
    }
    _write_metadata(upload_id, metadata)
    store.record_run(
        run_id=upload_id,
        upload_filename=metadata.get("filename", ""),
        target_template_id=target_template_id,
        profile_id=profile.id,
        mapping_source="confirmed",
        status="confirmed",
        issues=[],
    )
    return {"profile_id": profile.id, "saved": True}


def export_confirmed_profile(
    upload_id: str,
    profile_id: str,
    edited_rows: list[dict[str, Any]] | None = None,
    acknowledge_warnings: bool = False,
) -> tuple[bytes, str]:
    table = _read_upload_table(upload_id)
    profile = ProfileStore().get_profile(profile_id)
    template = get_misa_template(profile.target_template_id)
    clean_mapping = sanitize_mapping_for_template(profile.target_template_id, profile.mapping)
    clean_defaults = sanitize_defaults_for_template(
        profile.target_template_id,
        profile.defaults,
        template.headers,
    )
    if edited_rows:
        rows = edited_rows
    else:
        rows = apply_mapping(
            table,
            template.headers,
            clean_mapping,
            clean_defaults,
            profile.formulas,
        )
    readiness = build_readiness_report(
        table,
        profile.target_template_id,
        clean_mapping,
        clean_defaults,
        profile.formulas,
        edited_rows=rows,
    )
    if readiness.summary.blocker > 0:
        raise ReadinessGateError(readiness)
    if readiness.summary.warning > 0 and not acknowledge_warnings:
        raise ReadinessGateError(readiness)
    output_path = _upload_dir(upload_id) / "misa_export.xls"
    write_xls_from_template(template.workbook, rows, output_path)
    return output_path.read_bytes(), f"Import misa {upload_id[:8]}.xls"


def purge_uploads() -> None:
    shutil.rmtree(UPLOAD_ROOT, ignore_errors=True)


def _should_request_ai_mapping(
    *,
    table: InputTable,
    target_template_id: str,
    suggestion: Any,
    issues: list[dict[str, str]],
) -> bool:
    import os

    if os.getenv("AI_ALWAYS_SUGGEST", "false").lower() in {"1", "true", "yes"}:
        return True
    if issues or suggestion.warnings:
        return True
    return not _is_known_deterministic_schema(table, target_template_id, suggestion)


def _has_missing_required_mapping(issues: list[dict[str, str]]) -> bool:
    return any(issue.get("code") == "missing_required_mapping" for issue in issues)


def _repair_profile_suggestion_with_heuristic(
    *,
    table: InputTable,
    target_template_id: str,
    template_headers: list[str],
    suggestion: MappingSuggestion,
) -> MappingSuggestion:
    heuristic = heuristic_suggestion(table, target_template_id, template_headers)
    mapped_targets = _mapped_targets_for_workflow(suggestion.mapping)
    repaired_mapping = dict(suggestion.mapping)
    repaired_defaults = {**heuristic.defaults, **suggestion.defaults}
    repaired_formulas = {**heuristic.formulas, **suggestion.formulas}

    for raw_header, target_spec in heuristic.mapping.items():
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        missing_targets = [target for target in targets if str(target) not in mapped_targets]
        if not missing_targets:
            continue
        repaired_mapping[raw_header] = missing_targets[0] if len(missing_targets) == 1 else missing_targets
        mapped_targets.update(str(target) for target in missing_targets)

    return MappingSuggestion(
        source="mixed",
        confidence=min(1.0, max(suggestion.confidence, heuristic.confidence)),
        mapping=repaired_mapping,
        defaults=repaired_defaults,
        formulas=repaired_formulas,
        warnings=[
            *suggestion.warnings,
            "Profile đã lưu thiếu cột bắt buộc; hệ thống đã tự bổ sung bằng heuristic, vui lòng rà soát lại.",
        ],
        profile_id=suggestion.profile_id,
    )


def _mapped_targets_for_workflow(mapping: dict[str, Any]) -> set[str]:
    targets: set[str] = set()
    for target_spec in mapping.values():
        if isinstance(target_spec, list):
            targets.update(str(target) for target in target_spec)
        elif target_spec:
            targets.add(str(target_spec))
    return targets


def _is_known_deterministic_schema(
    table: InputTable,
    target_template_id: str,
    suggestion: Any,
) -> bool:
    if target_template_id != "bsn_sales" or suggestion.source != "heuristic":
        return False

    normalized_counts: dict[str, int] = {}
    resolved_headers: dict[str, str] = {}
    for header in table.headers:
        normalized = normalize_header(header)
        if not normalized:
            continue
        normalized_counts[normalized] = normalized_counts.get(normalized, 0) + 1
        resolved_headers.setdefault(normalized, header)

    for raw_header in DETERMINISTIC_BSN_SALES_RAW_HEADERS:
        normalized = normalize_header(raw_header)
        if normalized_counts.get(normalized) != 1:
            return False
        resolved = resolved_headers[normalized]
        expected_target = BSN_SALES_DIRECT_MAPPING[raw_header]
        if suggestion.mapping.get(resolved) != expected_target:
            return False

    return True


def _read_upload_table(upload_id: str) -> InputTable:
    metadata = _read_metadata(upload_id)
    return read_input_table(Path(metadata["input_path"]))


def _upload_dir(upload_id: str) -> Path:
    return UPLOAD_ROOT / upload_id


def _metadata_path(upload_id: str) -> Path:
    return _upload_dir(upload_id) / "metadata.json"


def _read_metadata(upload_id: str) -> dict[str, Any]:
    path = _metadata_path(upload_id)
    if not path.exists():
        raise KeyError(f"Upload not found: {upload_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_metadata(upload_id: str, metadata: dict[str, Any]) -> None:
    path = _metadata_path(upload_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
