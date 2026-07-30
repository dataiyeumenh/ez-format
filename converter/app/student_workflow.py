from __future__ import annotations

import hashlib
import json
import hmac
import os
from pathlib import Path
from typing import Any

from fastapi.encoders import jsonable_encoder
from openpyxl.utils.cell import coordinate_from_string

from app.document_structure import inspect_workbook_structure
from app.misa_templates import get_misa_template
from app.master_data_client import ConversionContextError, verify_conversion_context_token
from app.misa_workflow import (
    _read_metadata,
    _read_upload_table,
    analyze_upload,
    preview_mapping,
    purge_student_raw_state,
    readiness_mapping,
)
from app.normalization import normalize_header
from app.operation_store import operation_context_required
from app.student_accounting_map import build_accounting_maps
from app.student_anonymization import (
    AnonymizationExportError,
    AnonymizationUnsupportedLayerError,
    AnonymizationSession,
    AnonymizedWorkbook,
    anonymize_workbook_bytes,
)
from app.student_context import StudentContextClaims, verify_student_context
from app.student_explanations import (
    build_student_explanations,
    build_student_summary,
    explanation_state_hash,
)
from app.student_queries import answer_question
from app.student_reconciliation import reconcile_session
from app.student_reports import ReportValidationError, build_internship_markdown_report
from app.student_session_client import (
    StudentSessionClientError,
    assert_student_session_active,
    get_verified_activities,
    record_analysis_completed,
    record_activity_event,
    record_question_event,
)
from app.student_store import (
    StudentUploadConflictError,
    assert_no_student_upload_for_session,
    assert_upload_owner,
    claim_student_analysis,
    find_student_upload_id,
)
from app.voucher_reconstruction import reconstruct_vouchers


OVERVIEW_FILENAME = "student-overview.json"
MAX_STUDENT_PREVIEW_ROWS = 25
MIN_STUDENT_ANONYMIZATION_SECRET_CHARS = 32
MIN_UNIQUE_STUDENT_ANONYMIZATION_SECRET_CHARS = 12
_UNSAFE_STUDENT_ANONYMIZATION_SECRETS = {
    "change-me",
    "changeme",
    "default",
    "dev_change_me_in_production",
    "password",
    "secret",
}

_CONFIDENTIAL_HEADER_MARKERS = {
    "company": ("ten_cong_ty", "ten_doanh_nghiep", "ten_don_vi"),
    "counterparty": (
        "khach_hang",
        "nha_cung_cap",
        "nguoi_mua",
        "nguoi_ban",
        "doi_tac",
    ),
    "tax_code": ("ma_so_thue",),
    "address": ("dia_chi",),
    "email": ("email", "e_mail"),
    "phone": ("dien_thoai", "so_dien_thoai", "phone"),
    "bank_account": ("tai_khoan_ngan_hang", "so_tai_khoan"),
    "document_number": ("so_hoa_don", "ma_hoa_don", "so_chung_tu"),
}


class StudentWorkflowError(ValueError):
    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        super().__init__(message)


def _operation_state(metadata: dict[str, Any]) -> dict[str, Any]:
    # Task 4 gateway does not expose the later shared operation-state contract yet.
    return {}


def analyze_student_file(
    *,
    filename: str,
    content: bytes,
    context_token: str,
    target_template_id: str | None = None,
    operation_context_token: str | None = None,
) -> dict[str, Any]:
    claims = _student_claims(context_token, "analyze")
    _student_claims(context_token, "explain")
    operation_binding = _student_operation_binding(claims, operation_context_token)
    try:
        with claim_student_analysis(claims):
            assert_no_student_upload_for_session(claims)
            try:
                analyzed = analyze_upload(
                    filename=filename,
                    content=content,
                    requested_target_template_id=target_template_id,
                    student_context_token=context_token,
                    operation_context_token=operation_context_token,
                    **operation_binding,
                )
            except ValueError as exc:
                raise StudentWorkflowError(400, str(exc)) from exc

            overview = _build_current_overview(
                upload_id=str(analyzed["upload_id"]),
                token=context_token,
                claims=claims,
            )
            sync_payload = _analysis_completed_payload(overview)
            production_sync_required = operation_context_required()
            converter_upload_id = str(
                sync_payload.get("converterUploadId") or ""
            ).strip()
            if production_sync_required and converter_upload_id != str(
                overview.get("upload_id") or ""
            ).strip():
                cleanup_completed = _purge_failed_student_analysis(
                    claims=claims,
                    overview=overview,
                    operation_context_token=operation_context_token,
                )
                message = "Backend sync thiếu converterUploadId"
                if cleanup_completed:
                    message += "; dữ liệu phân tích đã được purge"
                else:
                    message += "; purge không hoàn tất"
                raise StudentWorkflowError(
                    503,
                    message,
                )
            try:
                record_analysis_completed(context_token, sync_payload)
                overview["session_sync"] = {"status": "synced", "message": None}
            except StudentSessionClientError as exc:
                if production_sync_required:
                    cleanup_completed = _purge_failed_student_analysis(
                        claims=claims,
                        overview=overview,
                        operation_context_token=operation_context_token,
                    )
                    message = "Backend Student sync thất bại"
                    if not cleanup_completed:
                        message += "; purge không hoàn tất"
                    raise StudentWorkflowError(503, message) from exc
                overview["session_sync"] = {
                    "status": "unavailable",
                    "message": str(exc),
                }
            return overview
    except StudentUploadConflictError as exc:
        raise StudentWorkflowError(409, str(exc)) from exc


