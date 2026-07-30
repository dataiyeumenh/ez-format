from __future__ import annotations

import json
import os
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
from app.master_data_client import (
    ConversionContextError,
    fetch_master_data_context,
    verify_conversion_context_token,
)
from app.master_data_resolver import resolve_master_data
from app.mapping_profile_client import (
    MappingProfileClientError,
    find_mapping_profile,
    get_mapping_profile,
    mark_mapping_profile_used,
    save_mapping_profile,
)
from app.misa_readiness import add_master_data_resolutions, build_readiness_report
from app.misa_profiles import ProfileStore, local_mapping_owner_scope
from app.misa_templates import get_misa_template, list_misa_templates
from app.models import MisaReadinessReport
from app.normalization import normalize_header
from app.student_context import StudentContextClaims, verify_student_context
from app.student_store import (
    assert_upload_owner,
    bind_upload_to_student,
    student_upload_is_bound,
    student_upload_retention_seconds,
)


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


def save_upload(
    filename: str,
    content: bytes,
    *,
    student_claims: StudentContextClaims | None = None,
    student_ttl_seconds: int | None = None,
) -> tuple[str, Path]:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".xls", ".xlsx"}:
        raise ValueError("Only .xls and .xlsx files are supported.")
    upload_id = str(uuid.uuid4())
    directory = _upload_dir(upload_id)
    directory.mkdir(parents=True, exist_ok=True)
    if student_claims is not None:
        if student_ttl_seconds is None:
            raise ValueError("Student upload TTL là bắt buộc")
        bind_upload_to_student(upload_id, student_claims, student_ttl_seconds)
    input_path = directory / f"input{suffix}"
    input_path.write_bytes(content)
    persisted_filename = f"student-workbook{suffix}" if student_claims else filename
    metadata = {
        "upload_id": upload_id,
        "filename": persisted_filename,
        "input_path": str(input_path),
    }
    _write_metadata(upload_id, metadata)
    return upload_id, input_path


def analyze_upload(
    *,
    filename: str,
    content: bytes,
    requested_target_template_id: str | None = None,
    conversion_context_token: str | None = None,
    student_context_token: str | None = None,
) -> dict[str, Any]:
    if student_context_token and conversion_context_token:
        raise ValueError("Không thể dùng student context và conversion context đồng thời")
    student_claims = _verify_student_token(student_context_token, "analyze")
    student_ttl = student_upload_retention_seconds() if student_claims else None
    upload_id, input_path = save_upload(
        filename,
        content,
        student_claims=student_claims,
        student_ttl_seconds=student_ttl,
    )
    table = read_input_table(input_path)
    target_template_id = detect_target_template_id(table, requested_target_template_id)
    template = get_misa_template(target_template_id)
    signature = source_signature(table)
    context, context_status, context_message, context_claims = _context_for_analyze(
        conversion_context_token
    )
    workspace_id = str((context_claims or {}).get("workspace_id") or "")
    owner_scope = student_claims.owner_scope if student_claims else (
        f"workspace:{workspace_id}" if workspace_id else local_mapping_owner_scope()
    )
    profile_token = student_context_token or conversion_context_token
    store = ProfileStore()
    profile_warning: str | None = None
    if profile_token:
        try:
            profile = find_mapping_profile(
                profile_token,
                target_template_id=target_template_id,
                source_signature_hash=signature.hash,
            )
            if profile and profile.owner_scope != owner_scope:
                raise MappingProfileClientError(
                    "Backend trả về mapping profile sai owner scope"
                )
            if profile:
                try:
                    mark_mapping_profile_used(profile_token, profile.id)
                except MappingProfileClientError as exc:
                    profile_warning = f"Không cập nhật được lượt dùng mapping profile: {exc}"
        except MappingProfileClientError as exc:
            profile = None
            profile_warning = f"Không tải được mapping profile doanh nghiệp; dùng heuristic: {exc}"
    else:
        profile = store.find_by_signature(
            target_template_id=target_template_id,
            source_signature_hash=signature.hash,
            owner_scope=owner_scope,
        )
    if profile:
        if not profile_token:
            store.mark_used(profile.id, owner_scope=owner_scope)
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
    if profile_warning:
        suggestion.warnings.append(profile_warning)

    issues = validate_mapping(target_template_id, suggestion.mapping, template.headers)
    metadata = _read_metadata(upload_id)
    signature_payload = signature.__dict__.copy()
    if student_claims:
        signature_payload["sheet_name"] = "Sheet1"
    metadata.update(
        {
            "target_template_id": target_template_id,
            "signature": signature_payload,
            "suggestion": suggestion.model_dump(),
            "issues": issues,
            "conversion_context": (
                {
                    "workspace_id": workspace_id,
                    "snapshot_set_hash": context_claims.get("snapshot_set_hash"),
                }
                if context_claims
                else None
            ),
            "owner_scope": owner_scope,
        }
    )
    _write_metadata(upload_id, metadata)
    store.record_run(
        run_id=upload_id,
        upload_filename=str(metadata.get("filename") or "student-workbook"),
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
        "master_data": _master_data_payload(
            context,
            [],
            status=context_status,
            message=context_message,
        ),
    }


