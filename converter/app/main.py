from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
import hmac
import hashlib
from pathlib import Path
from typing import Annotated

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass  # python-dotenv not installed, rely on system env vars

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from app.ai_assistant import explain_validation_report, suggest_mapping_for_file
from app.accounting_assistant import (
    AccountingAssistantFeatureDisabledError,
    ask_accounting_question,
)
from app.anomaly_workflow import (
    AnomalyFeatureDisabledError,
    detect_anomalies,
    get_anomalies,
    review_anomaly,
)
from app.calculation_rules import allow_calculation_warnings, has_calculation_warnings
from app.correction_workflow import (
    CorrectionFeatureDisabledError,
    apply_corrections,
    propose_corrections,
    simulate_corrections,
    undo_corrections,
)
from app.conversion_types import BACKEND_ROOT, CONVERSION_TYPES
from app.converter import convert_file, preview_file, validate_file
from app.document_structure import validate_excel_magic
from app.error_check import check_file_for_errors
from app.excel_io import InputReadError
from app.import_repair_export import RetryBlockedError
from app.import_result_models import ImportResultSchemaError
from app.import_result_workflow import (
    analyze_import_result,
    build_bound_retry_readiness,
    export_bound_retry_workbook,
    normalize_bound_import_result,
)
from app.misa_workflow import (
    EXPORT_MEDIA_TYPE,
    ReadinessGateError,
    analyze_upload,
    cleanup_expired_uploads,
    confirm_mapping,
    export_confirmed_profile,
    manifest_for_confirmed_profile,
    preview_mapping,
    purge_student_raw_state,
    readiness_mapping,
    _read_metadata as _read_upload_metadata,
    sync_mapping_session,
    templates_payload,
)
from app.internal_auth import (
    assert_secure_production_config,
    bind_local_mode_request,
    require_internal_service,
    reset_local_mode_request,
)
from app.master_data import parse_master_data_file
from app.master_data_client import ConversionContextError
from app.master_data_client import (
    conversion_context_owner_scope,
    verify_conversion_context_token,
)
from app.mapping_profile_v2 import MappingProfileV2Error
from app.models import ExportManifestV1, PreviewResponse, ValidationReport
from app.operation_store import (
    OperationStore,
    OperationStoreConflictError,
    OperationStoreError,
    OperationStoreExpiredError,
    assert_operation_store_configured,
    cleanup_expired_operation_sessions,
    operation_context_required,
    unauthenticated_local_operations_enabled,
)
from app.reconstruction_store import ReconstructionStoreError
from app.reconstruction_workflow import (
    ReconstructionConflictError,
    ReconstructionGateError,
    analyze_reconstruction,
    approve_reconstruction,
    export_reconstruction,
    get_reconstruction,
    get_reconstruction_draft,
    merge_reconstruction_drafts,
    split_reconstruction_draft,
    update_reconstruction_draft,
    validate_reconstruction,
)
from app.reconciliation_workflow_v2 import (
    ReconciliationFeatureDisabledError,
    add_comparison_file,
    confirm_candidate_match,
    get_reconciliation_report,
    remove_comparison_file,
    run_reconciliation,
)
from app.student_store import cleanup_expired_student_uploads
from app.student_context import StudentContextClaims, verify_student_context
from app.student_models import (
    StudentAnonymizationRequest,
    StudentInternshipReportRequest,
    StudentQuestionRequest,
)
from app.student_workflow import (
    StudentWorkflowError,
    analyze_student_file,
    ask_student_question,
    build_student_internship_report,
    export_student_anonymized_workbook,
    get_student_accounting_map,
    get_student_overview,
    get_student_reconciliation,
    get_student_source_row,
    preview_student_anonymization,
    assert_student_anonymization_config,
)


app = FastAPI(title="EzFormat Converter API")
INTERNAL_SERVICE_DEPENDENCIES = [Depends(require_internal_service)]
_RECONSTRUCTION_RATE_LOCK = threading.Lock()
_RECONSTRUCTION_RATE_BUCKETS: dict[str, tuple[float, int]] = {}
_STUDENT_RATE_LOCK = threading.Lock()
_STUDENT_RATE_BUCKETS: dict[str, tuple[float, int]] = {}
_STUDENT_CLEANUP_LOCK = threading.Lock()
_LAST_STUDENT_CLEANUP = 0.0


def _opportunistic_student_cleanup(*, force: bool = False) -> None:
    global _LAST_STUDENT_CLEANUP
    try:
        interval_seconds = max(
            1,
            int(os.getenv("STUDENT_UPLOAD_CLEANUP_INTERVAL_SECONDS", "300")),
        )
    except ValueError:
        interval_seconds = 300
    now = time.monotonic()
    with _STUDENT_CLEANUP_LOCK:
        if not force and now - _LAST_STUDENT_CLEANUP < interval_seconds:
            return
        _LAST_STUDENT_CLEANUP = now
    cleanup_expired_student_uploads()
    cleanup_expired_uploads()
    cleanup_expired_operation_sessions()


async def _cleanup_student_uploads_at_startup() -> None:
    await run_in_threadpool(_opportunistic_student_cleanup, force=True)


app.router.add_event_handler("startup", _cleanup_student_uploads_at_startup)


@app.middleware("http")
async def attach_request_id(request: Request, call_next):
    local_mode_token = bind_local_mode_request(request)
    try:
        await run_in_threadpool(_opportunistic_student_cleanup)
        supplied = str(request.headers.get("x-request-id") or "").strip()
        request_id = supplied[:128] if supplied else uuid.uuid4().hex
        request.state.request_id = request_id
        if request.url.path.startswith("/api/") and request.url.path != "/healthz":
            try:
                require_internal_service(
                    request,
                    request.headers.get("x-converter-service-token"),
                )
            except HTTPException as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        reset_local_mode_request(local_mode_token)


@app.router.on_event("startup")
def _assert_converter_security_config() -> None:
    assert_secure_production_config()
    assert_operation_store_configured()
    assert_student_anonymization_config()


def _sanitize_validation_payload(value):
    if isinstance(value, bytes):
        return "<binary>"
    if isinstance(value, dict):
        return {key: _sanitize_validation_payload(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_validation_payload(item) for item in value]
    return value


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"detail": _sanitize_validation_payload(exc.errors())},
    )


def _get_cors_origins() -> list[str]:
    """Read allowed origins from CORS_ORIGINS env var (comma-separated).
    Use CORS_ORIGINS=* to allow all origins (e.g. when tunnelling via ngrok).
    """
    extra = os.getenv("CORS_ORIGINS", "").strip()
    if extra == "*":
        return ["*"]
    origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
    if extra:
        origins += [o.strip() for o in extra.split(",") if o.strip()]
    return origins


app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Request-ID"],
)

TMP_ROOT = BACKEND_ROOT / ".tmp"
SUPPORTED_SUFFIXES = {".xls", ".xlsx"}
EXCEL_MEDIA_TYPE = "application/vnd.ms-excel"


@app.get("/healthz")
def healthz() -> dict[str, object]:
    ai_provider = os.getenv("AI_PROVIDER", "disabled").strip().lower()
    ai_status = "disabled" if ai_provider == "disabled" else _ai_runtime_status()
    return {
        "status": "ok",
        "ai": ai_status,
        "capabilities": {
            "converter": True,
            "operations": True,
            "voucherReconstruction": _env_enabled("VOUCHER_RECONSTRUCTION_ENABLED"),
            "studentAssistant": _env_enabled("STUDENT_ASSISTANT_ENABLED"),
            "studentFileExplain": _env_enabled("STUDENT_FILE_EXPLAIN_ENABLED"),
            "studentFileQa": _env_enabled("STUDENT_FILE_QA_ENABLED"),
            "studentAccountingMap": _env_enabled("STUDENT_ACCOUNTING_MAP_ENABLED"),
            "studentReconciliation": _env_enabled("STUDENT_RECONCILIATION_ENABLED"),
            "studentInternship": _env_enabled("STUDENT_INTERNSHIP_ENABLED"),
        },
    }


@app.get("/api/v1/templates")
def templates() -> JSONResponse:
    return JSONResponse(jsonable_encoder(templates_payload()))


@app.get("/api/v1/conversion-types")
def conversion_types() -> dict[str, list[dict[str, str]]]:
    return {
        "items": [
            {"id": definition.id, "label": definition.label, "kind": definition.kind}
            for definition in CONVERSION_TYPES.values()
        ]
    }