def _student_operation_binding(
    student_claims: StudentContextClaims,
    operation_context_token: str | None,
) -> dict[str, str]:
    token = str(operation_context_token or "").strip()
    if not token:
        if operation_context_required():
            raise StudentWorkflowError(401, "Thiếu signed Student operation context")
        return {}
    try:
        claims = verify_conversion_context_token(token)
    except ConversionContextError as exc:
        raise StudentWorkflowError(401, str(exc)) from exc
    expected = {
        "operation_session_id": student_claims.session_id,
        "user_id": student_claims.user_id,
        "owner_scope": student_claims.owner_scope,
        "workspace_id": str(student_claims.workspace_id or ""),
    }
    if any(str(claims.get(key) or "") != str(value) for key, value in expected.items()):
        raise StudentWorkflowError(403, "Student operation context không khớp phiên hỗ trợ")
    if "analyze" not in (claims.get("scopes") or []):
        raise StudentWorkflowError(403, "Student operation context thiếu quyền analyze")
    conversion_run_id = str(claims.get("conversion_run_id") or "").strip()
    if not conversion_run_id:
        raise StudentWorkflowError(409, "Student operation context thiếu conversion run")
    upload_id = str(claims.get("upload_id") or "").strip()
    if operation_context_required() and not upload_id:
        raise StudentWorkflowError(409, "Student operation context thiếu upload binding")
    return {
        "operation_session_id": student_claims.session_id,
        "conversion_run_id": conversion_run_id,
        **({"preallocated_upload_id": upload_id} if upload_id else {}),
    }


def _purge_failed_student_analysis(
    *,
    claims: StudentContextClaims,
    overview: dict[str, Any],
    operation_context_token: str | None,
) -> bool:
    upload_id = str(overview.get("upload_id") or "").strip()
    if not upload_id or not str(operation_context_token or "").strip():
        return False
    try:
        result = purge_student_raw_state(
            session_id=claims.session_id,
            student_claims=claims,
            conversion_context_token=str(operation_context_token),
        )
    except (ConversionContextError, ValueError):
        return False
    return bool(
        result.get("raw_upload_deleted") is True
        and result.get("local_operation_session_deleted") is True
        and result.get("remote_operation_session_deleted") is True
        and result.get("operation_session_deleted") is True
    )


def get_student_overview(*, session_id: str, context_token: str) -> dict[str, Any]:
    claims = _student_claims(context_token, "explain")
    normalized_session_id = str(session_id or "").strip()
    if claims.session_id != normalized_session_id:
        raise StudentWorkflowError(403, "Student context không thuộc phiên này")
    try:
        upload_id = find_student_upload_id(claims)
    except StudentUploadConflictError as exc:
        raise StudentWorkflowError(409, str(exc)) from exc
    except KeyError as exc:
        raise StudentWorkflowError(404, "Không tìm thấy upload của phiên học") from exc
    except ValueError as exc:
        status_code = 410 if "hết hạn" in str(exc).lower() else 403
        raise StudentWorkflowError(status_code, str(exc)) from exc

    return _build_current_overview(upload_id=upload_id, token=context_token, claims=claims)


def get_student_accounting_map(
    *, session_id: str, context_token: str
) -> dict[str, Any]:
    claims, normalized_session_id, upload_id = _active_student_phase_session(
        session_id=session_id,
        context_token=context_token,
        required_scope="accounting_map",
        feature_flag="STUDENT_ACCOUNTING_MAP_ENABLED",
        disabled_message="Student accounting map chưa được bật",
    )
    overview = _build_current_overview(
        upload_id=upload_id,
        token=context_token,
        claims=claims,
    )
    try:
        metadata = _read_metadata(upload_id)
        table = _read_upload_table(upload_id)
        target_template_id, mapping_source, _, _, defaults, _ = _effective_mapping(
            metadata
        )
        voucher_report = reconstruct_vouchers(
            table,
            mode=_student_voucher_mode(target_template_id),
            requested_template_id=target_template_id,
        )
        maps = build_accounting_maps(
            {
                "table": table,
                "voucher_report": voucher_report,
                "student_preview": overview["student_preview"],
                "defaults": defaults,
                "default_provenance": _student_default_provenance(
                    mapping_source,
                    defaults,
                ),
            }
        )
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except ValueError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc

    evidence_count = sum(len(accounting_map.entries) for accounting_map in maps)
    _record_activity_best_effort(
        context_token,
        {
            "sessionId": normalized_session_id,
            "eventType": "accounting_map_reviewed",
            "evidenceCount": evidence_count,
        },
    )
    return {
        "session_id": normalized_session_id,
        "upload_id": upload_id,
        "student_state_hash": overview["student_state_hash"],
        "maps": [item.model_dump(mode="json") for item in maps],
    }


