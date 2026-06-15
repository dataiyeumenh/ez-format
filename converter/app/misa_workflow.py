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
from app.misa_profiles import ProfileStore
from app.misa_readiness import validate_misa_readiness
from app.misa_templates import get_misa_template, list_misa_templates
from app.models import MisaReadinessReport, VatPolicy
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


def validate_current_mapping(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    accounting_regime: str | None = None,
    fiscal_year_start: str | None = None,
    vat_policy: VatPolicy | dict[str, Any] | None = None,
) -> MisaReadinessReport:
    table = _read_upload_table(upload_id)
    template = get_misa_template(target_template_id)
    clean_mapping = sanitize_mapping_for_template(target_template_id, mapping)
    clean_defaults = sanitize_defaults_for_template(target_template_id, defaults, template.headers)
    rows = apply_mapping(table, template.headers, clean_mapping, clean_defaults, formulas)
    return validate_misa_readiness(
        input_rows=len(table.rows),
        target_template_id=target_template_id,
        target_headers=template.headers,
        mapping=clean_mapping,
        defaults=clean_defaults,
        formulas=formulas or {},
        output_rows=rows,
        source_headers=table.headers,
        hidden_rows=table.hidden_rows,
        formula_cells=table.formula_cells,
        blank_rows_ignored=table.blank_rows_ignored,
        accounting_regime=accounting_regime,
        fiscal_year_start=fiscal_year_start,
        vat_policy=vat_policy,
    )


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


def validate_confirmed_profile(
    upload_id: str,
    profile_id: str,
    *,
    accounting_regime: str | None = None,
    fiscal_year_start: str | None = None,
    vat_policy: VatPolicy | dict[str, Any] | None = None,
) -> MisaReadinessReport:
    profile = ProfileStore().get_profile(profile_id)
    return validate_current_mapping(
        upload_id=upload_id,
        target_template_id=profile.target_template_id,
        mapping=profile.mapping,
        defaults=profile.defaults,
        formulas=profile.formulas,
        accounting_regime=accounting_regime,
        fiscal_year_start=fiscal_year_start,
        vat_policy=vat_policy,
    )


def export_confirmed_profile(upload_id: str, profile_id: str) -> tuple[bytes, str]:
    table = _read_upload_table(upload_id)
    profile = ProfileStore().get_profile(profile_id)
    template = get_misa_template(profile.target_template_id)
    rows = apply_mapping(
        table,
        template.headers,
        sanitize_mapping_for_template(profile.target_template_id, profile.mapping),
        sanitize_defaults_for_template(profile.target_template_id, profile.defaults, template.headers),
        profile.formulas,
    )
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