@app.post("/api/v1/import-results/analyze", dependencies=INTERNAL_SERVICE_DEPENDENCIES)
async def analyze_import_result_workbook(
    file: Annotated[UploadFile, File()],
) -> JSONResponse:
    filename, content = await _read_limited_import_result_upload(file)
    _acquire_import_result_parse_slot()
    try:
        try:
            inspection = await run_in_threadpool(
                analyze_import_result,
                content=content,
                filename=filename,
            )
        except ImportResultSchemaError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        _IMPORT_RESULT_PARSE_SLOTS.release()
    return JSONResponse(inspection.model_dump(mode="json"))


@app.post("/api/v1/import-results/normalize", dependencies=INTERNAL_SERVICE_DEPENDENCIES)
async def normalize_import_result_workbook(
    file: Annotated[UploadFile, File()],
    mapping_json: Annotated[str, Form()],
) -> JSONResponse:
    filename, content = await _read_limited_import_result_upload(file)
    try:
        mapping = json.loads(mapping_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="mapping_json must be valid JSON.") from exc
    if not isinstance(mapping, dict):
        raise HTTPException(status_code=400, detail="mapping_json must be a JSON object.")
    _acquire_import_result_parse_slot()
    try:
        try:
            issues = await run_in_threadpool(
                normalize_bound_import_result,
                content=content,
                filename=filename,
                mapping=mapping,
            )
        except ImportResultSchemaError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        _IMPORT_RESULT_PARSE_SLOTS.release()
    return JSONResponse(
        {
            "issues": [issue.model_dump(mode="json") for issue in issues],
            "requires_user_confirmation": True,
            "retry_allowed": False,
        }
    )