def get_student_reconciliation(
    *, session_id: str, context_token: str
) -> dict[str, Any]:
    claims, normalized_session_id, upload_id = _active_student_phase_session(
        session_id=session_id,
        context_token=context_token,
        required_scope="reconcile",
        feature_flag="STUDENT_RECONCILIATION_ENABLED",
        disabled_message="Student reconciliation chưa được bật",
    )
    overview = _build_current_overview(
        upload_id=upload_id,
        token=context_token,
        claims=claims,
    )
    try:
        metadata = _read_metadata(upload_id)
        target_template_id, _, _, mapping, defaults, formulas = _effective_mapping(
            metadata
        )
        operation_state = _operation_state(metadata)
        preview = preview_mapping(
            upload_id=upload_id,
            target_template_id=target_template_id,
            mapping=mapping,
            defaults=defaults,
            formulas=formulas,
            student_context_token=context_token,
            **operation_state,
        )
        report = reconcile_session(
            {
                "rows": preview.get("rows") or [],
                "readiness": overview["readiness"],
            }
        )
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except ValueError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc

    payload = report.to_dict()
    payload.update(
        {
            "session_id": normalized_session_id,
            "upload_id": upload_id,
            "student_state_hash": overview["student_state_hash"],
        }
    )
    _record_activity_best_effort(
        context_token,
        {
            "sessionId": normalized_session_id,
            "eventType": "reconciliation_completed",
            "evidenceCount": sum(bool(item.evidence) for item in report.items),
        },
    )
    return payload


def preview_student_anonymization(
    *,
    session_id: str,
    context_token: str,
    full_document_numbers: bool = False,
) -> dict[str, Any]:
    _, normalized_session_id, upload_id = _active_student_phase_session(
        session_id=session_id,
        context_token=context_token,
        required_scope="export",
        feature_flag="STUDENT_INTERNSHIP_ENABLED",
        disabled_message="Student internship assistant chưa được bật",
    )
    exported, confidential_values = _anonymized_student_workbook(
        session_id=normalized_session_id,
        upload_id=upload_id,
        full_document_numbers=full_document_numbers,
    )
    return {
        "session_id": normalized_session_id,
        "upload_id": upload_id,
        "filename": exported.filename,
        "full_document_numbers": full_document_numbers,
        "replaced_categories": list(exported.replaced_categories),
        "replaced_layers": list(exported.replaced_layers),
        "replacement_count": _replacement_count(
            confidential_values,
            exported.replaced_categories,
        ),
        "warnings": list(exported.warnings),
        "scanner_status": "passed",
    }


def export_student_anonymized_workbook(
    *,
    session_id: str,
    context_token: str,
    full_document_numbers: bool = False,
) -> AnonymizedWorkbook:
    _, normalized_session_id, upload_id = _active_student_phase_session(
        session_id=session_id,
        context_token=context_token,
        required_scope="export",
        feature_flag="STUDENT_INTERNSHIP_ENABLED",
        disabled_message="Student internship assistant chưa được bật",
    )
    exported, _ = _anonymized_student_workbook(
        session_id=normalized_session_id,
        upload_id=upload_id,
        full_document_numbers=full_document_numbers,
    )
    _record_activity_best_effort(
        context_token,
        {
            "sessionId": normalized_session_id,
            "eventType": "anonymized_export_created",
            "evidenceCount": len(exported.replaced_categories),
        },
    )
    return exported


def build_student_internship_report(
    *,
    session_id: str,
    context_token: str,
    activity_ids: list[str],
    approved_notes: list[str],
) -> str:
    _, normalized_session_id, upload_id = _active_student_phase_session(
        session_id=session_id,
        context_token=context_token,
        required_scope="export",
        feature_flag="STUDENT_INTERNSHIP_ENABLED",
        disabled_message="Student internship assistant chưa được bật",
    )
    try:
        metadata = _read_metadata(upload_id)
        table = _read_upload_table(upload_id)
        signed_session_metadata = get_verified_activities(
            context_token,
            normalized_session_id,
        )
        return build_internship_markdown_report(
            file_metadata={
                "filename": str(metadata.get("filename") or "student-workbook"),
                "sheet_name": str(table.sheet_name or ""),
                "row_count": len(table.rows),
                "template_id": str(metadata.get("target_template_id") or ""),
            },
            signed_session_metadata=signed_session_metadata,
            activity_ids=activity_ids,
            approved_notes=approved_notes,
            confidential_values=_student_confidential_values(table),
        )
    except StudentSessionClientError as exc:
        raise StudentWorkflowError(exc.status_code, str(exc)) from exc
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except ReportValidationError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc
    except ValueError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc


def ask_student_question(
    *,
    session_id: str,
    context_token: str,
    question: str,
) -> dict[str, Any]:
    claims, normalized_session_id, active_upload_id = _active_question_session(
        session_id=session_id,
        context_token=context_token,
    )

    overview = get_student_overview(
        session_id=normalized_session_id,
        context_token=context_token,
    )
    upload_id = str(overview["upload_id"])
    if upload_id != active_upload_id:
        raise StudentWorkflowError(409, "Student upload đã thay đổi trong khi kiểm tra phiên")
    try:
        table = _read_upload_table(upload_id)
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except ValueError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc

    state = {
        "session_id": claims.session_id,
        "upload_id": upload_id,
        "state_hash": overview["student_state_hash"],
        "target_template_id": overview["target_template_id"],
        "target_headers": overview["target_headers"],
        "table": table,
        "mapping": overview["mapping_suggestion"].get("mapping") or {},
        "defaults": overview["mapping_suggestion"].get("defaults") or {},
        "formulas": overview["mapping_suggestion"].get("formulas") or {},
        "summary": overview["student_summary"],
        "readiness": overview["readiness"],
        "ai_available": _student_ai_available(),
    }
    normalized_question = str(question or "").strip()
    answer = answer_question(normalized_question, state)
    payload = answer.model_dump(mode="json")
    event = {
        "event": "question_answered",
        "sessionId": claims.session_id,
        "questionHash": hashlib.sha256(normalized_question.encode("utf-8")).hexdigest(),
        "questionLength": len(normalized_question),
        "category": answer.intent,
        "operation": "ask",
        "answerType": answer.answer_type,
        "evidenceIds": [item.id for item in answer.evidence],
        "evidenceCount": answer.evidence_count,
        "outcome": answer.outcome,
    }
    try:
        record_question_event(context_token, event)
        payload["event_sync"] = {"status": "synced", "message": None}
    except StudentSessionClientError as exc:
        payload["event_sync"] = {"status": "unavailable", "message": str(exc)}
    return payload


def get_student_source_row(
    *,
    session_id: str,
    worksheet_row: int,
    context_token: str,
) -> dict[str, Any]:
    claims, normalized_session_id, active_upload_id = _active_question_session(
        session_id=session_id,
        context_token=context_token,
    )
    overview = get_student_overview(
        session_id=normalized_session_id,
        context_token=context_token,
    )
    upload_id = str(overview["upload_id"])
    if upload_id != active_upload_id:
        raise StudentWorkflowError(409, "Student upload đã thay đổi trong khi kiểm tra phiên")
    try:
        table = _read_upload_table(upload_id)
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except ValueError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc

    header_worksheet_row = table.header_row_index + 1
    data_row_number = int(worksheet_row) - header_worksheet_row
    if not 1 <= data_row_number <= len(table.rows):
        raise StudentWorkflowError(404, "Dòng nguồn nằm ngoài vùng dữ liệu đang hoạt động")
    source_row = table.rows[data_row_number - 1]
    return {
        "session_id": claims.session_id,
        "upload_id": upload_id,
        "state_hash": overview["student_state_hash"],
        "sheet": str(table.sheet_name or ""),
        "header_row": header_worksheet_row,
        "worksheet_row": int(worksheet_row),
        "fields": [
            {"field": header, "value": source_row.get(header)}
            for header in table.headers
        ],
    }


def _active_question_session(
    *,
    session_id: str,
    context_token: str,
) -> tuple[StudentContextClaims, str, str]:
    if not _student_question_enabled():
        raise StudentWorkflowError(404, "Student file Q&A chưa được bật")
    claims = _student_claims(context_token, "ask")
    normalized_session_id = str(session_id or "").strip()
    if claims.session_id != normalized_session_id:
        raise StudentWorkflowError(403, "Student context không thuộc phiên này")
    try:
        upload_id = find_student_upload_id(claims)
    except StudentUploadConflictError as exc:
        raise StudentWorkflowError(409, str(exc)) from exc
    except KeyError as exc:
        raise StudentWorkflowError(404, "Không tìm thấy upload của phiên học") from exc
    except ValueError as exc:
        status_code = 410 if "hết hạn" in str(exc).lower() else 403
        raise StudentWorkflowError(status_code, str(exc)) from exc
    try:
        assert_student_session_active(context_token, normalized_session_id, upload_id)
    except StudentSessionClientError as exc:
        raise StudentWorkflowError(exc.status_code, str(exc)) from exc
    return claims, normalized_session_id, upload_id


def _active_student_phase_session(
    *,
    session_id: str,
    context_token: str,
    required_scope: str,
    feature_flag: str,
    disabled_message: str,
) -> tuple[StudentContextClaims, str, str]:
    if not _student_phase_enabled(feature_flag):
        raise StudentWorkflowError(404, disabled_message)
    claims = _student_claims(context_token, required_scope)
    normalized_session_id = str(session_id or "").strip()
    if claims.session_id != normalized_session_id:
        raise StudentWorkflowError(403, "Student context không thuộc phiên này")
    try:
        upload_id = find_student_upload_id(claims)
    except StudentUploadConflictError as exc:
        raise StudentWorkflowError(409, str(exc)) from exc
    except KeyError as exc:
        raise StudentWorkflowError(404, "Không tìm thấy upload của phiên học") from exc
    except ValueError as exc:
        status_code = 410 if "hết hạn" in str(exc).lower() else 403
        raise StudentWorkflowError(status_code, str(exc)) from exc
    try:
        assert_student_session_active(
            context_token,
            normalized_session_id,
            upload_id,
            required_scope=required_scope,
        )
    except StudentSessionClientError as exc:
        raise StudentWorkflowError(exc.status_code, str(exc)) from exc
    return claims, normalized_session_id, upload_id


