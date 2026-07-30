from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from app import ai_mapping_client
from app.ai_mapping_client import (
    AiMappingError,
    ai_enabled,
    ai_required,
    request_mapping_suggestion,
)
from app.conversion_types import BACKEND_ROOT
from app.excel_io import InputTable, read_input_table, write_xls_from_template
from app.export_manifest import build_export_manifest
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
    conversion_context_owner_scope,
    fetch_master_data_context,
    verify_conversion_context_token,
)
from app.master_data_resolver import resolve_master_data
from app.mapping_profile_client import (
    MappingProfileClientError,
    find_mapping_profile,
    get_mapping_profile,
    mark_mapping_profile_used,
    quarantine_mapping_profile,
    save_mapping_profile,
)
from app.mapping_profile_v2 import (
    MappingProfileV2Error,
    MappingProfileV2UnavailableError,
    build_profile_identity,
    confirm_mapping_profile_v2,
    get_mapping_profile_v2,
    mapping_profile_v2_enabled,
    match_mapping_profile_v2,
    quarantine_mapping_profile_v2,
    record_confirmed_export_v2,
    template_version,
)
from app.mapping_semantics import validate_mapping_semantics
from app.misa_readiness import add_master_data_resolutions, build_readiness_report
from app.misa_profiles import ProfileStore, local_mapping_owner_scope
from app.misa_templates import get_misa_template, list_misa_templates
from app.models import ExportManifestV1, MisaReadinessReport
from app.normalization import normalize_header
from app.operation_store import (
    OperationStore,
    OperationStoreConflictError,
    OperationStoreError,
    operation_context_required,
    STUDENT_METADATA_STATE_CONTRACT,
    unauthenticated_local_operations_enabled,
)
from app.student_context import StudentContextClaims, verify_student_context
from app.student_store import (
    assert_upload_owner,
    bind_upload_to_student,
    student_upload_is_bound,
    student_upload_retention_seconds,
)


UPLOAD_ROOT = BACKEND_ROOT / ".artifacts" / "uploads"
_UPLOAD_CACHE_LOCK = threading.RLock()
EXPORT_MEDIA_TYPE = "application/vnd.ms-excel"
UPLOAD_METADATA_CONTEXT_KEY = "upload_metadata"
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


@dataclass(frozen=True)
class _ResolvedConfirmedExport:
    table: InputTable
    metadata: dict[str, Any]
    owner_scope: str
    profile_token: str | None
    profile_kind: str
    profile_version: int
    profile_v2: Any
    template: Any
    rows: list[dict[str, Any]]
    row_origins: list[dict[str, Any]]


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
    preallocated_upload_id: str | None = None,
    student_claims: StudentContextClaims | None = None,
    student_ttl_seconds: int | None = None,
) -> tuple[str, Path]:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".xls", ".xlsx"}:
        raise ValueError("Only .xls and .xlsx files are supported.")
    supplied_upload_id = str(preallocated_upload_id or "").strip()
    if supplied_upload_id:
        try:
            upload_id = str(uuid.UUID(supplied_upload_id))
        except ValueError as exc:
            raise ValueError("Preallocated upload id không hợp lệ") from exc
    else:
        upload_id = str(uuid.uuid4())
    now = int(time.time())
    directory = _upload_dir(upload_id)
    with _UPLOAD_CACHE_LOCK:
        directory.mkdir(parents=True, exist_ok=False)
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
            "raw_sha256": hashlib.sha256(content).hexdigest(),
            "created_at": now,
            "expires_at": now + _upload_cache_ttl_seconds(),
        }
        _write_metadata(upload_id, metadata)
    return upload_id, input_path


