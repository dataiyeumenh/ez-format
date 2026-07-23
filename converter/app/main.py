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

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from app.ai_assistant import explain_validation_report, suggest_mapping_for_file
from app.calculation_rules import allow_calculation_warnings, has_calculation_warnings
from app.conversion_types import BACKEND_ROOT, CONVERSION_TYPES
from app.converter import convert_file, export_rows, preview_file, validate_file
from app.document_structure import validate_excel_magic
from app.error_check import check_file_for_errors
from app.misa_workflow import (
    EXPORT_MEDIA_TYPE,
    ReadinessGateError,
    analyze_upload,
    confirm_mapping,
    export_confirmed_profile,
    preview_mapping,
    readiness_mapping,
    templates_payload,
)
from app.master_data import parse_master_data_file
from app.master_data_client import ConversionContextError
from app.models import ExportRowsRequest, PreviewResponse, ValidationReport
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
from app.student_store import cleanup_expired_student_uploads
from app.student_context import StudentContextClaims, verify_student_context
from app.student_models import (
    StudentAnonymizationRequest,
    StudentAttemptRequest,
    StudentHintRequest,
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
    reveal_student_hint,
    submit_student_attempt,
)


app = FastAPI(title="EzFormat Converter API")
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


async def _cleanup_student_uploads_at_startup() -> None:
    await run_in_threadpool(_opportunistic_student_cleanup, force=True)


app.router.add_event_handler("startup", _cleanup_student_uploads_at_startup)


@app.middleware("http")
async def attach_request_id(request: Request, call_next):
    await run_in_threadpool(_opportunistic_student_cleanup)
    supplied = str(request.headers.get("x-request-id") or "").strip()
    request_id = supplied[:128] if supplied else uuid.uuid4().hex
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


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
    import os
    import urllib.request

    ai_status = "disabled"
    ai_provider = os.getenv("AI_PROVIDER", "disabled").lower()
    if ai_provider == "remote_http":
        base_url = os.getenv("AI_BASE_URL", "").strip()
        if base_url:
            # Derive gateway root from the full endpoint URL
            from urllib.parse import urlparse
            parsed = urlparse(base_url)
            gateway_root = f"{parsed.scheme}://{parsed.netloc}/docs"
            try:
                urllib.request.urlopen(gateway_root, timeout=2)
                ai_status = "online"
            except Exception:
                ai_status = "offline"
        else:
            ai_status = "offline"
    elif ai_provider == "ollama":
        ollama_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
        try:
            urllib.request.urlopen(f"{ollama_url}/api/tags", timeout=2)
            ai_status = "online"
        except Exception:
            ai_status = "offline"

    return {
        "status": "ok",
        "ai": ai_status,
        "capabilities": {
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
            "studentCheckWork": os.getenv("STUDENT_CHECK_WORK_ENABLED", "false").lower()
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
    conversion_context_token: Annotated[str | None, Form()] = None,
    student_context_token: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    try:
        content = await file.read()
        payload = await run_in_threadpool(
            analyze_upload,
            filename=file.filename or "upload.xlsx",
            content=content,
            requested_target_template_id=target_template_id,
            conversion_context_token=conversion_context_token,
            student_context_token=student_context_token,
        )
        return JSONResponse(jsonable_encoder(payload))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/student/sessions/analyze")
async def analyze_student_session(
    file: Annotated[UploadFile, File()],
    context_token: Annotated[str, Form()],
    target_template_id: Annotated[str | None, Form()] = None,
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
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


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


@app.post("/api/v1/student/sessions/{session_id}/attempts")
async def student_session_attempt(
    session_id: str,
    request: StudentAttemptRequest,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            submit_student_attempt,
            session_id=session_id,
            context_token=x_student_context or "",
            kind=request.kind,
            state_hash=request.state_hash,
            submitted=request.submitted,
            rubric_version=request.rubric_version,
        )
        return JSONResponse(jsonable_encoder(payload))
    except StudentWorkflowError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@app.post(
    "/api/v1/student/sessions/{session_id}/attempts/{attempt_id}/hints/{level}"
)
async def student_session_hint(
    session_id: str,
    attempt_id: str,
    level: int,
    request: StudentHintRequest,
    x_student_context: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            reveal_student_hint,
            session_id=session_id,
            attempt_id=attempt_id,
            issue_id=request.issue_id,
            level=level,
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
async def preview_misa_mapping(body: dict) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            preview_mapping,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            conversion_context_token=body.get("conversion_context_token"),
            student_context_token=body.get("student_context_token"),
        )
        return JSONResponse(jsonable_encoder(payload))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/mappings/readiness")
async def readiness_misa_mapping(body: dict) -> JSONResponse:
    try:
        edited_rows = body.get("rows")
        payload = await run_in_threadpool(
            readiness_mapping,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            edited_rows=edited_rows if isinstance(edited_rows, list) else None,
            conversion_context_token=body.get("conversion_context_token"),
            student_context_token=body.get("student_context_token"),
        )
        return JSONResponse(jsonable_encoder(payload))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/mappings/confirm")
async def confirm_misa_mapping(body: dict) -> JSONResponse:
    try:
        payload = await run_in_threadpool(
            confirm_mapping,
            upload_id=str(body["upload_id"]),
            target_template_id=str(body["target_template_id"]),
            mapping=body.get("mapping") or {},
            defaults=body.get("defaults") or {},
            formulas=body.get("formulas") or {},
            profile_name=body.get("profile_name"),
            conversion_context_token=body.get("conversion_context_token"),
            student_context_token=body.get("student_context_token"),
        )
        return JSONResponse(jsonable_encoder(payload))
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


@app.post("/api/v1/conversions/export", response_model=None)
async def export_conversion_rows(body: dict) -> Response:
    if "upload_id" in body and "profile_id" in body:
        try:
            edited_rows = body.get("rows")
            content, filename = await run_in_threadpool(
                export_confirmed_profile,
                upload_id=str(body["upload_id"]),
                profile_id=str(body["profile_id"]),
                edited_rows=edited_rows if isinstance(edited_rows, list) and edited_rows else None,
                acknowledge_warnings=bool(body.get("acknowledge_warnings")),
                conversion_context_token=body.get("conversion_context_token"),
                student_context_token=body.get("student_context_token"),
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ReadinessGateError as exc:
            return JSONResponse(
                status_code=422,
                content=jsonable_encoder(exc.report.model_dump(mode="json")),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return Response(
            content=content,
            media_type=EXPORT_MEDIA_TYPE,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    legacy_body = ExportRowsRequest.model_validate(body)
    workdir = _create_workdir()
    try:
        output_path = workdir / f"{legacy_body.conversion_type}_import.xls"
        await run_in_threadpool(
            export_rows,
            legacy_body.conversion_type,
            legacy_body.rows,
            output_path,
            legacy_body.options,
            sheet_name=legacy_body.sheet_name,
        )
        content = output_path.read_bytes()
        return Response(
            content=content,
            media_type=EXCEL_MEDIA_TYPE,
            headers={
                "Content-Disposition": f'attachment; filename="{legacy_body.conversion_type}_import.xls"'
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


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


def _positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


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