def _student_voucher_mode(target_template_id: str) -> str:
    normalized = str(target_template_id or "").strip().lower()
    if "purchase" in normalized:
        return "purchase"
    if "sales" in normalized or normalized == "bsn_sales":
        return "sales"
    return "auto"


def _student_default_provenance(
    mapping_source: str,
    defaults: dict[str, Any],
) -> dict[str, str]:
    normalized = str(mapping_source or "").strip().lower()
    if "ai" in normalized:
        source = "ai_suggestion"
    elif normalized in {"confirmed", "profile"}:
        source = "approved_profile"
    else:
        source = "deterministic_derived"
    return {str(field): source for field in defaults}


def _record_activity_best_effort(
    context_token: str,
    payload: dict[str, Any],
) -> None:
    try:
        record_activity_event(context_token, payload)
    except StudentSessionClientError:
        pass


def _anonymized_student_workbook(
    *,
    session_id: str,
    upload_id: str,
    full_document_numbers: bool,
) -> tuple[AnonymizedWorkbook, dict[str, list[Any]]]:
    try:
        metadata = _read_metadata(upload_id)
        input_path = Path(str(metadata.get("input_path") or ""))
        if not input_path.is_file():
            raise KeyError("Không tìm thấy workbook nguồn của phiên học")
        content = input_path.read_bytes()
        table = _read_upload_table(upload_id)
        sheet_name, header_row_index, headers = _analyzed_sheet_context(metadata)
        confidential_values = _student_confidential_values(table)
        exported = anonymize_workbook_bytes(
            filename=str(metadata.get("filename") or input_path.name),
            content=content,
            session=AnonymizationSession(
                session_id,
                _student_anonymization_secret(),
            ),
            confidential_values=confidential_values,
            full_document_numbers=full_document_numbers,
            analyzed_sheet_name=sheet_name,
            analyzed_header_row_index=header_row_index,
            analyzed_headers=headers,
        )
    except AnonymizationUnsupportedLayerError as exc:
        raise StudentWorkflowError(422, str(exc)) from exc
    except AnonymizationExportError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except OSError as exc:
        raise StudentWorkflowError(400, f"Không đọc được workbook nguồn: {exc}") from exc
    except ValueError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc

    safe_filename = f"student-anonymized{Path(exported.filename).suffix.lower()}"
    return (
        AnonymizedWorkbook(
            content=exported.content,
            filename=safe_filename,
            replaced_categories=exported.replaced_categories,
            warnings=exported.warnings,
            replaced_layers=exported.replaced_layers,
        ),
        confidential_values,
    )


def _analyzed_sheet_context(metadata: dict[str, Any]) -> tuple[str, int, list[str]]:
    signature = metadata.get("signature")
    if not isinstance(signature, dict):
        raise AnonymizationUnsupportedLayerError("analyzed_sheet_context")
    sheet_name = str(signature.get("sheet_name") or "").strip()
    header_row = signature.get("header_row")
    headers = signature.get("headers")
    if (
        not sheet_name
        or isinstance(header_row, bool)
        or not isinstance(header_row, int)
        or header_row < 1
        or not isinstance(headers, list)
    ):
        raise AnonymizationUnsupportedLayerError("analyzed_sheet_context")
    return sheet_name, header_row - 1, [str(header) for header in headers]


def _student_anonymization_secret() -> str:
    dedicated = os.getenv("STUDENT_ANONYMIZATION_SECRET", "").strip()
    if dedicated:
        return dedicated

    environment = os.getenv("NODE_ENV", "").strip().lower()
    allow_shared_fallback = (
        environment in {"development", "test"}
        and os.getenv("STUDENT_ANONYMIZATION_ALLOW_SHARED_SECRET_FALLBACK", "")
        .strip()
        .lower()
        in {"1", "true", "yes"}
    )
    secret = ""
    if allow_shared_fallback:
        secret = (
            os.getenv("CONVERSION_CONTEXT_SECRET")
            or os.getenv("JWT_SECRET")
            or ""
        ).strip()
    if not secret:
        raise ValueError("Student anonymization secret chưa được cấu hình")
    return secret


def assert_student_anonymization_config() -> None:
    environment = os.getenv("NODE_ENV", "").strip().lower()
    enabled = (
        os.getenv("STUDENT_ASSISTANT_ENABLED", "false").strip().lower()
        == "true"
    )
    if environment != "production" or not enabled:
        return

    secret = os.getenv("STUDENT_ANONYMIZATION_SECRET", "").strip()
    normalized_secret = secret.lower()
    unsafe_secret = (
        len(secret) < MIN_STUDENT_ANONYMIZATION_SECRET_CHARS
        or len(set(secret)) < MIN_UNIQUE_STUDENT_ANONYMIZATION_SECRET_CHARS
        or normalized_secret in _UNSAFE_STUDENT_ANONYMIZATION_SECRETS
        or normalized_secret.startswith(("default-", "replace-with-", "your-"))
        or "change_me_in_production" in normalized_secret
        or "change-me-in-production" in normalized_secret
        or (secret.startswith("<") and secret.endswith(">"))
    )
    if unsafe_secret:
        raise ValueError(
            "STUDENT_ANONYMIZATION_SECRET must be a high-entropy secret of at "
            "least 32 characters with at least 12 distinct characters, not an "
            "example or placeholder"
        )
    for forbidden_name in (
        "CONVERSION_CONTEXT_SECRET",
        "CONVERTER_SERVICE_TOKEN",
    ):
        forbidden = os.getenv(forbidden_name, "").strip()
        if forbidden and hmac.compare_digest(secret, forbidden):
            raise ValueError(
                f"STUDENT_ANONYMIZATION_SECRET must differ from {forbidden_name}"
            )