def analyze_upload(
    *,
    filename: str,
    content: bytes,
    requested_target_template_id: str | None = None,
    conversion_context_token: str | None = None,
    operation_context_token: str | None = None,
    operation_session_id: str | None = None,
    conversion_run_id: str | None = None,
    preallocated_upload_id: str | None = None,
    student_context_token: str | None = None,
    use_ai: bool = False,
    ai_mapping_opt_in: bool = False,
) -> dict[str, Any]:
    if operation_context_required() and not str(operation_session_id or "").strip():
        raise OperationStoreError(
            "Production conversion requires a preallocated operation_session_id"
        )
    if operation_context_token and conversion_context_token:
        raise ValueError("Chỉ được dùng một conversion operation context")
    if student_context_token and conversion_context_token:
        raise ValueError("Không thể dùng student context và conversion context đồng thời")
    student_claims = _verify_student_token(student_context_token, "analyze")
    operation_claims = (
        verify_conversion_context_token(operation_context_token)
        if operation_context_token
        else None
    )
    if student_claims and operation_claims:
        expected_binding = {
            "operation_session_id": student_claims.session_id,
            "user_id": student_claims.user_id,
            "owner_scope": student_claims.owner_scope,
            "workspace_id": str(student_claims.workspace_id or ""),
        }
        if any(
            str(operation_claims.get(key) or "") != str(expected)
            for key, expected in expected_binding.items()
        ) or "analyze" not in (operation_claims.get("scopes") or []):
            raise ValueError("Student operation context không khớp phiên hỗ trợ")
    student_ttl = student_upload_retention_seconds() if student_claims else None
    upload_id, input_path = save_upload(
        filename,
        content,
        preallocated_upload_id=preallocated_upload_id,
        student_claims=student_claims,
        student_ttl_seconds=student_ttl,
    )
    table = read_input_table(input_path)
    purchase_adjustments: list[dict[str, Any]] = []
    target_template_id = detect_target_template_id(table, requested_target_template_id)
    template = get_misa_template(target_template_id)
    signature = source_signature(table)
    context, context_status, context_message, context_claims = _context_for_analyze(
        conversion_context_token
    )
    trusted_session_id, trusted_run_id = _trusted_preallocated_session_binding(
        operation_claims or context_claims,
        operation_session_id=operation_session_id,
        conversion_run_id=conversion_run_id,
    )
    workspace_id = str(
        (student_claims.workspace_id if student_claims else None)
        or (context_claims or {}).get("workspace_id")
        or ""
    )
    owner_scope = (
        student_claims.owner_scope
        if student_claims
        else (
            conversion_context_owner_scope(context_claims)
            if context_claims
            else local_mapping_owner_scope()
        )
    )
    profile_token = student_context_token or conversion_context_token
    store = ProfileStore()
    profile_warning: str | None = None
    profile = None
    v2_profile = None
    v2_match = None
    v2_match_tier: str | None = None
    resolved_template_version = template_version(template.workbook.path)
    if profile_token and mapping_profile_v2_enabled():
        try:
            v2_match = match_mapping_profile_v2(
                profile_token,
                build_profile_identity(
                    table,
                    target_template_id=target_template_id,
                    target_template_version=resolved_template_version,
                ),
            )
            if v2_match is not None:
                v2_match_tier = v2_match.match_tier
                candidate = v2_match.profile
                if candidate.owner_scope != owner_scope:
                    raise MappingProfileV2Error(
                        "Backend trả về mapping profile V2 sai owner scope"
                    )
                if (
                    v2_match.match_tier == "exact"
                    and candidate.status == "active"
                    and v2_match.can_suggest
                ):
                    v2_profile = candidate
                else:
                    profile_warning = (
                        "Mapping Profile V2 chưa được áp dụng do schema drift hoặc "
                        "thiếu phê duyệt rõ ràng."
                    )
        except MappingProfileV2Error as exc:
            profile_warning = f"Mapping Profile V2 không khả dụng; dùng V1/heuristic: {exc}"
    if profile_token and v2_profile is None and v2_match_tier is None:
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
        except MappingProfileClientError as exc:
            profile = None
            profile_warning = f"Không tải được mapping profile doanh nghiệp; dùng heuristic: {exc}"
    elif not profile_token:
        profile = store.find_by_signature(
            target_template_id=target_template_id,
            source_signature_hash=signature.hash,
            owner_scope=owner_scope,
        )
    ai_state: dict[str, str] | None = None
    nearby_ai_profiles = (
        [
            {
                "target_template_id": v2_match.profile.target_template_id,
                "source_headers": list(v2_match.profile.mapping),
                "confidence": v2_match.profile.confidence,
            }
        ]
        if v2_match is not None
        else []
    )
    if v2_profile:
        suggestion = MappingSuggestion(
            source="profile_v2",
            confidence=v2_profile.confidence,
            mapping=v2_profile.mapping,
            defaults=v2_profile.defaults,
            formulas=v2_profile.formulas,
            warnings=list(v2_match.warnings if v2_match is not None else ()),
            profile_id=v2_profile.id,
        )
    elif profile:
        suggestion = profile_suggestion(profile)
    else:
        suggestion = heuristic_suggestion(table, target_template_id, template.headers)
        heuristic_issues = validate_mapping(
            target_template_id,
            suggestion.mapping,
            template.headers,
            suggestion.defaults,
            suggestion.formulas,
        )
        effective_ai_mapping_opt_in = bool(
            ai_mapping_opt_in
            or (context_claims or {}).get("ai_mapping_opt_in")
            or (not context_claims and unauthenticated_local_operations_enabled())
        )
        suggestion, ai_state = apply_optional_ai_mapping(
            table=table,
            target_template_id=target_template_id,
            template_headers=template.headers,
            fallback=suggestion,
            issues=heuristic_issues,
            use_ai=use_ai,
            ai_mapping_opt_in=effective_ai_mapping_opt_in,
            nearby_profiles=nearby_ai_profiles,
        )
    semantic_issues = validate_mapping_semantics(
        target_template_id=target_template_id,
        template_headers=template.headers,
        source_headers=table.headers,
        mapping=suggestion.mapping,
        defaults=suggestion.defaults,
        formulas=suggestion.formulas,
        sample_rows=table.rows[:20],
    )
    if suggestion.source in {"profile", "profile_v2"} and any(
        issue.severity == "blocker" for issue in semantic_issues
    ):
        rejected_profile_id = suggestion.profile_id or "unknown"
        rejection_codes = sorted(
            {
                issue.code
                for issue in semantic_issues
                if issue.severity == "blocker"
            }
        )
        rejection_reason = "semantic_validation_failed:" + ",".join(rejection_codes)
        try:
            if profile_token and suggestion.source == "profile_v2":
                quarantine_mapping_profile_v2(
                    profile_token,
                    profile_id=rejected_profile_id,
                    reason=rejection_reason,
                )
            elif profile_token and suggestion.source == "profile":
                quarantine_mapping_profile(
                    profile_token,
                    rejected_profile_id,
                    rejection_reason,
                )
            elif not profile_token and suggestion.source == "profile":
                store.quarantine_profile(
                    rejected_profile_id,
                    reason=rejection_reason,
                    owner_scope=owner_scope,
                )
        except (KeyError, MappingProfileClientError, MappingProfileV2Error):
            pass
        profile_warning = (
            f"Mapping profile {rejected_profile_id} bị loại vì không an toàn về ngữ nghĩa; "
            "đã chuyển sang heuristic để người dùng kiểm tra lại."
        )
        profile = None
        v2_profile = None
        suggestion = heuristic_suggestion(table, target_template_id, template.headers)
        semantic_issues = validate_mapping_semantics(
            target_template_id=target_template_id,
            template_headers=template.headers,
            source_headers=table.headers,
            mapping=suggestion.mapping,
            defaults=suggestion.defaults,
            formulas=suggestion.formulas,
            sample_rows=table.rows[:20],
        )
    if profile_warning:
        suggestion.warnings.append(profile_warning)
    if purchase_adjustments:
        suggestion.warnings.append(
            f"Phát hiện {len(purchase_adjustments)} hóa đơn có ngữ cảnh điều chỉnh; "
            "cần kiểm tra chứng từ gốc/tham chiếu trước khi xác nhận mapping."
        )

    issues = validate_mapping(
        target_template_id,
        suggestion.mapping,
        template.headers,
        suggestion.defaults,
        suggestion.formulas,
    )
    issues.extend(issue.model_dump(mode="json") for issue in semantic_issues)
    metadata = _read_metadata(upload_id)
    metadata.update(
        {
            "target_template_id": target_template_id,
            "signature": signature.__dict__,
            "suggestion": suggestion.model_dump(),
            "issues": issues,
            "review_context": {
                "purchase_adjustments": purchase_adjustments,
            },
            "conversion_context": (
                {
                    "user_id": context_claims.get("user_id"),
                    "owner_scope": owner_scope,
                    "workspace_id": workspace_id,
                    "snapshot_set_hash": context_claims.get("snapshot_set_hash"),
                    "conversion_run_id": context_claims.get("conversion_run_id"),
                }
                if context_claims
                else None
            ),
            "owner_scope": owner_scope,
            "conversion_run_id": str(
                (context_claims or {}).get("conversion_run_id") or ""
            )
            or None,
            "operation_session_id": trusted_session_id,
            "mapping_profile_kind": (
                "v2" if v2_profile else ("v1" if profile else None)
            ),
            "mapping_profile_version": v2_profile.version if v2_profile else None,
            "profile_state_hash": v2_profile.state_hash if v2_profile else None,
            "mapping_profile_v2_candidate": (
                {
                    "profile_id": v2_profile.id,
                    "version": v2_profile.version,
                    "state_hash": v2_profile.state_hash,
                    "source_signature_hash": v2_profile.header_fingerprint,
                }
                if v2_profile
                else None
            ),
        }
    )
    session = None
    if student_claims or context_claims or unauthenticated_local_operations_enabled():
        operation_store = OperationStore(
            conversion_context_token=operation_context_token or conversion_context_token
        )
        session = operation_store.create_session(
            session_id=trusted_session_id,
            upload_id=upload_id,
            owner_scope=owner_scope,
            user_id=str(
                (
                    student_claims.user_id
                    if student_claims
                    else (context_claims or {}).get("user_id")
                )
                or ""
            )
            or None,
            workspace_id=workspace_id or None,
            target_template_id=target_template_id,
            target_template_version=resolved_template_version,
            source_signature=signature.__dict__,
            table=table,
            raw_sha256=hashlib.sha256(content).hexdigest(),
            conversion_run_id=trusted_run_id,
            ttl_seconds=(
                _student_operation_ttl_seconds(student_claims, student_ttl)
                if student_claims
                else None
            ),
            initial_context={
                "mapping": suggestion.mapping,
                "defaults": suggestion.defaults,
                "formulas": suggestion.formulas,
                UPLOAD_METADATA_CONTEXT_KEY: _portable_upload_metadata(metadata),
            },
            state_contract=(
                STUDENT_METADATA_STATE_CONTRACT if student_claims else None
            ),
        )
        metadata["operation_session_id"] = session.session_id
        if student_claims:
            metadata["operation_state_contract"] = STUDENT_METADATA_STATE_CONTRACT
        session_expires_at = int(session.expires_at.timestamp())
        metadata.update(
            {
                "raw_sha256": session.raw_sha256,
                "expires_at": session_expires_at,
                "operation_session_expires_at": session_expires_at,
            }
        )
        if not student_claims:
            operation_store.put_artifact(
                session.session_id,
                kind="upload",
                revision=1,
                content=content,
                content_type=_upload_content_type(filename),
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
        "ai": ai_state,
        "mapping_profile_v2": _mapping_profile_v2_payload(v2_match, suggestion.source),
        "issues": issues,
        "review_context": {
            "purchase_adjustments": purchase_adjustments,
        },
        "session": (
            {
                "session_id": session.session_id,
                "active_revision": session.active_revision,
                "state_hash": session.state_hash,
                "expires_at": session.expires_at.isoformat(),
            }
            if session
            else None
        ),
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
    session_id: str | None = None,
    revision: int | None = None,
    state_hash: str | None = None,
) -> dict[str, Any]:
    student_claims = _assert_student_upload_context(
        upload_id, student_context_token, "explain"
    )
    _assert_operation_state(
        upload_id,
        session_id,
        revision,
        state_hash,
        conversion_context_token=conversion_context_token,
        student_owner_scope=student_claims.owner_scope if student_claims else None,
        required_scope="preview",
    )
    table = _read_upload_table(upload_id, conversion_context_token=conversion_context_token)
    template = get_misa_template(target_template_id)
    issues = validate_mapping(
        target_template_id,
        mapping,
        template.headers,
        defaults,
        formulas,
    )
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
    session_id: str | None = None,
    revision: int | None = None,
    state_hash: str | None = None,
) -> dict[str, Any]:
    student_claims = _assert_student_upload_context(
        upload_id, student_context_token, "explain"
    )
    _assert_operation_state(
        upload_id,
        session_id,
        revision,
        state_hash,
        conversion_context_token=conversion_context_token,
        student_owner_scope=student_claims.owner_scope if student_claims else None,
        required_scope="readiness",
    )
    if session_id:
        edited_rows = None
    table = _read_upload_table(upload_id, conversion_context_token=conversion_context_token)
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
    session_id: str | None = None,
    revision: int | None = None,
    state_hash: str | None = None,
) -> dict[str, Any]:
    _assert_operation_state(
        upload_id,
        session_id,
        revision,
        state_hash,
        conversion_context_token=conversion_context_token,
        required_scope="confirm",
    )
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
        signature = source_signature(
            _read_upload_table(upload_id, conversion_context_token=conversion_context_token)
        )
    previous = metadata.get("suggestion")
    template = get_misa_template(target_template_id)
    clean_defaults = sanitize_defaults_for_template(
        target_template_id,
        defaults,
        template.headers,
    )
    owner_scope = _owner_scope_from_upload_metadata(metadata)
    profile_token = conversion_context_token
    confirmed_profile_kind = "v1"
    confirmed_profile_version = None
    confirmed_profile_state_hash = None
    confirmed_profile_fallback = None
    candidate_profile_id = str(
        metadata.get("profile_id")
        or (
            (metadata.get("mapping_profile_v2_candidate") or {}).get("profile_id")
            if isinstance(metadata.get("mapping_profile_v2_candidate"), dict)
            else ""
        )
        or ((previous or {}).get("profile_id") if isinstance(previous, dict) else "")
        or ""
    ).strip()
    v2_candidate = metadata.get("mapping_profile_v2_candidate")
    is_v2_confirmation = str(metadata.get("mapping_profile_kind") or "") == "v2" or isinstance(v2_candidate, dict)
    if is_v2_confirmation:
        try:
            profile_v2 = confirm_mapping_profile_v2(
                profile_token or "",
                candidate_profile_id=candidate_profile_id,
                source_signature_hash=str(
                    (v2_candidate or {}).get("source_signature_hash")
                    or signature.hash
                ),
                target_template_id=target_template_id,
                mapping=mapping,
                defaults=clean_defaults,
                formulas=formulas or {},
                expected_version=int(
                    metadata.get("mapping_profile_version")
                    or (
                        v2_candidate.get("version")
                        if isinstance(v2_candidate, dict)
                        else 0
                    )
                    or 0
                ),
            )
        except MappingProfileV2UnavailableError as exc:
            is_v2_confirmation = False
            confirmed_profile_fallback = f"Mapping Profile V2 không khả dụng: {exc}"
        except (MappingProfileV2Error, ValueError) as exc:
            raise ValueError(f"Không thể xác nhận mapping profile V2: {exc}") from exc
        if is_v2_confirmation:
            profile = profile_v2
            confirmed_profile_kind = "v2"
            confirmed_profile_version = (
                profile_v2.version
                if hasattr(profile_v2, "version")
                else profile_v2.get("version")
            )
            confirmed_profile_state_hash = (
                profile_v2.state_hash
                if hasattr(profile_v2, "state_hash")
                else profile_v2.get("state_hash")
            )
    if not is_v2_confirmation and profile_token:
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
    elif not is_v2_confirmation:
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
    confirmed_profile_id = (
        profile.id
        if hasattr(profile, "id")
        else profile.get("profile_id") or profile.get("id")
    )
    metadata["profile_id"] = confirmed_profile_id
    metadata["mapping_profile_kind"] = confirmed_profile_kind
    metadata["mapping_profile_version"] = confirmed_profile_version
    metadata["profile_state_hash"] = confirmed_profile_state_hash
    metadata["mapping_profile_state_hash"] = confirmed_profile_state_hash
    metadata["mapping_profile_fallback"] = (
        "legacy_v1" if confirmed_profile_fallback else None
    )
    metadata["mapping_profile_fallback_reason"] = confirmed_profile_fallback
    metadata["confirmed"] = {
        "mapping": mapping,
        "defaults": clean_defaults,
        "formulas": formulas or {},
    }
    derived = None
    if session_id and revision is not None and state_hash:
        derived = OperationStore(
            conversion_context_token=conversion_context_token
        ).create_revision(
            session_id,
            expected_revision=revision,
            expected_state_hash=state_hash,
            changes={},
            context_changes={
                "mapping": mapping,
                "defaults": clean_defaults,
                "formulas": formulas or {},
                "profile_id": profile.id,
                UPLOAD_METADATA_CONTEXT_KEY: _portable_upload_metadata(metadata),
            },
            created_by=owner_scope,
            activate=True,
        )
    _write_metadata(upload_id, metadata)
    ProfileStore().record_run(
        run_id=upload_id,
        upload_filename=metadata.get("filename", ""),
        target_template_id=target_template_id,
        profile_id=confirmed_profile_id,
        mapping_source="confirmed",
        status="confirmed",
        issues=[],
    )
    payload = {
        "profile_id": confirmed_profile_id,
        "saved": True,
        "mapping_profile_kind": confirmed_profile_kind,
        "mapping_profile_version": confirmed_profile_version,
        "profile_state_hash": confirmed_profile_state_hash,
        "mapping_profile_fallback": (
            "legacy_v1" if confirmed_profile_fallback else None
        ),
        "mapping_profile_fallback_reason": confirmed_profile_fallback,
    }
    if derived is not None:
        payload["session"] = {
            "session_id": session_id,
            "active_revision": derived.revision,
            "state_hash": derived.state_hash,
        }
    return payload