@app.post("/api/v1/import-repairs/readiness", dependencies=INTERNAL_SERVICE_DEPENDENCIES)
async def readiness_import_repair(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    context_token, _ = _conversion_context_for_request(
        x_conversion_context,
        body.get("conversion_context_token"),
        required_scope="export",
        upload_id=body.get("upload_id"),
        session_id=body.get("session_id"),
        target_template_id=body.get("target_template_id"),
        conversion_run_id=body.get("conversion_run_id"),
    )
    try:
        payload = await run_in_threadpool(
            build_bound_retry_readiness,
            body=body,
            context_token=str(context_token or ""),
        )
    except (RetryBlockedError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return JSONResponse(jsonable_encoder(payload))


@app.post(
    "/api/v1/import-repairs/export",
    response_model=None,
    dependencies=INTERNAL_SERVICE_DEPENDENCIES,
)
async def export_import_repair(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> Response:
    context_token, _ = _conversion_context_for_request(
        x_conversion_context,
        body.get("conversion_context_token"),
        required_scope="export",
        upload_id=body.get("upload_id"),
        session_id=body.get("session_id"),
        target_template_id=body.get("target_template_id"),
        conversion_run_id=body.get("conversion_run_id"),
    )
    try:
        content, filename = await run_in_threadpool(
            export_bound_retry_workbook,
            body=body,
            context_token=str(context_token or ""),
        )
    except (RetryBlockedError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(
        content=content,
        media_type=EXPORT_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/v1/master-data/parse")
async def parse_master_data_upload(
    file: Annotated[UploadFile, File()],
    catalog_type: Annotated[str, Form()],
    x_converter_service_token: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    expected_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if expected_token and not hmac.compare_digest(
        x_converter_service_token or "", expected_token
    ):
        raise HTTPException(status_code=401, detail="Service token không hợp lệ")
    workdir = _create_workdir()
    try:
        input_path = await _save_upload(file, workdir)
        payload = await run_in_threadpool(
            parse_master_data_file,
            input_path,
            catalog_type,
        )
        return JSONResponse(jsonable_encoder(payload))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


@app.post("/api/v1/uploads/analyze")
async def analyze_raw_upload(
    file: Annotated[UploadFile, File()],
    target_template_id: Annotated[str | None, Form()] = None,
    conversion_run_id: Annotated[str | None, Form()] = None,
    operation_session_id: Annotated[str | None, Form()] = None,
    upload_id: Annotated[str | None, Form()] = None,
    conversion_context_token: Annotated[str | None, Form()] = None,
    student_context_token: Annotated[str | None, Form()] = None,
    use_ai: Annotated[bool, Form()] = False,
    ai_mapping_opt_in: Annotated[bool, Form()] = False,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        if student_context_token:
            raise HTTPException(
                status_code=401,
                detail="Student context không hợp lệ cho conversion route",
            )
        context_token, claims = _conversion_context_for_request(
            x_conversion_context,
            conversion_context_token,
            required_scope="analyze",
            upload_id=upload_id,
            session_id=operation_session_id,
            target_template_id=target_template_id,
            conversion_run_id=conversion_run_id,
        )
        claimed_session_id = str((claims or {}).get("operation_session_id") or "").strip()
        supplied_session_id = str(operation_session_id or "").strip()
        if operation_context_required() and (
            not claimed_session_id or not supplied_session_id
        ):
            raise HTTPException(
                status_code=409,
                detail="operation_session_id là bắt buộc trong production",
            )
        claimed_run_id = str((claims or {}).get("conversion_run_id") or "").strip()
        supplied_run_id = str(conversion_run_id or "").strip()
        claimed_upload_id = str((claims or {}).get("upload_id") or "").strip()
        supplied_upload_id = str(upload_id or "").strip()
        if bool(claimed_session_id) != bool(supplied_session_id) or (
            claimed_session_id
            and not hmac.compare_digest(claimed_session_id, supplied_session_id)
        ):
            raise HTTPException(
                status_code=409,
                detail="operation_session_id không khớp conversion context",
            )
        if claimed_session_id and (
            not supplied_run_id
            or not hmac.compare_digest(claimed_run_id, supplied_run_id)
        ):
            raise HTTPException(
                status_code=409,
                detail="conversion_run_id không khớp conversion context",
            )
        if claimed_session_id and (
            not supplied_upload_id
            or not hmac.compare_digest(claimed_upload_id, supplied_upload_id)
        ):
            raise HTTPException(
                status_code=409,
                detail="upload_id không khớp conversion context",
            )
        effective_target_template_id = target_template_id or (
            str((claims or {}).get("target_template_id") or "") or None
        )
        content = await read_upload_with_limit(file, _max_upload_bytes(claims))
        payload = await run_in_threadpool(
            analyze_upload,
            filename=file.filename or "upload.xlsx",
            content=content,
            requested_target_template_id=effective_target_template_id,
            conversion_context_token=context_token,
            operation_session_id=supplied_session_id or None,
            conversion_run_id=supplied_run_id or None,
            preallocated_upload_id=supplied_upload_id or None,
            student_context_token=None,
            use_ai=use_ai,
            ai_mapping_opt_in=ai_mapping_opt_in
            or bool((claims or {}).get("ai_mapping_opt_in")),
        )
        return JSONResponse(jsonable_encoder(payload))
    except InputReadError as exc:
        message = exc.message
        if exc.code == "corrupt_xlsx":
            message = (
                "Không thể đọc file Excel. File có thể bị hỏng hoặc không đúng "
                "định dạng .xlsx."
            )
        raise HTTPException(
            status_code=422,
            detail={"code": exc.code, "message": message},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/student/sessions/analyze")
async def analyze_student_session(
    file: Annotated[UploadFile, File()],
    context_token: Annotated[str, Form()],
    target_template_id: Annotated[str | None, Form()] = None,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        rate_claims = _verified_student_rate_claims(context_token, "analyze")
        _check_student_rate_limit(
            _student_rate_key("analyze", rate_claims),
            limit=_positive_env_int("STUDENT_ANALYZE_LIMIT_PER_15_MINUTES", 5),
        )
        content = await _read_limited_student_upload(file)
        payload = await run_in_threadpool(
            analyze_student_file,
            filename=file.filename or "upload.xlsx",
            content=content,
            context_token=context_token,
            target_template_id=target_template_id,
            operation_context_token=x_conversion_context,
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.delete(
    "/api/v1/student/sessions/{session_id}/purge",
    dependencies=INTERNAL_SERVICE_DEPENDENCIES,
)
async def purge_student_session_state(
    session_id: str,
    x_conversion_context: Annotated[str | None, Header()] = None,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    student_claims = _verified_student_rate_claims(
        x_student_context or "",
        "analyze",
        session_id,
    )
    context_token, _ = _conversion_context_for_request(
        x_conversion_context,
        required_scope="analyze",
        session_id=session_id,
        conversion_run_id=f"student:{session_id}",
    )
    try:
        payload = await run_in_threadpool(
            purge_student_raw_state,
            session_id=session_id,
            student_claims=student_claims,
            conversion_context_token=str(context_token or ""),
        )
    except (ConversionContextError, OperationStoreError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return JSONResponse(jsonable_encoder(payload))


@app.get("/api/v1/student/sessions/{session_id}/overview")
async def student_session_overview(
    session_id: str,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            get_student_overview,
            session_id=session_id,
            context_token=x_student_context or "",
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.get("/api/v1/student/sessions/{session_id}/accounting-map")
async def student_session_accounting_map(
    session_id: str,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            get_student_accounting_map,
            session_id=session_id,
            context_token=x_student_context or "",
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.get("/api/v1/student/sessions/{session_id}/reconciliation")
async def student_session_reconciliation(
    session_id: str,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            get_student_reconciliation,
            session_id=session_id,
            context_token=x_student_context or "",
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/api/v1/student/sessions/{session_id}/anonymization/preview")
async def student_session_anonymization_preview(
    session_id: str,
    request: StudentAnonymizationRequest,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        rate_claims = _verified_student_rate_claims(
            x_student_context or "", "export", session_id
        )
        _check_student_rate_limit(
            _student_rate_key("anonymization", rate_claims),
            limit=_positive_env_int(
                "STUDENT_ANONYMIZATION_LIMIT_PER_15_MINUTES",
                20,
            ),
        )
        payload = await run_in_threadpool(
            preview_student_anonymization,
            session_id=session_id,
            context_token=x_student_context or "",
            full_document_numbers=request.full_document_numbers,
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/api/v1/student/sessions/{session_id}/anonymization/export")
async def student_session_anonymization_export(
    session_id: str,
    request: StudentAnonymizationRequest,
    x_student_context: Annotated[str | None, Header()] = None,
) -> Response:
    try:
        rate_claims = _verified_student_rate_claims(
            x_student_context or "", "export", session_id
        )
        _check_student_rate_limit(
            _student_rate_key("export", rate_claims),
            limit=_positive_env_int("STUDENT_EXPORT_LIMIT_PER_15_MINUTES", 10),
        )
        exported = await run_in_threadpool(
            export_student_anonymized_workbook,
            session_id=session_id,
            context_token=x_student_context or "",
            full_document_numbers=request.full_document_numbers,
        )
        media_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if exported.filename.lower().endswith(".xlsx")
            else EXPORT_MEDIA_TYPE
        )
        return Response(
            content=exported.content,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="{exported.filename}"',
                "X-Anonymization-Scanner": "passed",
            },
        )
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/api/v1/student/sessions/{session_id}/internship-report")
async def student_session_internship_report(
    session_id: str,
    request: StudentInternshipReportRequest,
    x_student_context: Annotated[str | None, Header()] = None,
) -> Response:
    try:
        rate_claims = _verified_student_rate_claims(
            x_student_context or "", "export", session_id
        )
        _check_student_rate_limit(
            _student_rate_key("report", rate_claims),
            limit=_positive_env_int("STUDENT_REPORT_LIMIT_PER_15_MINUTES", 10),
        )
        report = await run_in_threadpool(
            build_student_internship_report,
            session_id=session_id,
            context_token=x_student_context or "",
            activity_ids=request.activity_ids,
            approved_notes=request.approved_notes,
        )
        return Response(
            content=report.encode("utf-8"),
            media_type="text/markdown",
            headers={
                "Content-Disposition": 'attachment; filename="internship-handoff.md"',
            },
        )
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/api/v1/student/sessions/{session_id}/questions")
async def student_session_question(
    session_id: str,
    request: StudentQuestionRequest,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        rate_claims = _verified_student_rate_claims(
            x_student_context or "", "ask", session_id
        )
        _check_student_rate_limit(
            _student_rate_key("question", rate_claims),
            limit=_positive_env_int("STUDENT_QUESTION_LIMIT_PER_15_MINUTES", 60),
        )
        payload = await run_in_threadpool(
            ask_student_question,
            session_id=session_id,
            context_token=x_student_context or "",
            question=request.question,
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.get("/api/v1/student/sessions/{session_id}/source-rows/{worksheet_row}")
async def student_session_source_row(
    session_id: str,
    worksheet_row: int,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            get_student_source_row,
            session_id=session_id,
            worksheet_row=worksheet_row,
            context_token=x_student_context or "",
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post("/api/v1/reconstructions/analyze")
async def analyze_voucher_reconstruction(
    file: Annotated[UploadFile, File()],
    context_token: Annotated[str, Form()],
    mode: Annotated[str, Form()] = "auto",
    target_template_id: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    try:
        _check_reconstruction_rate_limit(
            "analyze:" + hashlib.sha256(context_token.encode("utf-8")).hexdigest(),
            limit=max(
                1,
                int(os.getenv("RECONSTRUCTION_ANALYZE_LIMIT_PER_15_MINUTES", "5")),
            ),
        )
        content = await _read_limited_reconstruction_upload(file)
        payload = await run_in_threadpool(
            analyze_reconstruction,
            filename=file.filename or "upload.xlsx",
            content=content,
            context_token=context_token,
            mode=mode,
            target_template_id=target_template_id,
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/v1/reconstructions/{reconstruction_id}")
async def get_voucher_reconstruction(
    reconstruction_id: str,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            get_reconstruction,
            reconstruction_id,
            context_token=x_reconstruction_context or "",
            page=page,
            limit=limit,
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReconstructionStoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/v1/reconstructions/{reconstruction_id}/drafts/{draft_id}")
async def get_voucher_reconstruction_draft(
    reconstruction_id: str,
    draft_id: str,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            get_reconstruction_draft,
            reconstruction_id,
            draft_id,
            context_token=x_reconstruction_context or "",
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (KeyError, ReconstructionStoreError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.patch("/api/v1/reconstructions/{reconstruction_id}/drafts/{draft_id}")
async def patch_voucher_reconstruction_draft(
    reconstruction_id: str,
    draft_id: str,
    body: dict,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            update_reconstruction_draft,
            reconstruction_id,
            draft_id,
            context_token=x_reconstruction_context or "",
            expected_revision=int(body.get("expected_revision") or 0),
            operations=body.get("operations") or [],
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (ReconstructionStoreError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/reconstructions/{reconstruction_id}/split")
async def split_voucher_reconstruction(
    reconstruction_id: str,
    body: dict,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            split_reconstruction_draft,
            reconstruction_id,
            context_token=x_reconstruction_context or "",
            draft_id=str(body.get("draft_id") or ""),
            expected_revision=int(body.get("expected_revision") or 0),
            source_rows=body.get("source_rows") or [],
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (ReconstructionStoreError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/reconstructions/{reconstruction_id}/merge")
async def merge_voucher_reconstruction(
    reconstruction_id: str,
    body: dict,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            merge_reconstruction_drafts,
            reconstruction_id,
            context_token=x_reconstruction_context or "",
            draft_ids=body.get("draft_ids") or [],
            expected_revisions=body.get("expected_revisions") or {},
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ReconstructionStoreError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/reconstructions/{reconstruction_id}/validate")
async def validate_voucher_reconstruction(
    reconstruction_id: str,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            validate_reconstruction,
            reconstruction_id,
            context_token=x_reconstruction_context or "",
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReconstructionStoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/reconstructions/{reconstruction_id}/approve")
async def approve_voucher_reconstruction(
    reconstruction_id: str,
    body: dict,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            approve_reconstruction,
            reconstruction_id,
            context_token=x_reconstruction_context or "",
            acknowledge_warnings=bool(body.get("acknowledge_warnings")),
        )
        return JSONResponse(jsonable_encoder(payload))
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReconstructionGateError as exc:
        return JSONResponse(status_code=422, content=jsonable_encoder(exc.validation))
    except ReconstructionStoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/reconstructions/{reconstruction_id}/export")
async def export_voucher_reconstruction(
    reconstruction_id: str,
    body: dict,
    x_reconstruction_context: Annotated[str | None, Header()] = None,
    idempotency_key: Annotated[str | None, Header()] = None,
) -> Response:
    try:
        _check_reconstruction_rate_limit(
            f"export:{reconstruction_id}",
            limit=max(
                1,
                int(os.getenv("RECONSTRUCTION_EXPORT_LIMIT_PER_15_MINUTES", "20")),
            ),
        )
        content, filename, media_type = await run_in_threadpool(
            export_reconstruction,
            reconstruction_id,
            context_token=x_reconstruction_context or "",
            acknowledge_warnings=bool(body.get("acknowledge_warnings")),
            idempotency_key=idempotency_key or "",
        )
        return Response(
            content=content,
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    except ReconstructionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReconstructionGateError as exc:
        return JSONResponse(status_code=422, content=jsonable_encoder(exc.validation))
    except ReconstructionStoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/mappings/preview")
async def preview_misa_mapping(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        context_token = _mapping_operation_context(
            body,
            x_conversion_context,
            required_scope="preview",
        )
        payload = await run_in_threadpool(
            preview_mapping,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            conversion_context_token=context_token,
            student_context_token=None,
            session_id=body.get("session_id"),
            revision=body.get("revision"),
            state_hash=body.get("state_hash"),
        )
        return JSONResponse(jsonable_encoder(payload))
    except OperationStoreConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OperationStoreExpiredError as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/mappings/readiness")
@app.post("/api/v1/mappings/validate")
async def readiness_misa_mapping(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        context_token = _mapping_operation_context(
            body,
            x_conversion_context,
            required_scope="readiness",
        )
        edited_rows = body.get("rows")
        payload = await run_in_threadpool(
            readiness_mapping,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            edited_rows=edited_rows if isinstance(edited_rows, list) else None,
            conversion_context_token=context_token,
            student_context_token=None,
            session_id=body.get("session_id"),
            revision=body.get("revision"),
            state_hash=body.get("state_hash"),
        )
        return JSONResponse(jsonable_encoder(payload))
    except OperationStoreConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OperationStoreExpiredError as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/mappings/confirm")
async def confirm_misa_mapping(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        context_token = _mapping_operation_context(
            body,
            x_conversion_context,
            required_scope="confirm",
        )
        payload = await run_in_threadpool(
            confirm_mapping,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            profile_name=body.get("profile_name"),
            conversion_context_token=context_token,
            session_id=body.get("session_id"),
            revision=body.get("revision"),
            state_hash=body.get("state_hash"),
        )
        return JSONResponse(jsonable_encoder(payload))
    except OperationStoreConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/conversions/validate")
async def validate_conversion(
    conversion_type: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    options: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    option_payload = _parse_options(options)
    workdir = _create_workdir()
    try:
        input_path = await _save_upload(file, workdir)
        report = await run_in_threadpool(validate_file, input_path, conversion_type, option_payload)
        return JSONResponse(report.model_dump(mode="json"))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


@app.post("/api/v1/conversions/preview")
async def preview_conversion(
    conversion_type: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    options: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    option_payload = _parse_options(options)
    workdir = _create_workdir()
    try:
        input_path = await _save_upload(file, workdir)
        headers, rows, report = await run_in_threadpool(
            preview_file,
            input_path,
            conversion_type,
            option_payload,
        )
        if not report.ok:
            return JSONResponse(status_code=422, content=report.model_dump(mode="json"))
        if has_calculation_warnings(report) and not allow_calculation_warnings(option_payload):
            return JSONResponse(status_code=422, content=report.model_dump(mode="json"))
        payload = PreviewResponse(headers=headers, rows=rows, report=report)
        return JSONResponse(payload.model_dump(mode="json"))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


@app.post("/api/v1/exports/manifest", dependencies=INTERNAL_SERVICE_DEPENDENCIES)
async def create_export_manifest(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> ExportManifestV1:
    upload_id = str(body.get("upload_id") or "").strip()
    profile_id = str(body.get("profile_id") or "").strip()
    conversion_run_id = str(body.get("conversion_run_id") or "").strip()
    export_batch_id = str(body.get("export_batch_id") or "").strip()
    if not upload_id or not profile_id or not conversion_run_id or not export_batch_id:
        raise HTTPException(status_code=400, detail="Manifest thiếu export binding")

    context_token, initial_claims = _conversion_context_for_request(
        x_conversion_context,
        body.get("conversion_context_token"),
        required_scope="export",
    )
    try:
        binding = _read_export_binding(
            upload_id,
            conversion_context_token=context_token,
            claims=initial_claims,
        )
    except OperationStoreConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OperationStoreExpiredError as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except (KeyError, OperationStoreError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    target_template_id = str(
        body.get("target_template_id") or binding["target_template_id"]
    ).strip()
    session_id = str(
        body.get("session_id") or binding.get("operation_session_id") or ""
    ).strip() or None
    context_token, claims = _conversion_context_for_request(
        x_conversion_context,
        context_token,
        required_scope="export",
        upload_id=upload_id,
        session_id=session_id,
        target_template_id=target_template_id,
        conversion_run_id=conversion_run_id,
    )
    _assert_export_binding(
        upload_id=upload_id,
        profile_id=profile_id,
        requested_target_template_id=body.get("target_template_id"),
        requested_session_id=body.get("session_id"),
        requested_conversion_run_id=conversion_run_id,
        binding=binding,
        claims=claims,
    )
    try:
        return await run_in_threadpool(
            manifest_for_confirmed_profile,
            upload_id=upload_id,
            profile_id=profile_id,
            context_token=context_token,
            conversion_id=conversion_run_id,
            export_batch_id=export_batch_id,
            edited_rows=None,
            acknowledge_warnings=bool(body.get("acknowledge_warnings")),
            session_id=body.get("session_id"),
            revision=body.get("revision"),
            state_hash=body.get("state_hash"),
            requested_profile_version=body.get("profile_version"),
            requested_profile_state_hash=body.get("profile_state_hash"),
            vat_basis=body.get("vat_basis"),
        )
    except OperationStoreConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OperationStoreExpiredError as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReadinessGateError as exc:
        raise HTTPException(
            status_code=422,
            detail=jsonable_encoder(exc.report.model_dump(mode="json")),
        ) from exc
    except MappingProfileV2Error as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/conversions/export", response_model=None)
async def export_conversion(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> Response:
    context_token, initial_claims = _conversion_context_for_request(
        x_conversion_context,
        body.get("conversion_context_token"),
        required_scope="export",
    )
    if "rows" in body:
        raise HTTPException(
            status_code=422,
            detail="Client-provided rows are not accepted by the canonical export endpoint.",
        )
    if not all(
        str(body.get(field) or "").strip() for field in ("upload_id", "profile_id")
    ):
        raise HTTPException(
            status_code=422,
            detail="Canonical export requires bound upload_id and profile_id values.",
        )
    if "upload_id" in body and "profile_id" in body:
        upload_id = str(body["upload_id"] or "").strip()
        try:
            binding = _read_export_binding(
                upload_id,
                conversion_context_token=context_token,
                claims=initial_claims,
            )
        except OperationStoreConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except OperationStoreExpiredError as exc:
            raise HTTPException(status_code=410, detail=str(exc)) from exc
        except (KeyError, OperationStoreError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        effective_target_template_id = str(
            body.get("target_template_id") or binding["target_template_id"]
        ).strip()
        effective_session_id = str(
            body.get("session_id") or binding.get("operation_session_id") or ""
        ).strip() or None
        requested_run_id = str(body.get("conversion_run_id") or "").strip()
        if not requested_run_id:
            raise HTTPException(
                status_code=409,
                detail="Export thiếu conversion_run_id binding",
            )
        context_token, claims = _conversion_context_for_request(
            x_conversion_context,
            context_token,
            required_scope="export",
            upload_id=upload_id,
            session_id=effective_session_id,
            target_template_id=effective_target_template_id,
            conversion_run_id=requested_run_id,
        )
        _assert_export_binding(
            upload_id=upload_id,
            profile_id=str(body["profile_id"]),
            requested_target_template_id=body.get("target_template_id"),
            requested_session_id=body.get("session_id"),
            requested_conversion_run_id=requested_run_id,
            binding=binding,
            claims=claims,
        )
        try:
            content, filename = await run_in_threadpool(
                export_confirmed_profile,
                upload_id=upload_id,
                profile_id=str(body["profile_id"]),
                edited_rows=None,
                acknowledge_warnings=bool(body.get("acknowledge_warnings")),
                conversion_context_token=context_token,
                student_context_token=None,
                session_id=body.get("session_id"),
                revision=body.get("revision"),
                state_hash=body.get("state_hash"),
                requested_profile_version=body.get("profile_version"),
                requested_profile_state_hash=body.get("profile_state_hash"),
            )
        except OperationStoreConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except OperationStoreExpiredError as exc:
            raise HTTPException(status_code=410, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ReadinessGateError as exc:
            return JSONResponse(
                status_code=422,
                content=jsonable_encoder(exc.report.model_dump(mode="json")),
            )
        except MappingProfileV2Error as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return Response(
            content=content,
            media_type=EXPORT_MEDIA_TYPE,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


@app.post("/api/v1/conversions", response_model=None)
async def convert_conversion(
    conversion_type: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    options: Annotated[str | None, Form()] = None,
):
    option_payload = _parse_options(options)
    workdir = _create_workdir()
    try:
        input_path = await _save_upload(file, workdir)
        if option_payload.get("strict"):
            strict_report = await run_in_threadpool(
                check_file_for_errors,
                input_path,
                conversion_type,
                option_payload,
            )
            if strict_report.strict_blocked:
                return JSONResponse(
                    status_code=422,
                    content=strict_report.model_dump(mode="json"),
                )
            option_payload = dict(option_payload)
            option_payload["allow_calculation_warnings"] = True

        output_path = workdir / f"{conversion_type}_import.xls"
        report = await run_in_threadpool(
            convert_file,
            input_path,
            conversion_type,
            output_path,
            option_payload,
        )
        if not report.ok:
            return JSONResponse(status_code=422, content=report.model_dump(mode="json"))
        if has_calculation_warnings(report) and not allow_calculation_warnings(option_payload):
            return JSONResponse(status_code=422, content=report.model_dump(mode="json"))

        content = output_path.read_bytes()
        return Response(
            content=content,
            media_type=EXCEL_MEDIA_TYPE,
            headers={"Content-Disposition": f'attachment; filename="{conversion_type}_import.xls"'},
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


@app.post("/api/v1/ai/mapping-suggestions")
async def ai_mapping_suggestions(
    conversion_type: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    options: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    option_payload = _parse_options(options)
    workdir = _create_workdir()
    try:
        input_path = await _save_upload(file, workdir)
        response = await run_in_threadpool(
            suggest_mapping_for_file,
            input_path,
            conversion_type,
            option_payload,
        )
        return JSONResponse(response.model_dump(mode="json"))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


@app.post("/api/v1/ai/explain-validation")
async def ai_explain_validation(report: ValidationReport) -> JSONResponse:
    response = await run_in_threadpool(explain_validation_report, report)
    return JSONResponse(response.model_dump(mode="json"))


@app.post("/api/v1/ai/error-check")
async def ai_error_check(
    conversion_type: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    options: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    option_payload = _parse_options(options)
    workdir = _create_workdir()
    try:
        input_path = await _save_upload(file, workdir)
        response = await run_in_threadpool(
            check_file_for_errors,
            input_path,
            conversion_type,
            option_payload,
        )
        return JSONResponse(response.model_dump(mode="json"))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


def _parse_options(options: str | None) -> dict:
    if not options:
        return {}
    try:
        payload = json.loads(options)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="options must be valid JSON.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="options must be a JSON object.")
    return payload


def _create_workdir() -> Path:
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    workdir = TMP_ROOT / uuid.uuid4().hex
    workdir.mkdir()
    return workdir


async def _save_upload(file: UploadFile, workdir: Path) -> Path:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise HTTPException(status_code=415, detail="Only .xls and .xlsx files are supported.")

    input_path = workdir / f"input{suffix}"
    input_path.write_bytes(await file.read())
    return input_path


def _cleanup_tmp_root() -> None:
    if TMP_ROOT.exists() and not any(TMP_ROOT.iterdir()):
        TMP_ROOT.rmdir()


async def _read_limited_reconstruction_upload(file: UploadFile) -> bytes:
    max_bytes = int(os.getenv("RECONSTRUCTION_MAX_FILE_BYTES", str(30 * 1024 * 1024)))
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File vượt giới hạn {max_bytes} bytes",
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def _read_limited_student_upload(file: UploadFile) -> bytes:
    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise HTTPException(
            status_code=415,
            detail="Chỉ hỗ trợ file Excel .xls và .xlsx",
        )

    max_bytes = _positive_env_int("STUDENT_MAX_FILE_BYTES", 20 * 1024 * 1024)
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File vượt giới hạn {max_bytes} bytes",
            )
        chunks.append(chunk)

    content = b"".join(chunks)
    try:
        validate_excel_magic(filename, content)
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    return content


async def _read_limited_import_result_upload(file: UploadFile) -> tuple[str, bytes]:
    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        await file.close()
        raise HTTPException(status_code=415, detail="Chi ho tro file Excel .xls va .xlsx")
    content = await read_upload_with_limit(
        file,
        _positive_env_int(
            "IMPORT_RESULT_MAX_FILE_BYTES",
            _positive_env_int("MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
        ),
    )
    try:
        validate_excel_magic(filename, content)
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    return filename, content


def _positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


_IMPORT_RESULT_PARSE_SLOTS = threading.BoundedSemaphore(
    _positive_env_int("IMPORT_RESULT_MAX_CONCURRENT_PARSERS", 2)
)


def _acquire_import_result_parse_slot() -> None:
    if not _IMPORT_RESULT_PARSE_SLOTS.acquire(blocking=False):
        raise HTTPException(
            status_code=503,
            detail="Converter dang xu ly toi da import-result workbooks",
        )


def _verified_student_rate_claims(
    context_token: str,
    required_scope: str,
    session_id: str = "",
) -> StudentContextClaims:
    if not str(context_token or "").strip():
        raise StudentWorkflowError(401, "Thiếu student context")
    try:
        claims = verify_student_context(context_token, required_scope)
    except ValueError as exc:
        raise StudentWorkflowError(401, str(exc)) from exc
    if session_id and claims.session_id != str(session_id).strip():
        raise StudentWorkflowError(403, "Student context không thuộc phiên này")
    return claims


def _student_rate_key(action: str, claims: StudentContextClaims) -> str:
    return f"{action}:{claims.owner_scope}:{claims.session_id}:{claims.user_id}"


def clear_student_rate_limits() -> None:
    with _STUDENT_RATE_LOCK:
        _STUDENT_RATE_BUCKETS.clear()


def _check_student_rate_limit(
    key: str,
    *,
    limit: int,
    window_seconds: int = 15 * 60,
) -> None:
    now = time.monotonic()
    with _STUDENT_RATE_LOCK:
        expired = [
            bucket_key
            for bucket_key, (expires_at, _) in _STUDENT_RATE_BUCKETS.items()
            if expires_at <= now
        ]
        for bucket_key in expired:
            _STUDENT_RATE_BUCKETS.pop(bucket_key, None)
        expires_at, count = _STUDENT_RATE_BUCKETS.get(
            key,
            (now + window_seconds, 0),
        )
        if count >= limit:
            raise HTTPException(
                status_code=429,
                detail="Bạn đã gửi quá nhiều yêu cầu student. Vui lòng thử lại sau.",
            )
        _STUDENT_RATE_BUCKETS[key] = (expires_at, count + 1)


def clear_reconstruction_rate_limits() -> None:
    with _RECONSTRUCTION_RATE_LOCK:
        _RECONSTRUCTION_RATE_BUCKETS.clear()


def _check_reconstruction_rate_limit(
    key: str,
    *,
    limit: int,
    window_seconds: int = 15 * 60,
) -> None:
    now = time.monotonic()
    with _RECONSTRUCTION_RATE_LOCK:
        expired = [
            bucket_key
            for bucket_key, (expires_at, _) in _RECONSTRUCTION_RATE_BUCKETS.items()
            if expires_at <= now
        ]
        for bucket_key in expired:
            _RECONSTRUCTION_RATE_BUCKETS.pop(bucket_key, None)
        expires_at, count = _RECONSTRUCTION_RATE_BUCKETS.get(
            key,
            (now + window_seconds, 0),
        )
        if count >= limit:
            raise HTTPException(
                status_code=429,
                detail="Bạn đã gửi quá nhiều yêu cầu tái tạo. Vui lòng thử lại sau.",
            )
        _RECONSTRUCTION_RATE_BUCKETS[key] = (expires_at, count + 1)

def require_operation_service_or_local_session(
    request: Request,
    session_id: str,
    x_converter_service_token: Annotated[str | None, Header()] = None,
) -> str:
    try:
        return require_internal_service(request, x_converter_service_token)
    except HTTPException as auth_error:
        if str(x_converter_service_token or "").strip():
            raise auth_error
        if not unauthenticated_local_operations_enabled():
            raise auth_error
        try:
            session = OperationStore().load_session(session_id)
        except OperationStoreError:
            raise auth_error
        if not session.owner_scope.startswith("local:"):
            raise auth_error
        return str(getattr(request.state, "request_id", "") or "")

OPERATION_SERVICE_DEPENDENCIES = [
    Depends(require_operation_service_or_local_session)
]

def _ai_runtime_state() -> dict[str, str]:
    import os
    import urllib.request

    ai_provider = os.getenv("AI_PROVIDER", "disabled").lower()
    if ai_provider != "remote_http":
        return {
            "gateway": "offline",
            "model": "offline",
            "mapping": "not_run",
        }

    base_url = os.getenv("AI_BASE_URL", "").strip()
    if not base_url:
        return {
            "gateway": "offline",
            "model": "offline",
            "mapping": "not_run",
        }

    try:
        # The docs endpoint proves only that the gateway is reachable.
        from urllib.parse import urlparse

        parsed = urlparse(base_url)
        gateway_root = f"{parsed.scheme}://{parsed.netloc}/docs"
        urllib.request.urlopen(gateway_root, timeout=2)
    except Exception:
        return {
            "gateway": "offline",
            "model": "offline",
            "mapping": "not_run",
        }

    return {
        "gateway": "online",
        "model": "unknown",
        "mapping": "not_run",
    }

def _ai_runtime_status() -> str:
    """Backward-compatible gateway-only status for existing callers."""
    return _ai_runtime_state()["gateway"]

def _converter_capabilities(ai_status: str | dict[str, str] | None = None) -> dict[str, object]:
    import os

    if isinstance(ai_status, dict):
        ai_state = ai_status
    elif isinstance(ai_status, str):
        ai_state = {
            "gateway": ai_status,
            "model": "unknown" if ai_status == "online" else "offline",
            "mapping": "not_run",
        }
    else:
        ai_state = _ai_runtime_state()
    effective_ai_status = ai_state["gateway"]
    return {
            "voucherReconstruction": os.getenv(
                "VOUCHER_RECONSTRUCTION_ENABLED", "false"
            ).lower()
            == "true",
            "studentAssistant": os.getenv(
                "STUDENT_ASSISTANT_ENABLED", "false"
            ).lower()
            == "true",
            "studentFileExplain": os.getenv(
                "STUDENT_FILE_EXPLAIN_ENABLED", "false"
            ).lower()
            == "true",
            "studentFileQa": os.getenv("STUDENT_FILE_QA_ENABLED", "false").lower()
            == "true",
            "studentAccountingMap": os.getenv(
                "STUDENT_ACCOUNTING_MAP_ENABLED", "false"
            ).lower()
            == "true",
            "studentReconciliation": os.getenv(
                "STUDENT_RECONCILIATION_ENABLED", "false"
            ).lower()
            == "true",
            "studentInternship": os.getenv(
                "STUDENT_INTERNSHIP_ENABLED", "false"
            ).lower()
            == "true",
            "mapping_profile_v2": _env_enabled("FEATURE_MAPPING_PROFILE_V2"),
            "anomaly_detection": _env_enabled("FEATURE_ANOMALY_DETECTION"),
            "bulk_correction": _env_enabled("FEATURE_BULK_CORRECTION"),
            "reconciliation": _env_enabled("FEATURE_RECONCILIATION"),
            "accounting_assistant": _env_enabled("FEATURE_ACCOUNTING_ASSISTANT"),
            "ai_explanation": _env_enabled("FEATURE_ACCOUNTING_ASSISTANT")
            and _env_enabled("FEATURE_AI_EXPLANATION")
            and effective_ai_status == "online",
            "ai": ai_state,
            "limits": {
                "comparison_files": min(
                    2, _positive_env_int("RECONCILIATION_MAX_COMPARISON_FILES", 2)
                ),
                "raw_ttl_minutes": max(
                    1, _positive_env_int("OPERATION_SESSION_TTL_SECONDS", 3600) // 60
                ),
                "max_rows_per_file": _positive_env_int("RECONCILIATION_MAX_ROWS", 50000),
                "max_columns_per_file": _positive_env_int(
                    "RECONCILIATION_MAX_COLUMNS", 500
                ),
            },
    }

def _env_enabled(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in {"1", "true", "yes"}

def _domain_context_token(
    header_token: str | None,
    supplied_token: str | None,
    *,
    domain: str,
) -> str:
    header = str(header_token or "").strip()
    supplied = str(supplied_token or "").strip()
    if header and supplied and not hmac.compare_digest(header, supplied):
        raise HTTPException(status_code=401, detail=f"{domain} context không khớp")
    if not header:
        raise HTTPException(status_code=401, detail=f"Thiếu {domain} context")
    return header

def _conversion_context_for_request(
    header_token: str | None,
    supplied_token: str | None = None,
    *,
    required_scope: str,
    upload_id: object | None = None,
    session_id: object | None = None,
    target_template_id: object | None = None,
    conversion_run_id: object | None = None,
) -> tuple[str | None, dict[str, object] | None]:
    token = _domain_context_token(
        header_token,
        supplied_token,
        domain="conversion",
    )
    try:
        claims = verify_conversion_context_token(token)
    except ConversionContextError as exc:
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc

    scopes = claims.get("scopes")
    if not isinstance(scopes, list) or required_scope not in scopes:
        raise HTTPException(
            status_code=403,
            detail=f"Conversion context thiếu quyền {required_scope}",
        )
    if not claims.get("user_id") or not claims.get("conversion_run_id"):
        raise HTTPException(status_code=401, detail="Conversion context thiếu binding bắt buộc")
    allow_initial_auto_detect = (
        required_scope == "analyze"
        and not str(target_template_id or "").strip()
        and not str(claims.get("upload_id") or "").strip()
    )
    if (
        not allow_initial_auto_detect
        and not str(claims.get("target_template_id") or "").strip()
    ):
        raise HTTPException(
            status_code=401,
            detail="Conversion context thiếu target template",
        )

    expected_bindings = {
        "upload_id": upload_id,
        "operation_session_id": session_id,
        "target_template_id": target_template_id,
        "conversion_run_id": conversion_run_id,
    }
    for claim_name, expected in expected_bindings.items():
        normalized = str(expected or "").strip()
        if normalized and str(claims.get(claim_name) or "") != normalized:
            raise HTTPException(
                status_code=409,
                detail=f"{claim_name} không khớp conversion context",
            )
    return token, claims

def _mapping_operation_context(
    body: dict,
    header_token: str | None,
    *,
    required_scope: str,
) -> str:
    required = ("upload_id", "session_id", "target_template_id", "conversion_run_id")
    bindings = {name: str(body.get(name) or "").strip() for name in required}
    token, claims = _conversion_context_for_request(
        header_token,
        body.get("conversion_context_token"),
        required_scope=required_scope,
        upload_id=bindings["upload_id"],
        session_id=bindings["session_id"],
        target_template_id=bindings["target_template_id"],
        conversion_run_id=bindings["conversion_run_id"],
    )
    if claims is None:
        raise HTTPException(status_code=401, detail="Conversion context token là bắt buộc")
    if any(not value for value in bindings.values()):
        raise HTTPException(
            status_code=409,
            detail="Mapping operation thiếu upload, session, template hoặc conversion run binding",
        )
    try:
        revision = int(body["revision"])
        state_hash = str(body["state_hash"] or "").strip()
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=409,
            detail="Mapping operation phải gửi session_id, revision và state_hash",
        ) from exc
    if revision < 1 or not state_hash:
        raise HTTPException(
            status_code=409,
            detail="Mapping operation phải gửi session_id, revision và state_hash",
        )

    store = OperationStore(conversion_context_token=token)
    try:
        session = store.assert_context_binding(
            bindings["session_id"],
            claims,
            required_scope=required_scope,
        )
        store.assert_current(
            bindings["session_id"],
            expected_revision=revision,
            expected_state_hash=state_hash,
        )
        metadata = _read_upload_metadata(
            bindings["upload_id"],
            operation_store=store,
            session=session,
        )
    except OperationStoreConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OperationStoreExpiredError as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except (KeyError, OperationStoreError) as exc:
        raise HTTPException(status_code=404, detail="Không tìm thấy operation session") from exc

    context = metadata.get("conversion_context")
    context = context if isinstance(context, dict) else {}
    stored_run_id = str(
        metadata.get("conversion_run_id") or context.get("conversion_run_id") or ""
    ).strip()
    stored = {
        "operation_session_id": str(metadata.get("operation_session_id") or "").strip(),
        "target_template_id": str(metadata.get("target_template_id") or "").strip(),
        "conversion_run_id": stored_run_id,
        "owner_scope": str(
            metadata.get("owner_scope") or context.get("owner_scope") or ""
        ).strip(),
        "user_id": str(context.get("user_id") or "").strip(),
        "workspace_id": str(context.get("workspace_id") or "").strip(),
    }
    expected = {
        "operation_session_id": session.session_id,
        "target_template_id": session.target_template_id,
        "conversion_run_id": bindings["conversion_run_id"],
        "owner_scope": session.owner_scope,
        "user_id": str(session.user_id or ""),
        "workspace_id": str(session.workspace_id or ""),
    }
    if stored != expected:
        raise HTTPException(status_code=404, detail="Không tìm thấy operation session")
    return str(token)

def _max_upload_bytes(claims: dict[str, object] | None = None) -> int:
    configured = _positive_env_int("MAX_UPLOAD_BYTES", 20 * 1024 * 1024)
    if not claims:
        return configured
    try:
        claimed = int(claims.get("max_file_bytes") or 0)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=409, detail="max_file_bytes không hợp lệ") from exc
    if claimed <= 0:
        raise HTTPException(status_code=409, detail="Conversion context thiếu max_file_bytes")
    return min(configured, claimed)

@app.get("/api/v1/capabilities", dependencies=INTERNAL_SERVICE_DEPENDENCIES)
def converter_capabilities() -> dict[str, object]:
    return _converter_capabilities()

@app.post("/api/v1/mappings/session", dependencies=INTERNAL_SERVICE_DEPENDENCIES)
async def sync_misa_mapping_session(
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        context_token = _mapping_operation_context(
            body,
            x_conversion_context,
            required_scope="confirm",
        )
        payload = await run_in_threadpool(
            sync_mapping_session,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            conversion_context_token=context_token,
            session_id=str(body["session_id"]),
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
        )
        return JSONResponse(jsonable_encoder(payload))
    except OperationStoreConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OperationStoreExpiredError as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@app.get("/api/v1/sessions/{session_id}/revisions", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def operation_revisions(
    session_id: str,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(session_id, x_conversion_context)
        session = await run_in_threadpool(store.load_session, session_id)
        return JSONResponse(
            jsonable_encoder(
                {
                    "session_id": session_id,
                    "active_revision": session.active_revision,
                    "state_hash": session.state_hash,
                    "items": [item.model_dump(mode="json") for item in session.revisions],
                }
            )
        )
    except (OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/revisions/{revision}/activate", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def activate_operation_revision(
    session_id: str,
    revision: int,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="confirm"
        )
        session = await run_in_threadpool(
            store.activate_revision,
            session_id,
            revision=revision,
            expected_revision=int(body["expected_revision"]),
            expected_state_hash=str(body["state_hash"]),
            activated_by=store.load_session(session_id).owner_scope,
        )
        return JSONResponse(jsonable_encoder(session.model_dump(mode="json")))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/anomalies/detect", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def detect_operation_anomalies(
    session_id: str,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        payload = await run_in_threadpool(
            detect_anomalies,
            store,
            session_id=session_id,
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.get("/api/v1/sessions/{session_id}/anomalies", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def list_operation_anomalies(
    session_id: str,
    revision: int = Query(ge=1),
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        payload = await run_in_threadpool(
            get_anomalies, store, session_id=session_id, revision=revision
        )
        return JSONResponse(jsonable_encoder(payload))
    except (OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/anomalies/{anomaly_id}/review", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def review_operation_anomaly(
    session_id: str,
    anomaly_id: str,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="confirm"
        )
        session = store.load_session(session_id)
        payload = await run_in_threadpool(
            review_anomaly,
            store,
            session_id=session_id,
            anomaly_id=anomaly_id,
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
            action=str(body["action"]),
            reviewed_by=session.owner_scope,
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/corrections/propose", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def propose_operation_corrections(
    session_id: str,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        payload = await run_in_threadpool(
            propose_corrections,
            store,
            session_id=session_id,
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/corrections/simulate", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def simulate_operation_corrections(
    session_id: str,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        payload = await run_in_threadpool(
            simulate_corrections,
            store,
            session_id=session_id,
            patch_set_id=str(body["patch_set_id"]),
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
            selected_patch_ids=[str(item) for item in body.get("selected_patch_ids") or []],
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/corrections/apply", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def apply_operation_corrections(
    session_id: str,
    body: dict,
    idempotency_key: Annotated[str | None, Header()] = None,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="confirm"
        )
        session = store.load_session(session_id)
        payload = await run_in_threadpool(
            apply_corrections,
            store,
            session_id=session_id,
            patch_set_id=str(body["patch_set_id"]),
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
            selected_patch_ids=[str(item) for item in body.get("selected_patch_ids") or []],
            idempotency_key=str(idempotency_key or body.get("idempotency_key") or ""),
            applied_by=session.owner_scope,
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/corrections/undo", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def undo_operation_corrections(
    session_id: str,
    body: dict,
    idempotency_key: Annotated[str | None, Header()] = None,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="confirm"
        )
        session = store.load_session(session_id)
        payload = await run_in_threadpool(
            undo_corrections,
            store,
            session_id=session_id,
            patch_set_id=str(body["patch_set_id"]),
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
            idempotency_key=str(idempotency_key or body.get("idempotency_key") or ""),
            undone_by=session.owner_scope,
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/comparison-files", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def upload_operation_comparison(
    session_id: str,
    file: Annotated[UploadFile, File()],
    role: Annotated[str, Form()],
    revision: Annotated[int, Form()],
    state_hash: Annotated[str, Form()],
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        content = await read_upload_with_limit(
            file,
            _positive_env_int("RECONCILIATION_MAX_FILE_BYTES", 30 * 1024 * 1024),
        )
        payload = await run_in_threadpool(
            add_comparison_file,
            store,
            session_id=session_id,
            revision=revision,
            state_hash=state_hash,
            filename=file.filename or "comparison.xlsx",
            content=content,
            role=role,
        )
        return JSONResponse(jsonable_encoder(payload), status_code=201)
    except (ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.delete("/api/v1/sessions/{session_id}/comparison-files/{file_id}", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def delete_operation_comparison(
    session_id: str,
    file_id: str,
    revision: int = Query(ge=1),
    state_hash: str = Query(min_length=1),
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> Response:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        await run_in_threadpool(
            remove_comparison_file,
            store,
            session_id=session_id,
            file_id=file_id,
            revision=revision,
            state_hash=state_hash,
        )
        return Response(status_code=204)
    except (ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/reconciliation/run", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def run_operation_reconciliation(
    session_id: str,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        payload = await run_in_threadpool(
            run_reconciliation,
            store,
            session_id=session_id,
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.get("/api/v1/sessions/{session_id}/reconciliation/{report_id}", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def get_operation_reconciliation(
    session_id: str,
    report_id: str,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="readiness"
        )
        payload = await run_in_threadpool(
            get_reconciliation_report,
            store,
            session_id=session_id,
            report_id=report_id,
        )
        return JSONResponse(jsonable_encoder(payload))
    except (OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post(
    "/api/v1/sessions/{session_id}/reconciliation/{report_id}/matches/{match_id}/confirm",
    dependencies=OPERATION_SERVICE_DEPENDENCIES,
)
async def confirm_operation_reconciliation_candidate(
    session_id: str,
    report_id: str,
    match_id: str,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(
            session_id, x_conversion_context, required_scope="confirm"
        )
        session = store.load_session(session_id)
        payload = await run_in_threadpool(
            confirm_candidate_match,
            store,
            session_id=session_id,
            report_id=report_id,
            match_id=match_id,
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
            confirmed_by=session.owner_scope,
            selected_comparison_record_id=body.get("comparison_record_id"),
            action=str(body.get("action") or "confirm"),
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

@app.post("/api/v1/sessions/{session_id}/questions", dependencies=OPERATION_SERVICE_DEPENDENCIES)
async def ask_operation_question(
    session_id: str,
    body: dict,
    x_conversion_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        store = _authorized_operation_store(session_id, x_conversion_context)
        payload = await run_in_threadpool(
            ask_accounting_question,
            store,
            session_id=session_id,
            revision=int(body["revision"]),
            state_hash=str(body["state_hash"]),
            question=str(body["question"]),
            use_ai=bool(body.get("use_ai")),
        )
        return JSONResponse(jsonable_encoder(payload))
    except (KeyError, ValueError, OperationStoreError, ConversionContextError) as exc:
        _raise_operation_http(exc)

def _read_export_binding(
    upload_id: str,
    *,
    conversion_context_token: str | None,
    claims: dict[str, object] | None,
) -> dict[str, str]:
    operation_session_id = str((claims or {}).get("operation_session_id") or "").strip()
    if not conversion_context_token or not operation_session_id or claims is None:
        raise OperationStoreConflictError("Export thiếu operation session binding")
    store = OperationStore(conversion_context_token=conversion_context_token)
    session = store.assert_context_binding(
        operation_session_id,
        claims,
        required_scope="export",
    )
    if session.upload_id != upload_id:
        raise OperationStoreError("Upload và operation session không khớp")
    metadata = _read_upload_metadata(
        upload_id,
        operation_store=store,
        session=session,
    )
    target_template_id = str(metadata.get("target_template_id") or "").strip()
    operation_session_id = str(metadata.get("operation_session_id") or "").strip()
    context = metadata.get("conversion_context")
    context = context if isinstance(context, dict) else {}
    conversion_run_id = str(
        metadata.get("conversion_run_id") or context.get("conversion_run_id") or ""
    ).strip()
    if operation_session_id:
        session_target = str(session.target_template_id or "").strip()
        if target_template_id and target_template_id != session_target:
            raise OperationStoreError("Upload và operation session khác target template")
        target_template_id = session_target
        session_run_id = str(
            session.revisions[0].context.get("conversion_run_id") or ""
        ).strip()
        if conversion_run_id != session_run_id:
            raise OperationStoreError("Upload và operation session khác conversion run")
        conversion_run_id = session_run_id
    if not target_template_id:
        raise OperationStoreError("Export thiếu target template binding")
    if not conversion_run_id:
        raise OperationStoreError("Export thiếu conversion run binding")

    suggestion = metadata.get("suggestion")
    suggested_profile_id = (
        str(suggestion.get("profile_id") or "").strip()
        if isinstance(suggestion, dict)
        else ""
    )
    return {
        "target_template_id": target_template_id,
        "operation_session_id": operation_session_id,
        "conversion_run_id": conversion_run_id,
        "profile_id": str(metadata.get("profile_id") or suggested_profile_id).strip(),
        "owner_scope": str(
            metadata.get("owner_scope") or context.get("owner_scope") or ""
        ).strip(),
        "user_id": str(context.get("user_id") or "").strip(),
        "workspace_id": str(context.get("workspace_id") or "").strip(),
        "snapshot_set_hash": str(context.get("snapshot_set_hash") or "").strip(),
    }

def _assert_export_binding(
    *,
    upload_id: str,
    profile_id: str,
    requested_target_template_id: object,
    requested_session_id: object,
    requested_conversion_run_id: object,
    binding: dict[str, str],
    claims: dict[str, object] | None,
) -> None:
    stored_target = binding["target_template_id"]
    requested_target = str(requested_target_template_id or "").strip()
    if requested_target and requested_target != stored_target:
        raise HTTPException(status_code=409, detail="Target template không khớp upload")
    stored_profile = binding.get("profile_id") or ""
    if stored_profile and profile_id != stored_profile:
        raise HTTPException(status_code=409, detail="Mapping profile không khớp upload")
    stored_session = binding.get("operation_session_id") or ""
    requested_session = str(requested_session_id or "").strip()
    if stored_session and requested_session and requested_session != stored_session:
        raise HTTPException(status_code=409, detail="Operation session không khớp upload")
    stored_run_id = binding.get("conversion_run_id") or ""
    requested_run_id = str(requested_conversion_run_id or "").strip()
    if not requested_run_id or requested_run_id != stored_run_id:
        raise HTTPException(status_code=409, detail="Conversion run không khớp upload")
    if not claims:
        return
    if str(claims.get("upload_id") or "") != upload_id:
        raise HTTPException(status_code=409, detail="Upload không khớp conversion context")
    if str(claims.get("target_template_id") or "") != stored_target:
        raise HTTPException(status_code=409, detail="Target template không khớp conversion context")
    if str(claims.get("conversion_run_id") or "") != stored_run_id:
        raise HTTPException(status_code=409, detail="Conversion run không khớp conversion context")
    if stored_session and str(claims.get("operation_session_id") or "") != stored_session:
        raise HTTPException(status_code=409, detail="Operation session không khớp conversion context")
    owner_scope = binding.get("owner_scope") or ""
    if owner_scope and conversion_context_owner_scope(claims) != owner_scope:
        raise HTTPException(status_code=409, detail="Owner không khớp upload")
    for claim_name in ("user_id", "workspace_id", "snapshot_set_hash"):
        expected = binding.get(claim_name) or ""
        if expected and str(claims.get(claim_name) or "") != expected:
            raise HTTPException(status_code=409, detail=f"{claim_name} không khớp upload")

def _authorized_operation_store(
    session_id: str,
    conversion_context_token: str | None,
    *,
    required_scope: str = "preview",
) -> OperationStore:
    store = OperationStore(conversion_context_token=conversion_context_token)
    session = store.load_session(session_id)
    if (
        session.owner_scope.startswith("local:")
        and unauthenticated_local_operations_enabled()
    ):
        return store
    if not conversion_context_token:
        raise ConversionContextError("Conversion context token là bắt buộc", status_code=401)
    _, claims = _conversion_context_for_request(
        conversion_context_token,
        conversion_context_token,
        required_scope=required_scope,
        session_id=session_id,
    )
    if claims is None:
        raise ConversionContextError("Conversion context token là bắt buộc", status_code=401)
    store.assert_context_binding(
        session_id,
        claims,
        required_scope=required_scope,
    )
    return store

def _raise_operation_http(exc: Exception) -> None:
    if isinstance(
        exc,
        (
            AnomalyFeatureDisabledError,
            CorrectionFeatureDisabledError,
            ReconciliationFeatureDisabledError,
            AccountingAssistantFeatureDisabledError,
        ),
    ):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, OperationStoreConflictError):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, OperationStoreExpiredError):
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    if isinstance(exc, ConversionContextError):
        raise HTTPException(status_code=exc.status_code or 401, detail=str(exc)) from exc
    if isinstance(exc, OperationStoreError) and (
        "không tìm thấy phiên" in str(exc).lower()
        or "session not found" in str(exc).lower()
    ):
        raise HTTPException(status_code=404, detail="Không tìm thấy phiên chuyển đổi") from exc
    if isinstance(exc, KeyError):
        raise HTTPException(status_code=400, detail=f"Thiếu field bắt buộc: {exc}") from exc
    raise HTTPException(status_code=400, detail=str(exc)) from exc

async def read_upload_with_limit(file: UploadFile, max_bytes: int) -> bytes:
    max_bytes = max(1, int(max_bytes))
    chunks: list[bytes] = []
    total = 0
    try:
        while total <= max_bytes:
            chunk = await file.read(min(1024 * 1024, max_bytes + 1 - total))
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"File vượt giới hạn {max_bytes} bytes",
                )
            chunks.append(chunk)
        raise HTTPException(status_code=413, detail=f"File vượt giới hạn {max_bytes} bytes")
    finally:
        await file.close()