def _student_confidential_values(table: Any) -> dict[str, list[Any]]:
    fields: dict[str, str] = {}
    for header in list(getattr(table, "headers", None) or []):
        normalized = normalize_header(header)
        for category, markers in _CONFIDENTIAL_HEADER_MARKERS.items():
            if any(marker in normalized for marker in markers):
                fields[str(header)] = category
                break

    values: dict[str, list[Any]] = {}
    seen: dict[str, set[str]] = {}
    for row in list(getattr(table, "rows", None) or []):
        for header, category in fields.items():
            value = row.get(header)
            text = str(value or "").strip()
            if not text:
                continue
            canonical = text.casefold()
            category_seen = seen.setdefault(category, set())
            if canonical in category_seen:
                continue
            category_seen.add(canonical)
            values.setdefault(category, []).append(value)
    return values


def _replacement_count(
    confidential_values: dict[str, list[Any]],
    replaced_categories: tuple[str, ...],
) -> int:
    return sum(
        len(confidential_values.get(category) or [])
        for category in replaced_categories
    )


def _build_current_overview(
    *, upload_id: str, token: str, claims: StudentContextClaims
) -> dict[str, Any]:
    try:
        assert_upload_owner(upload_id, claims)
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except ValueError as exc:
        message = str(exc)
        status_code = 410 if "hết hạn" in message.lower() else 403
        raise StudentWorkflowError(status_code, message) from exc

    try:
        metadata = _read_metadata(upload_id)
        table = _read_upload_table(upload_id)
        workbook_structure, structure_issues = _student_workbook_structure(metadata)
        (
            target_template_id,
            mapping_source,
            mapping_identity,
            mapping,
            defaults,
            formulas,
        ) = _effective_mapping(metadata)
        template = get_misa_template(target_template_id)
        operation_state = _operation_state(metadata)
        preview = preview_mapping(
            upload_id=upload_id,
            target_template_id=target_template_id,
            mapping=mapping,
            defaults=defaults,
            formulas=formulas,
            student_context_token=token,
            **operation_state,
        )
        readiness = readiness_mapping(
            upload_id=upload_id,
            target_template_id=target_template_id,
            mapping=mapping,
            defaults=defaults,
            formulas=formulas,
            student_context_token=token,
            **operation_state,
        )
        readiness = _merge_student_structure_warnings(readiness, structure_issues)
    except KeyError as exc:
        raise StudentWorkflowError(404, str(exc)) from exc
    except ValueError as exc:
        raise StudentWorkflowError(400, str(exc)) from exc

    signature = metadata.get("signature") or {}
    state_hash = explanation_state_hash(
        session_id=claims.session_id,
        upload_id=upload_id,
        target_template_id=target_template_id,
        source_signature_hash=str(signature.get("hash") or ""),
        mapping_source=mapping_source,
        mapping_identity=mapping_identity,
        mapping=mapping,
        defaults=defaults,
        formulas=formulas,
    )
    explanations = build_student_explanations(
        session_id=claims.session_id,
        upload_id=upload_id,
        target_template_id=target_template_id,
        table=table,
        target_headers=template.headers,
        mapping_source=mapping_source,
        mapping=mapping,
        defaults=defaults,
        formulas=formulas,
        readiness=readiness,
        master_data=preview.get("master_data") or {},
        state_hash=state_hash,
    )
    summary = build_student_summary(
        session_id=claims.session_id,
        upload_id=upload_id,
        file_name=str(metadata.get("filename") or ""),
        target_template_id=target_template_id,
        table=table,
        target_headers=template.headers,
        mapping=mapping,
        defaults=defaults,
        formulas=formulas,
        preview=preview,
        readiness=readiness,
        explanation_count=len(explanations),
        state_hash=state_hash,
    )
    suggestion = {
        "source": mapping_source,
        "confidence": 1.0
        if mapping_source == "confirmed"
        else float((metadata.get("suggestion") or {}).get("confidence") or 0),
        "mapping": mapping,
        "defaults": defaults,
        "formulas": formulas,
        "warnings": list((metadata.get("suggestion") or {}).get("warnings") or []),
    }
    if (metadata.get("suggestion") or {}).get("profile_id"):
        suggestion["profile_id"] = metadata["suggestion"]["profile_id"]
    payload = {
        "upload_id": upload_id,
        "detected": {
            "sheet_name": str(signature.get("sheet_name") or table.sheet_name or ""),
            "header_row": int(signature.get("header_row") or table.header_row_index + 1),
            "row_count": int(signature.get("row_count") or len(table.rows)),
            "source_signature_hash": str(signature.get("hash") or ""),
            "headers": list(signature.get("headers") or table.headers),
        },
        "target_template_id": target_template_id,
        "target_headers": template.headers,
        "mapping_suggestion": suggestion,
        "issues": list(metadata.get("issues") or []),
        "master_data": preview.get("master_data") or {},
        "student_preview": {
            "headers": preview.get("headers") or template.headers,
            "rows": list(preview.get("rows") or [])[:MAX_STUDENT_PREVIEW_ROWS],
            "stats": preview.get("stats") or {},
            "issues": preview.get("issues") or [],
            "truncated": len(preview.get("rows") or []) > MAX_STUDENT_PREVIEW_ROWS,
        },
        "readiness": readiness,
        "workbook_structure": workbook_structure,
        "student_summary": summary.model_dump(mode="json"),
        "explanations": [item.model_dump(mode="json") for item in explanations],
        "student_state_hash": state_hash,
    }
    _write_overview_cache(upload_id, payload)
    return payload