def _student_operation_ttl_seconds(
    claims: StudentContextClaims, configured_ttl_seconds: int | None
) -> int:
    remaining_seconds = claims.retention_expires_at - int(time.time()) - 1
    if remaining_seconds <= 0:
        raise ValueError("Student context retention đã hết hạn")
    return min(int(configured_ttl_seconds or remaining_seconds), remaining_seconds)


def _export_resolved_confirmed_profile(
    *,
    resolved: _ResolvedConfirmedExport,
    upload_id: str,
    profile_id: str,
    conversion_context_token: str | None,
    session_id: str | None,
    revision: int | None,
    artifact_revision: int | None = None,
) -> tuple[bytes, str]:
    metadata = resolved.metadata
    owner_scope = resolved.owner_scope
    profile_token = resolved.profile_token
    profile_kind = resolved.profile_kind
    profile_version = resolved.profile_version
    profile_v2 = resolved.profile_v2
    template = resolved.template
    rows = resolved.rows
    output_path = _upload_dir(upload_id) / "misa_export.xls"
    write_xls_from_template(template.workbook, rows, output_path)
    if profile_token and profile_kind == "v2":
        confirmation_error = None
        try:
            if profile_v2 is None or not profile_v2.state_hash:
                raise MappingProfileV2Error(
                    "Mapping Profile V2 thiếu immutable profile state hash"
                )
            record_confirmed_export_v2(
                profile_token,
                profile_id=profile_id,
                version=profile_version,
                upload_id=upload_id,
                state_hash=profile_v2.state_hash,
            )
            confirmation_status = "recorded"
        except MappingProfileV2Error as exc:
            confirmation_status = "failed"
            confirmation_error = str(exc)
        metadata["mapping_profile_v2_confirmation"] = {
            "status": confirmation_status,
            "profile_id": profile_id,
            "profile_version": profile_version,
            "profile_state_hash": profile_v2.state_hash if profile_v2 else "",
            "error": confirmation_error,
        }
        _write_metadata(upload_id, metadata)
        if confirmation_status != "recorded":
            output_path.unlink(missing_ok=True)
            raise MappingProfileV2Error(
                "Không thể ghi nhận confirmed export cho Mapping Profile V2: "
                f"{confirmation_error or 'lỗi không xác định'}"
            )
    elif profile_token:
        try:
            mark_mapping_profile_used(profile_token, profile_id)
        except MappingProfileClientError:
            pass
    else:
        ProfileStore().mark_used(profile_id, owner_scope=owner_scope)
    output = output_path.read_bytes()
    if session_id:
        OperationStore(conversion_context_token=conversion_context_token).put_artifact(
            session_id,
            kind="output",
            revision=int(artifact_revision or revision or 1),
            content=output,
            content_type="application/vnd.ms-excel",
        )
    return output, f"Import misa {upload_id[:8]}.xls"