def preview_mapping(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    conversion_context_token: str | None = None,
    student_context_token: str | None = None,
) -> dict[str, Any]:
    _assert_student_upload_context(upload_id, student_context_token, "explain")
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
    context, context_status, context_message = _context_for_upload(
        upload_id, conversion_context_token
    )
    resolution = resolve_master_data(
        rows,
        context,
        source_system=_source_system_for_upload(upload_id),
    )
    return {
        "headers": template.headers,
        "rows": resolution.rows,
        "issues": issues,
        "stats": {
            "source_rows": len(table.rows),
            "output_rows": len(rows),
        },
        "master_data": _master_data_payload(
            context,
            resolution.resolutions,
            status=context_status,
            message=context_message,
        ),
    }


def readiness_mapping(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    edited_rows: list[dict[str, Any]] | None = None,
    conversion_context_token: str | None = None,
    student_context_token: str | None = None,
) -> dict[str, Any]:
    _assert_student_upload_context(upload_id, student_context_token, "explain")
    table = _read_upload_table(upload_id)
    template = get_misa_template(target_template_id)
    rows = edited_rows or apply_mapping(
        table,
        template.headers,
        mapping,
        sanitize_defaults_for_template(target_template_id, defaults, template.headers),
        formulas,
    )
    context, context_status, context_message = _context_for_upload(
        upload_id, conversion_context_token
    )
    resolution = resolve_master_data(
        rows,
        context,
        source_system=_source_system_for_upload(upload_id),
    )
    report = build_readiness_report(
        table,
        target_template_id,
        mapping,
        defaults or {},
        formulas or {},
        edited_rows=resolution.rows,
    )
    report = add_master_data_resolutions(
        report,
        resolution.resolutions,
        context_status=context_status,
        context_message=context_message,
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
    conversion_context_token: str | None = None,
    student_context_token: str | None = None,
) -> dict[str, Any]:
    _assert_student_upload_context(upload_id, student_context_token, "attempt")
    metadata = _read_metadata(upload_id)
    _context_for_upload(upload_id, conversion_context_token)
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
    previous = metadata.get("suggestion")
    template = get_misa_template(target_template_id)
    clean_defaults = sanitize_defaults_for_template(
        target_template_id,
        defaults,
        template.headers,
    )
    owner_scope = _owner_scope_from_upload_metadata(metadata)
    profile_token = student_context_token or conversion_context_token
    if profile_token:
        try:
            profile = save_mapping_profile(
                profile_token,
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
            )
        except MappingProfileClientError as exc:
            raise ValueError(str(exc)) from exc
    else:
        profile = ProfileStore().save_profile(
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
            owner_scope=owner_scope,
        )
    metadata["profile_id"] = profile.id
    metadata["confirmed"] = {
        "mapping": mapping,
        "defaults": clean_defaults,
        "formulas": formulas or {},
    }
    _write_metadata(upload_id, metadata)
    ProfileStore().record_run(
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
    conversion_context_token: str | None = None,
    student_context_token: str | None = None,
) -> tuple[bytes, str]:
    _assert_student_upload_context(upload_id, student_context_token, "export")
    table = _read_upload_table(upload_id)
    metadata = _read_metadata(upload_id)
    context, context_status, context_message = _context_for_upload(
        upload_id, conversion_context_token
    )
    owner_scope = _owner_scope_from_upload_metadata(metadata)
    profile_token = student_context_token or conversion_context_token
    if profile_token:
        try:
            profile = get_mapping_profile(profile_token, profile_id)
        except MappingProfileClientError as exc:
            raise ValueError(str(exc)) from exc
        if profile.owner_scope != owner_scope:
            raise ValueError("Mapping profile không thuộc hồ sơ doanh nghiệp đang xử lý")
    else:
        profile = ProfileStore().get_profile(profile_id, owner_scope=owner_scope)
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
    resolution = resolve_master_data(
        rows,
        context,
        source_system=_source_system_for_upload(upload_id),
    )
    rows = resolution.rows
    readiness = build_readiness_report(
        table,
        profile.target_template_id,
        clean_mapping,
        clean_defaults,
        profile.formulas,
        edited_rows=rows,
    )
    readiness = add_master_data_resolutions(
        readiness,
        resolution.resolutions,
        context_status=context_status,
        context_message=context_message,
    )
    if readiness.summary.blocker > 0:
        raise ReadinessGateError(readiness)
    if readiness.summary.warning > 0 and not acknowledge_warnings:
        raise ReadinessGateError(readiness)
    output_path = _upload_dir(upload_id) / "misa_export.xls"
    write_xls_from_template(template.workbook, rows, output_path)
    return output_path.read_bytes(), f"Import misa {upload_id[:8]}.xls"