def _student_workbook_structure(
    metadata: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    input_path = Path(str(metadata.get("input_path") or ""))
    structure = inspect_workbook_structure(input_path)
    safe_sheets = [
        {
            "name": str(sheet.get("name") or ""),
            "hidden_rows": [int(row) for row in (sheet.get("hidden_rows") or [])[:100]],
            "hidden_columns": [str(column) for column in (sheet.get("hidden_columns") or [])[:100]],
            "formula_cells": [str(cell) for cell in (sheet.get("formula_cells") or [])[:100]],
        }
        for sheet in (structure.get("sheets") or [])[:20]
    ]
    payload = {
        "format": str(structure.get("format") or ""),
        "formula_detection": str(structure.get("formula_detection") or "available"),
        "sheet_count": int(structure.get("sheet_count") or 0),
        "formula_cell_count": int(structure.get("formula_cell_count") or 0),
        "hidden_row_count": int(structure.get("hidden_row_count") or 0),
        "hidden_column_count": int(structure.get("hidden_column_count") or 0),
        "sheets": safe_sheets,
    }
    warning_messages = {
        str(item.get("code") or ""): str(item.get("message") or "")
        for item in structure.get("warnings") or []
    }
    issues: list[dict[str, Any]] = []
    if payload["formula_detection"] == "unavailable":
        issues.append(
            {
                "severity": "warning",
                "category": "workbook_structure",
                "code": "formula_detection_unavailable",
                "message": warning_messages.get("formula_detection_unavailable")
                or "Không thể xác định tin cậy ô công thức trong workbook .xls.",
                "fix_hint": "Mở workbook .xls trong Excel và kiểm tra các ô công thức trước khi dùng dữ liệu.",
                "evidence": [],
            }
        )
    if payload["formula_cell_count"]:
        issues.append(
            {
                "severity": "warning",
                "category": "workbook_structure",
                "code": "formula_cells_detected",
                "message": warning_messages.get("formula_cells_detected")
                or "Workbook có ô công thức và cần kiểm tra giá trị cached.",
                "fix_hint": "Đối chiếu công thức gốc và giá trị hiển thị trước khi dùng dữ liệu.",
                "evidence": _formula_structure_evidence(safe_sheets),
            }
        )
    if payload["hidden_row_count"] or payload["hidden_column_count"]:
        issues.append(
            {
                "severity": "warning",
                "category": "workbook_structure",
                "code": "hidden_rows_or_columns_detected",
                "message": warning_messages.get("hidden_rows_or_columns_detected")
                or "Workbook có dòng hoặc cột ẩn và cần được kiểm tra.",
                "fix_hint": "Mở các dòng/cột ẩn và xác nhận chúng có thuộc vùng dữ liệu hay không.",
                "evidence": _hidden_structure_evidence(safe_sheets),
            }
        )
    return payload, issues


def _formula_structure_evidence(sheets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for sheet in sheets:
        for coordinate in sheet["formula_cells"]:
            column, row = coordinate_from_string(coordinate)
            evidence.append(
                {
                    "kind": "source_cell",
                    "sheet": sheet["name"],
                    "row": int(row),
                    "column": str(column),
                    "source_ref": f"sheet:{sheet['name']}:cell:{coordinate}:formula",
                }
            )
            if len(evidence) >= 20:
                return evidence
    return evidence


def _hidden_structure_evidence(sheets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for sheet in sheets:
        for row in sheet["hidden_rows"]:
            evidence.append(
                {
                    "kind": "source_cell",
                    "sheet": sheet["name"],
                    "row": int(row),
                    "source_ref": f"sheet:{sheet['name']}:row:{row}:hidden",
                }
            )
        for column in sheet["hidden_columns"]:
            evidence.append(
                {
                    "kind": "source_column",
                    "sheet": sheet["name"],
                    "column": str(column),
                    "source_ref": f"sheet:{sheet['name']}:column:{column}:hidden",
                }
            )
        if len(evidence) >= 20:
            return evidence[:20]
    return evidence[:20]


def _merge_student_structure_warnings(
    readiness: dict[str, Any],
    structure_issues: list[dict[str, Any]],
) -> dict[str, Any]:
    if not structure_issues:
        return readiness
    summary = dict(readiness.get("summary") or {})
    summary["warning"] = int(summary.get("warning") or 0) + len(structure_issues)
    return {
        **readiness,
        "summary": summary,
        "issues": [*(readiness.get("issues") or []), *structure_issues],
    }


def _effective_mapping(
    metadata: dict[str, Any],
) -> tuple[str, str, str, dict[str, Any], dict[str, Any], dict[str, str]]:
    target_template_id = str(metadata.get("target_template_id") or "").strip()
    if not target_template_id:
        raise ValueError("Upload chưa có target template")
    confirmed = metadata.get("confirmed")
    if isinstance(confirmed, dict):
        return (
            target_template_id,
            "confirmed",
            str(metadata.get("profile_id") or "confirmed:inline"),
            dict(confirmed.get("mapping") or {}),
            dict(confirmed.get("defaults") or {}),
            {str(key): str(value) for key, value in (confirmed.get("formulas") or {}).items()},
        )
    suggestion = metadata.get("suggestion") or {}
    return (
        target_template_id,
        str(suggestion.get("source") or "heuristic"),
        str(
            suggestion.get("profile_id")
            or suggestion.get("source")
            or "heuristic"
        ),
        dict(suggestion.get("mapping") or {}),
        dict(suggestion.get("defaults") or {}),
        {str(key): str(value) for key, value in (suggestion.get("formulas") or {}).items()},
    )


def _analysis_completed_payload(overview: dict[str, Any]) -> dict[str, Any]:
    summary = overview["student_summary"]
    return {
        "event": "analysis_completed",
        "sessionId": summary["session_id"],
        "converterUploadId": overview["upload_id"],
        "targetTemplateId": overview["target_template_id"],
        "sourceSignatureHash": overview["detected"]["source_signature_hash"],
        "summary": {
            "dataRowCount": summary["data_row_count"],
            "documentCount": summary["document_count"],
            "recognizedColumns": summary["recognized_columns"],
            "unresolvedColumns": summary["unresolved_columns"],
            "mappingCounts": summary["mapping_counts"],
            "issueCounts": summary["issue_counts"],
            "masterDataStatus": summary["master_data_status"],
            "explanationCount": summary["explanation_count"],
            "stateHash": overview["student_state_hash"],
            "readinessStatus": overview["readiness"].get("status"),
        },
        "status": "analyzed",
    }


def _student_claims(token: str, required_scope: str) -> StudentContextClaims:
    if not _student_assistant_enabled():
        raise StudentWorkflowError(404, "Student assistant chưa được bật")
    if not str(token or "").strip():
        raise StudentWorkflowError(401, "Thiếu student context")
    try:
        return verify_student_context(token, required_scope)
    except ValueError as exc:
        raise StudentWorkflowError(401, str(exc)) from exc


def _student_assistant_enabled() -> bool:
    return all(
        os.getenv(name, "false").strip().lower() == "true"
        for name in ("STUDENT_ASSISTANT_ENABLED", "STUDENT_FILE_EXPLAIN_ENABLED")
    )


def _student_question_enabled() -> bool:
    return _student_assistant_enabled() and (
        os.getenv("STUDENT_FILE_QA_ENABLED", "false").strip().lower() == "true"
    )


def _student_phase_enabled(flag_name: str) -> bool:
    return _student_assistant_enabled() and (
        os.getenv(flag_name, "false").strip().lower() == "true"
    )


def _student_ai_available() -> bool:
    return os.getenv("AI_PROVIDER", "disabled").strip().lower() not in {
        "",
        "disabled",
        "none",
        "off",
    }


def _overview_path(upload_id: str) -> Path:
    metadata = _read_metadata(upload_id)
    input_path = Path(str(metadata.get("input_path") or ""))
    return input_path.parent / OVERVIEW_FILENAME


def _write_overview_cache(upload_id: str, payload: dict[str, Any]) -> None:
    path = _overview_path(upload_id)
    temporary = path.with_suffix(".tmp")
    safe_payload = _safe_overview_cache(payload)
    temporary.write_text(
        json.dumps(
            jsonable_encoder(safe_payload),
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    temporary.replace(path)


def _safe_overview_cache(payload: dict[str, Any]) -> dict[str, Any]:
    detected = payload.get("detected") or {}
    summary = payload.get("student_summary") or {}
    return {
        "cache_version": 2,
        "upload_id": str(payload.get("upload_id") or ""),
        "student_state_hash": str(payload.get("student_state_hash") or ""),
        "target_template_id": str(payload.get("target_template_id") or ""),
        "schema": {
            "source_headers": list(detected.get("headers") or []),
            "target_headers": list(payload.get("target_headers") or []),
        },
        "counts": {
            "data_row_count": int(summary.get("data_row_count") or 0),
            "document_count": summary.get("document_count"),
            "recognized_columns": int(summary.get("recognized_columns") or 0),
            "unresolved_columns": int(summary.get("unresolved_columns") or 0),
            "mapping_counts": dict(summary.get("mapping_counts") or {}),
            "issue_counts": dict(summary.get("issue_counts") or {}),
            "explanation_count": int(summary.get("explanation_count") or 0),
        },
        "anonymized_metadata": {
            "file_label": "student-workbook",
            "sheet_label": "Sheet1",
            "source_signature_hash": str(detected.get("source_signature_hash") or ""),
        },
    }


def _decimal_number(value) -> int | float:
    return int(value) if value == value.to_integral() else float(value)