def manifest_for_confirmed_profile(
    *,
    upload_id: str,
    profile_id: str,
    context_token: str | None,
    conversion_id: str,
    export_batch_id: str,
    edited_rows: list[dict[str, Any]] | None = None,
    acknowledge_warnings: bool = False,
    session_id: str | None = None,
    revision: int | None = None,
    state_hash: str | None = None,
    requested_profile_version: int | None = None,
    requested_profile_state_hash: str | None = None,
    vat_basis: str | None = None,
) -> ExportManifestV1:
    resolved = _resolve_confirmed_export(
        upload_id=upload_id,
        profile_id=profile_id,
        edited_rows=edited_rows,
        acknowledge_warnings=acknowledge_warnings,
        conversion_context_token=context_token,
        session_id=session_id,
        revision=revision,
        state_hash=state_hash,
        requested_profile_version=requested_profile_version,
        requested_profile_state_hash=requested_profile_state_hash,
        vat_basis=vat_basis,
    )
    manifest = build_export_manifest(
        conversion_id=conversion_id,
        export_batch_id=export_batch_id,
        target_template_id=resolved.template.id,
        template_hash=template_version(resolved.template.workbook.path),
        raw_file_hash=str(resolved.metadata.get("raw_sha256") or ""),
        mapping_profile_id=profile_id,
        mapping_profile_version=resolved.profile_version,
        mapping_profile_state_hash=str(
            resolved.metadata.get("profile_state_hash")
            or resolved.metadata.get("mapping_profile_state_hash")
            or ""
        ) or None,
        validation_ruleset_version="misa-readiness-v1",
        output_rows=resolved.rows,
        row_origins=resolved.row_origins,
    )
    _export_resolved_confirmed_profile(
        resolved=resolved,
        upload_id=upload_id,
        profile_id=profile_id,
        conversion_context_token=context_token,
        session_id=session_id,
        revision=revision,
        artifact_revision=1,
    )
    if session_id:
        content = manifest.model_dump_json().encode("utf-8")
        OperationStore(conversion_context_token=context_token).put_artifact(
            session_id,
            kind="manifest",
            revision=1,
            content=content,
            content_type="application/json",
        )
    return manifest