def _context_for_analyze(
    token: str | None,
) -> tuple[dict[str, Any] | None, str, str | None, dict[str, Any] | None]:
    if not token:
        return None, "not_configured", None, None
    claims = verify_conversion_context_token(token)
    try:
        return fetch_master_data_context(token), "connected", None, claims
    except ConversionContextError as exc:
        if exc.status_code == 409:
            raise ValueError(str(exc)) from exc
        return None, "unavailable", str(exc), claims


def _owner_scope_from_upload_metadata(metadata: dict[str, Any]) -> str:
    owner_scope = str(metadata.get("owner_scope") or "").strip()
    if owner_scope:
        return owner_scope
    workspace_id = str(
        ((metadata.get("conversion_context") or {}).get("workspace_id") or "")
    ).strip()
    if workspace_id:
        return f"workspace:{workspace_id}"
    return local_mapping_owner_scope()


def _student_assistant_enabled() -> bool:
    return os.getenv("STUDENT_ASSISTANT_ENABLED", "false").lower() in {
        "1",
        "true",
        "yes",
    }


def _verify_student_token(
    token: str | None,
    required_scope: str,
) -> StudentContextClaims | None:
    if not token:
        return None
    if not _student_assistant_enabled():
        raise ValueError("Student assistant đang tắt")
    return verify_student_context(token, required_scope)


def _assert_student_upload_context(
    upload_id: str,
    token: str | None,
    required_scope: str,
) -> StudentContextClaims | None:
    is_bound = student_upload_is_bound(upload_id)
    if not is_bound:
        if token:
            _verify_student_token(token, required_scope)
            raise ValueError("Upload chưa được bind với student context")
        return None
    claims = _verify_student_token(token, required_scope)
    if claims is None:
        raise ValueError("Thiếu student context của upload")
    assert_upload_owner(upload_id, claims)
    return claims


def _context_for_upload(
    upload_id: str, token: str | None
) -> tuple[dict[str, Any] | None, str, str | None]:
    metadata = _read_metadata(upload_id)
    expected = metadata.get("conversion_context")
    if not expected:
        if token:
            raise ValueError("Conversion context không khớp với lần phân tích ban đầu")
        return None, "not_configured", None
    if not token:
        raise ValueError("Thiếu conversion context của hồ sơ doanh nghiệp")
    claims = verify_conversion_context_token(token)
    if (
        str(claims.get("workspace_id")) != str(expected.get("workspace_id"))
        or str(claims.get("snapshot_set_hash"))
        != str(expected.get("snapshot_set_hash"))
    ):
        raise ValueError("Conversion context không khớp với lần phân tích ban đầu")
    try:
        return fetch_master_data_context(token), "connected", None
    except ConversionContextError as exc:
        if exc.status_code == 409:
            raise ValueError(str(exc)) from exc
        return None, "unavailable", str(exc)


def _source_system_for_upload(upload_id: str) -> str:
    signature = (_read_metadata(upload_id).get("signature") or {})
    if isinstance(signature, dict):
        return str(signature.get("hash") or "default")
    return "default"


def _master_data_payload(
    context: dict[str, Any] | None,
    resolutions: list[Any],
    *,
    status: str,
    message: str | None,
) -> dict[str, Any]:
    return {
        "status": status,
        "message": message,
        "workspace": (context or {}).get("workspace"),
        "summary": {
            "verified": sum(1 for item in resolutions if item.status == "verified"),
            "suggested": sum(1 for item in resolutions if item.status == "suggested"),
            "missing": sum(1 for item in resolutions if item.status == "missing"),
            "conflict": sum(1 for item in resolutions if item.status == "conflict"),
            "not_checked": sum(1 for item in resolutions if item.status == "not_checked"),
        },
        "resolutions": [item.to_dict() for item in resolutions],
    }


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