def _mapped_rows_with_origins(
    table: InputTable,
    target_headers: list[str],
    mapping: dict[str, Any],
    defaults: dict[str, Any],
    formulas: dict[str, str],
    *,
    trusted_source_rows: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    origins: list[dict[str, Any]] = []
    source_entries = (
        trusted_source_rows
        if trusted_source_rows is not None
        else [
            {
                "row_id": f"r{index + 1}",
                "values": source_row,
                "source_origin": {
                    "raw_sheet": str(table.sheet_name or ""),
                    "raw_rows": [table.header_row_index + index + 2],
                },
            }
            for index, source_row in enumerate(table.rows)
        ]
    )
    seen_row_ids: set[str] = set()
    for entry in source_entries:
        row_id = str(entry.get("row_id") or "")
        source_row = entry.get("values")
        source_origin = entry.get("source_origin")
        trusted_identity = (
            bool(row_id)
            and row_id not in seen_row_ids
            and isinstance(source_row, dict)
            and isinstance(source_origin, dict)
            and isinstance(source_origin.get("raw_sheet"), str)
            and bool(source_origin.get("raw_sheet"))
            and isinstance(source_origin.get("raw_rows"), list)
            and bool(source_origin.get("raw_rows"))
            and all(
                isinstance(raw_row, int) and raw_row > 0
                for raw_row in source_origin.get("raw_rows", [])
            )
        )
        if not isinstance(source_row, dict):
            continue
        seen_row_ids.add(row_id)
        mapped = apply_mapping(
            replace(table, rows=[source_row]),
            target_headers,
            mapping,
            defaults,
            formulas,
        )
        rows.extend(mapped)
        origins.extend(
            dict(source_origin)
            if trusted_identity
            else {"raw_sheet": "", "raw_rows": []}
            for _ in mapped
        )
    return rows, origins


def _resolve_confirmed_export(
    *,
    upload_id: str,
    profile_id: str,
    edited_rows: list[dict[str, Any]] | None = None,
    acknowledge_warnings: bool = False,
    conversion_context_token: str | None = None,
    student_context_token: str | None = None,
    session_id: str | None = None,
    revision: int | None = None,
    state_hash: str | None = None,
    requested_profile_version: int | None = None,
    requested_profile_state_hash: str | None = None,
    vat_basis: str | None = None,
) -> _ResolvedConfirmedExport:
    student_claims = _assert_student_upload_context(
        upload_id, student_context_token, "export"
    )
    _assert_operation_state(
        upload_id,
        session_id,
        revision,
        state_hash,
        conversion_context_token=conversion_context_token,
        student_owner_scope=student_claims.owner_scope if student_claims else None,
        required_scope="export",
        require_bound_session=True,
    )
    trusted_session_rows = None
    if session_id:
        edited_rows = None
        trusted_session_rows = OperationStore(
            conversion_context_token=conversion_context_token
        ).materialize_rows_with_ids(session_id, revision=revision)
    table = _read_upload_table(upload_id, conversion_context_token=conversion_context_token)
    metadata = _read_metadata(upload_id)
    context, context_status, context_message = _context_for_upload(
        upload_id, conversion_context_token
    )
    owner_scope = _owner_scope_from_upload_metadata(metadata)
    profile_token = student_context_token or conversion_context_token
    profile_kind = str(metadata.get("mapping_profile_kind") or "v1")
    profile_version = int(metadata.get("mapping_profile_version") or 0)
    profile_v2 = None
    if profile_token and profile_kind == "v2":
        try:
            profile_v2 = get_mapping_profile_v2(profile_token, profile_id)
        except MappingProfileV2Error as exc:
            raise ValueError(str(exc)) from exc
        if profile_v2.owner_scope != owner_scope:
            raise ValueError("Mapping profile không thuộc hồ sơ doanh nghiệp đang xử lý")
        expected_profile_state_hash = str(metadata.get("profile_state_hash") or "").strip()
        if requested_profile_version is not None and int(requested_profile_version) != int(
            metadata.get("mapping_profile_version") or 0
        ):
            raise MappingProfileV2Error(
                "Mapping profile V2 version không khớp phiên đã xác nhận"
            )
        if requested_profile_state_hash and requested_profile_state_hash != expected_profile_state_hash:
            raise MappingProfileV2Error(
                "Mapping profile V2 state hash không khớp phiên đã xác nhận"
            )
        if (
            profile_v2.version != profile_version
            or not expected_profile_state_hash
            or profile_v2.state_hash != expected_profile_state_hash
        ):
            raise MappingProfileV2Error(
                "Mapping profile V2 đã thay đổi; vui lòng xác nhận lại mapping"
            )
        target_template_id = (
            profile_v2.target_template_id
            or str(metadata.get("target_template_id") or "")
        )
        profile_mapping = profile_v2.mapping
        profile_defaults = profile_v2.defaults
        profile_formulas = profile_v2.formulas
        profile_version = profile_v2.version
    elif profile_token:
        try:
            profile = get_mapping_profile(profile_token, profile_id)
        except MappingProfileClientError as exc:
            raise ValueError(str(exc)) from exc
        if profile.owner_scope != owner_scope:
            raise ValueError("Mapping profile không thuộc hồ sơ doanh nghiệp đang xử lý")
        target_template_id = profile.target_template_id
        profile_mapping = profile.mapping
        profile_defaults = profile.defaults
        profile_formulas = profile.formulas
    else:
        profile = ProfileStore().get_profile(profile_id, owner_scope=owner_scope)
        target_template_id = profile.target_template_id
        profile_mapping = profile.mapping
        profile_defaults = profile.defaults
        profile_formulas = profile.formulas
    template = get_misa_template(target_template_id)
    clean_mapping = sanitize_mapping_for_template(target_template_id, profile_mapping)
    clean_defaults = sanitize_defaults_for_template(
        target_template_id,
        profile_defaults,
        template.headers,
    )
    if edited_rows is not None:
        rows = edited_rows
        row_origins = [{"raw_sheet": "", "raw_rows": []} for _ in rows]
    else:
        rows, row_origins = _mapped_rows_with_origins(
            table,
            template.headers,
            clean_mapping,
            clean_defaults,
            profile_formulas,
            trusted_source_rows=trusted_session_rows,
        )
    resolution = resolve_master_data(
        rows,
        context,
        source_system=_source_system_for_upload(upload_id),
    )
    rows = resolution.rows
    readiness = build_readiness_report(
        table,
        target_template_id,
        clean_mapping,
        clean_defaults,
        profile_formulas,
        edited_rows=rows,
        vat_basis=vat_basis,
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
    return _ResolvedConfirmedExport(
        table=table,
        metadata=metadata,
        owner_scope=owner_scope,
        profile_token=profile_token,
        profile_kind=profile_kind,
        profile_version=profile_version,
        profile_v2=profile_v2,
        template=template,
        rows=rows,
        row_origins=row_origins,
    )

def export_confirmed_profile(
    upload_id: str,
    profile_id: str,
    edited_rows: list[dict[str, Any]] | None = None,
    acknowledge_warnings: bool = False,
    conversion_context_token: str | None = None,
    student_context_token: str | None = None,
    session_id: str | None = None,
    revision: int | None = None,
    state_hash: str | None = None,
    requested_profile_version: int | None = None,
    requested_profile_state_hash: str | None = None,
) -> tuple[bytes, str]:
    student_claims = _assert_student_upload_context(
        upload_id, student_context_token, "export"
    )
    _assert_operation_state(
        upload_id,
        session_id,
        revision,
        state_hash,
        conversion_context_token=conversion_context_token,
        student_owner_scope=student_claims.owner_scope if student_claims else None,
        required_scope="export",
        require_bound_session=True,
    )
    if session_id:
        edited_rows = None
    table = _read_upload_table(upload_id, conversion_context_token=conversion_context_token)
    metadata = _read_metadata(upload_id)
    context, context_status, context_message = _context_for_upload(
        upload_id, conversion_context_token
    )
    owner_scope = _owner_scope_from_upload_metadata(metadata)
    profile_token = student_context_token or conversion_context_token
    profile_kind = str(metadata.get("mapping_profile_kind") or "v1")
    profile_version = int(metadata.get("mapping_profile_version") or 0)
    profile_v2 = None
    if profile_token and profile_kind == "v2":
        try:
            profile_v2 = get_mapping_profile_v2(profile_token, profile_id)
        except MappingProfileV2Error as exc:
            raise ValueError(str(exc)) from exc
        if profile_v2.owner_scope != owner_scope:
            raise ValueError("Mapping profile không thuộc hồ sơ doanh nghiệp đang xử lý")
        expected_profile_state_hash = str(metadata.get("profile_state_hash") or "").strip()
        if requested_profile_version is not None and int(requested_profile_version) != int(
            metadata.get("mapping_profile_version") or 0
        ):
            raise MappingProfileV2Error(
                "Mapping profile V2 version không khớp phiên đã xác nhận"
            )
        if requested_profile_state_hash and requested_profile_state_hash != expected_profile_state_hash:
            raise MappingProfileV2Error(
                "Mapping profile V2 state hash không khớp phiên đã xác nhận"
            )
        if (
            profile_v2.version != profile_version
            or not expected_profile_state_hash
            or profile_v2.state_hash != expected_profile_state_hash
        ):
            raise MappingProfileV2Error(
                "Mapping profile V2 đã thay đổi; vui lòng xác nhận lại mapping"
            )
        target_template_id = (
            profile_v2.target_template_id
            or str(metadata.get("target_template_id") or "")
        )
        profile_mapping = profile_v2.mapping
        profile_defaults = profile_v2.defaults
        profile_formulas = profile_v2.formulas
        profile_version = profile_v2.version
    elif profile_token:
        try:
            profile = get_mapping_profile(profile_token, profile_id)
        except MappingProfileClientError as exc:
            raise ValueError(str(exc)) from exc
        if profile.owner_scope != owner_scope:
            raise ValueError("Mapping profile không thuộc hồ sơ doanh nghiệp đang xử lý")
        target_template_id = profile.target_template_id
        profile_mapping = profile.mapping
        profile_defaults = profile.defaults
        profile_formulas = profile.formulas
    else:
        profile = ProfileStore().get_profile(profile_id, owner_scope=owner_scope)
        target_template_id = profile.target_template_id
        profile_mapping = profile.mapping
        profile_defaults = profile.defaults
        profile_formulas = profile.formulas
    template = get_misa_template(target_template_id)
    clean_mapping = sanitize_mapping_for_template(target_template_id, profile_mapping)
    clean_defaults = sanitize_defaults_for_template(
        target_template_id,
        profile_defaults,
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
            profile_formulas,
        )
    resolution = resolve_master_data(
        rows,
        context,
        source_system=_source_system_for_upload(upload_id),
    )
    rows = resolution.rows
    readiness = build_readiness_report(
        table,
        target_template_id,
        clean_mapping,
        clean_defaults,
        profile_formulas,
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
    if profile_token and profile_kind == "v2":
        confirmation_error = None
        try:
            if profile_v2 is None or not profile_v2.state_hash:
                raise MappingProfileV2Error(
                    "Mapping Profile V2 thiếu immutable profile state hash"
                )
            record_confirmed_export_v2(
                profile_token,
                profile_id=profile_id,
                version=profile_version,
                upload_id=upload_id,
                state_hash=profile_v2.state_hash,
            )
            confirmation_status = "recorded"
        except MappingProfileV2Error as exc:
            confirmation_status = "failed"
            confirmation_error = str(exc)
        metadata["mapping_profile_v2_confirmation"] = {
            "status": confirmation_status,
            "profile_id": profile_id,
            "profile_version": profile_version,
            "profile_state_hash": profile_v2.state_hash if profile_v2 else "",
            "error": confirmation_error,
        }
        _write_metadata(upload_id, metadata)
        if confirmation_status != "recorded":
            output_path.unlink(missing_ok=True)
            raise MappingProfileV2Error(
                "Không thể ghi nhận confirmed export cho Mapping Profile V2: "
                f"{confirmation_error or 'lỗi không xác định'}"
            )
    elif profile_token:
        try:
            mark_mapping_profile_used(profile_token, profile_id)
        except MappingProfileClientError:
            pass
    else:
        ProfileStore().mark_used(profile_id, owner_scope=owner_scope)
    output = output_path.read_bytes()
    if session_id:
        OperationStore(conversion_context_token=conversion_context_token).put_artifact(
            session_id,
            kind="output",
            revision=int(revision or 1),
            content=output,
            content_type="application/vnd.ms-excel",
        )
    return output, f"Import misa {upload_id[:8]}.xls"


def _context_for_analyze(
    token: str | None,
) -> tuple[dict[str, Any] | None, str, str | None, dict[str, Any] | None]:
    if not token:
        return None, "not_configured", None, None
    claims = verify_conversion_context_token(token)
    if not claims.get("workspace_id"):
        return None, "not_configured", None, claims
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
        conversion_context_owner_scope(claims)
        != str(expected.get("owner_scope") or "")
        or str(claims.get("workspace_id") or "")
        != str(expected.get("workspace_id") or "")
        or str(claims.get("snapshot_set_hash"))
        != str(expected.get("snapshot_set_hash"))
    ):
        raise ValueError("Conversion context không khớp với lần phân tích ban đầu")
    if not claims.get("workspace_id"):
        return None, "not_configured", None
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


def _read_upload_table(
    upload_id: str, *, conversion_context_token: str | None = None
) -> InputTable:
    metadata = _read_metadata(upload_id)
    session_id = str(metadata.get("operation_session_id") or "")
    if metadata.get("operation_state_contract") == STUDENT_METADATA_STATE_CONTRACT:
        return read_input_table(Path(metadata["input_path"]))
    if session_id:
        return OperationStore(
            conversion_context_token=conversion_context_token
        ).materialize_table(session_id)
    return read_input_table(Path(metadata["input_path"]))


def _upload_dir(upload_id: str) -> Path:
    return UPLOAD_ROOT / upload_id


def _metadata_path(upload_id: str) -> Path:
    return _upload_dir(upload_id) / "metadata.json"


def _read_metadata(
    upload_id: str,
    *,
    operation_store: OperationStore | None = None,
    session: Any | None = None,
) -> dict[str, Any]:
    path = _metadata_path(upload_id)
    if path.exists():
        metadata = json.loads(path.read_text(encoding="utf-8"))
        if operation_store is not None and session is not None:
            _assert_upload_metadata_binding(metadata, upload_id, session)
            _restore_upload_bytes_if_missing(metadata, operation_store, session)
        return metadata
    if operation_store is None or session is None:
        raise KeyError(f"Upload not found: {upload_id}")
    return _restore_upload_from_session(upload_id, operation_store, session)


def _write_metadata(upload_id: str, metadata: dict[str, Any]) -> None:
    path = _metadata_path(upload_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

def apply_optional_ai_mapping(
    *,
    table: InputTable,
    target_template_id: str,
    template_headers: list[str],
    fallback: MappingSuggestion,
    issues: list[dict[str, Any]],
    use_ai: bool,
    ai_mapping_opt_in: bool,
    nearby_profiles: list[dict[str, Any]] | None = None,
) -> tuple[MappingSuggestion, dict[str, str] | None]:
    """Apply an explicitly authorized AI suggestion, never AI severity."""
    if not use_ai or not ai_mapping_opt_in or not ai_mapping_client.ai_enabled():
        return fallback, None
    if not _should_request_ai_mapping(
        table=table,
        target_template_id=target_template_id,
        suggestion=fallback,
        issues=issues,
    ):
        return fallback, None

    try:
        ai_payload = ai_mapping_client.request_mapping_suggestion(
            ai_suggestion_payload(
                table,
                target_template_id,
                template_headers,
                nearby_profiles=nearby_profiles,
            )
        )
        candidate = normalize_ai_suggestion(
            ai_payload,
            fallback,
            target_template_id=target_template_id,
            target_headers=template_headers,
        )
        semantic_issues = validate_mapping_semantics(
            target_template_id=target_template_id,
            template_headers=template_headers,
            source_headers=table.headers,
            mapping=candidate.mapping,
            defaults=candidate.defaults,
            formulas=candidate.formulas,
            sample_rows=table.rows[:20],
        )
        if any(issue.severity == "blocker" for issue in semantic_issues):
            raise ai_mapping_client.AiMappingError(
                "AI mapping không vượt qua kiểm tra ngữ nghĩa.",
                gateway="online",
                model="available",
            )
        mapping_state = candidate.source if candidate.source in {"ai", "mixed"} else "heuristic"
        return candidate, {
            "gateway": "online",
            "model": "available",
            "mapping": mapping_state,
        }
    except ai_mapping_client.AiMappingError as exc:
        return replace(
            fallback,
            warnings=[*fallback.warnings, "ai_unavailable"],
        ), {
            "gateway": exc.gateway,
            "model": exc.model,
            "mapping": "failed",
        }
    except (TypeError, ValueError):
        return replace(
            fallback,
            warnings=[*fallback.warnings, "ai_unavailable"],
        ), {
            "gateway": "online",
            "model": "unknown",
            "mapping": "failed",
        }

def _trusted_preallocated_session_binding(
    claims: dict[str, Any] | None,
    *,
    operation_session_id: str | None,
    conversion_run_id: str | None,
) -> tuple[str | None, str | None]:
    supplied_session_id = str(operation_session_id or "").strip()
    supplied_run_id = str(conversion_run_id or "").strip()
    claimed_session_id = str((claims or {}).get("operation_session_id") or "").strip()
    claimed_run_id = str((claims or {}).get("conversion_run_id") or "").strip()
    if not supplied_session_id and not claimed_session_id:
        return None, claimed_run_id or None
    if (
        not supplied_session_id
        or not claimed_session_id
        or supplied_session_id != claimed_session_id
    ):
        raise ValueError("Operation session không khớp conversion context")
    if not supplied_run_id or supplied_run_id != claimed_run_id:
        raise ValueError("Conversion run không khớp conversion context")
    return supplied_session_id, supplied_run_id

def sync_mapping_session(
    *,
    upload_id: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any] | None = None,
    formulas: dict[str, str] | None = None,
    conversion_context_token: str | None = None,
    session_id: str,
    revision: int,
    state_hash: str,
) -> dict[str, Any]:
    _assert_operation_state(
        upload_id,
        session_id,
        revision,
        state_hash,
        conversion_context_token=conversion_context_token,
        required_scope="confirm",
    )
    metadata = _read_metadata(upload_id)
    if str(metadata.get("target_template_id") or "") != target_template_id:
        raise ValueError("Template không khớp với lần phân tích ban đầu")
    template = get_misa_template(target_template_id)
    clean_defaults = sanitize_defaults_for_template(
        target_template_id, defaults, template.headers
    )
    clean_formulas = dict(formulas or {})
    desired = {
        "mapping": dict(mapping),
        "defaults": clean_defaults,
        "formulas": clean_formulas,
    }
    store = OperationStore(conversion_context_token=conversion_context_token)
    current = store.active_context(session_id)
    if all(current.get(key) == value for key, value in desired.items()):
        session = store.assert_current(
            session_id,
            expected_revision=revision,
            expected_state_hash=state_hash,
        )
        return {
            "session": {
                "session_id": session.session_id,
                "active_revision": session.active_revision,
                "state_hash": session.state_hash,
            },
            "changed": False,
        }
    derived = store.create_revision(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
        changes={},
        context_changes=desired,
        created_by=_owner_scope_from_upload_metadata(metadata),
        activate=True,
    )
    return {
        "session": {
            "session_id": session_id,
            "active_revision": derived.revision,
            "state_hash": derived.state_hash,
        },
        "changed": True,
    }

def _mapping_profile_v2_payload(
    match: Any | None, mapping_source: str
) -> dict[str, Any] | None:
    if match is None:
        return None
    profile = match.profile
    drift = [
        {
            "id": field,
            "current": field,
            "suggestion": "Cần người dùng xác nhận thay đổi cấu trúc",
        }
        for field in match.warnings
    ]
    return {
        "match_tier": match.match_tier,
        "mapping_source": mapping_source,
        "profile_id": profile.id,
        "confidence": profile.confidence,
        "drift": drift,
        "drift_count": len(drift),
        "risk_flags": list(profile.risk_flags),
        "approved_risk_flags": list(match.approved_risk_flags),
        "unapproved_risk_flags": list(match.unapproved_risk_flags),
        "approval_state": match.approval_state,
        "approval_applies_to_match": match.approval_applies_to_match,
        "can_suggest": match.can_suggest,
        "requires_preview": match.requires_preview,
        "warnings": list(match.warnings),
        "profile": {
            "id": profile.id,
            "name": profile.name,
            "version": profile.version,
            "status": profile.status,
            "source_family": profile.source_family,
            "document_type": profile.document_type,
            "target_template_id": profile.target_template_id,
            "target_template_version": profile.target_template_version,
            "risk_flags": list(profile.risk_flags),
            "state_hash": profile.state_hash,
            "approved_by": profile.approved_by or None,
            "confidence": profile.confidence,
        },
    }

def _upload_cache_ttl_seconds() -> int:
    configured = os.getenv(
        "UPLOAD_CACHE_TTL_SECONDS",
        os.getenv("OPERATION_SESSION_TTL_SECONDS", "3600"),
    )
    try:
        seconds = int(configured)
    except (TypeError, ValueError):
        seconds = 3600
    return min(24 * 60 * 60, max(60, seconds))

def _assert_operation_state(
    upload_id: str,
    session_id: str | None,
    revision: int | None,
    state_hash: str | None,
    *,
    conversion_context_token: str | None = None,
    student_owner_scope: str | None = None,
    required_scope: str,
    require_bound_session: bool = False,
) -> None:
    if not session_id or revision is None or not state_hash:
        if student_owner_scope:
            metadata = _read_metadata(upload_id)
            if _owner_scope_from_upload_metadata(metadata) != student_owner_scope:
                raise ConversionContextError(
                    "Student owner không khớp upload", status_code=403
                )
            bound_session_id = str(metadata.get("operation_session_id") or "")
            if require_bound_session and not bound_session_id:
                raise OperationStoreConflictError("Upload chưa gắn operation session")
            if (
                bound_session_id
                and metadata.get("operation_state_contract")
                == STUDENT_METADATA_STATE_CONTRACT
            ):
                return
            if bound_session_id:
                session = OperationStore().load_session(bound_session_id)
                if session.upload_id != upload_id or session.owner_scope != student_owner_scope:
                    raise KeyError("Operation session not found")
            return
        raise OperationStoreConflictError(
            "Mapping operation phải gửi session_id, revision và state_hash"
        )
    store = OperationStore(conversion_context_token=conversion_context_token)
    session = store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    if session.upload_id != upload_id:
        raise KeyError("Operation session not found")
    if student_owner_scope == session.owner_scope:
        metadata = _read_metadata(
            upload_id,
            operation_store=store,
            session=session,
        )
    else:
        if not conversion_context_token:
            raise ConversionContextError(
                "Conversion context token là bắt buộc", status_code=401
            )
        claims = verify_conversion_context_token(conversion_context_token)
        store.assert_context_binding(
            session_id,
            claims,
            required_scope=required_scope,
        )
        metadata = _read_metadata(
            upload_id,
            operation_store=store,
            session=session,
        )
    if str(metadata.get("operation_session_id") or "") != session_id:
        raise KeyError("Operation session not found")

def _portable_upload_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in metadata.items()
        if key != "input_path"
    }

def _restore_upload_from_session(
    upload_id: str,
    operation_store: OperationStore,
    session: Any,
) -> dict[str, Any]:
    context = operation_store.context_for_revision(
        session.session_id,
        session.active_revision,
    )
    portable = context.get(UPLOAD_METADATA_CONTEXT_KEY)
    if not isinstance(portable, dict):
        raise OperationStoreError("Session thiếu upload metadata")
    metadata = dict(portable)
    _assert_upload_metadata_binding(metadata, upload_id, session)
    filename = str(metadata.get("filename") or "").strip()
    suffix = Path(filename).suffix.lower()
    if suffix not in {".xls", ".xlsx"}:
        raise OperationStoreError("Upload metadata có định dạng file không hợp lệ")
    input_path = _upload_dir(upload_id) / f"input{suffix}"
    metadata["input_path"] = str(input_path)
    metadata["raw_sha256"] = session.raw_sha256
    session_expires_at = int(session.expires_at.timestamp())
    metadata["expires_at"] = session_expires_at
    metadata["operation_session_expires_at"] = session_expires_at
    _restore_upload_bytes_if_missing(metadata, operation_store, session)
    _write_metadata(upload_id, metadata)
    return metadata

def _restore_upload_bytes_if_missing(
    metadata: dict[str, Any],
    operation_store: OperationStore,
    session: Any,
) -> None:
    input_path = Path(str(metadata.get("input_path") or ""))
    expected_sha256 = str(getattr(session, "raw_sha256", "") or "").strip().lower()
    if not _is_sha256(expected_sha256):
        raise OperationStoreError("Upload metadata checksum không hợp lệ")
    if input_path.is_file():
        try:
            local_sha256 = _sha256_file(input_path)
        except OSError:
            local_sha256 = ""
        if local_sha256 == expected_sha256:
            return

    content = operation_store.get_artifact(
        session.session_id,
        kind="upload",
        revision=1,
    )
    if content is None:
        raise OperationStoreError("Upload artifact không khả dụng")
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        raise OperationStoreConflictError("Upload artifact checksum không khớp")
    input_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = input_path.with_name(f".{input_path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.replace(input_path)
    finally:
        temporary.unlink(missing_ok=True)

def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value)

def _assert_upload_metadata_binding(
    metadata: dict[str, Any],
    upload_id: str,
    session: Any,
) -> None:
    context = metadata.get("conversion_context")
    context = context if isinstance(context, dict) else {}
    expected = {
        "upload_id": session.upload_id,
        "operation_session_id": session.session_id,
        "target_template_id": session.target_template_id,
        "conversion_run_id": str(
            session.revisions[0].context.get("conversion_run_id") or ""
        ),
        "owner_scope": session.owner_scope,
    }
    actual = {
        "upload_id": str(metadata.get("upload_id") or ""),
        "operation_session_id": str(metadata.get("operation_session_id") or ""),
        "target_template_id": str(metadata.get("target_template_id") or ""),
        "conversion_run_id": str(
            metadata.get("conversion_run_id") or context.get("conversion_run_id") or ""
        ),
        "owner_scope": str(
            metadata.get("owner_scope") or context.get("owner_scope") or ""
        ),
    }
    context_binding_invalid = bool(context) and (
        str(context.get("user_id") or "") != str(session.user_id or "")
        or str(context.get("workspace_id") or "") != str(session.workspace_id or "")
    )
    if upload_id != session.upload_id or actual != expected or context_binding_invalid:
        raise OperationStoreError("Upload metadata binding không hợp lệ")

def _upload_content_type(filename: str) -> str:
    if Path(filename or "").suffix.lower() == ".xls":
        return "application/vnd.ms-excel"
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
def cleanup_expired_uploads(now: float | int | None = None) -> list[str]:
    """Delete expired converter cache entries without deleting active sessions."""
    current_time = float(time.time() if now is None else now)
    if not UPLOAD_ROOT.is_dir():
        return []

    deleted: list[str] = []
    with _UPLOAD_CACHE_LOCK:
        for upload_dir in sorted(UPLOAD_ROOT.iterdir(), key=lambda path: path.name):
            if not upload_dir.is_dir():
                continue
            metadata_path = upload_dir / "metadata.json"
            if not metadata_path.is_file():
                continue
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                if not isinstance(metadata, dict):
                    continue
            except (OSError, json.JSONDecodeError):
                # Preserve malformed entries for forensic cleanup instead of guessing.
                continue

            expires_at = _metadata_timestamp(metadata.get("expires_at"))
            if expires_at is None:
                created_at = _metadata_timestamp(metadata.get("created_at"))
                if created_at is None:
                    try:
                        created_at = metadata_path.stat().st_mtime
                    except OSError:
                        continue
                expires_at = created_at + _upload_cache_ttl_seconds()
            if expires_at > current_time:
                continue
            if _upload_cache_is_active(metadata, upload_dir, current_time):
                continue

            try:
                shutil.rmtree(upload_dir)
            except OSError:
                continue
            if not upload_dir.exists():
                deleted.append(upload_dir.name)
    return deleted

def _upload_cache_is_active(
    metadata: dict[str, Any], upload_dir: Path, current_time: float
) -> bool:
    student_metadata_path = upload_dir / "student_metadata.json"
    if student_metadata_path.is_file():
        try:
            student_metadata = json.loads(
                student_metadata_path.read_text(encoding="utf-8")
            )
            student_expires_at = _metadata_timestamp(student_metadata.get("expires_at"))
            if student_expires_at is not None and student_expires_at > current_time:
                return True
        except (OSError, json.JSONDecodeError):
            return True

    if not str(metadata.get("operation_session_id") or "").strip():
        return False
    session_expires_at = _metadata_timestamp(
        metadata.get("operation_session_expires_at")
        or metadata.get("session_expires_at")
    )
    # Legacy bound entries have no trustworthy remote expiry. Keep them safe.
    return session_expires_at is None

def _metadata_timestamp(value: Any) -> float | None:
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        return None
    return timestamp if timestamp >= 0 else None
