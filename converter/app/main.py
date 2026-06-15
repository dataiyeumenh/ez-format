from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Annotated

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass  # python-dotenv not installed, rely on system env vars

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from app.ai_assistant import explain_validation_report, suggest_mapping_for_file
from app.calculation_rules import allow_calculation_warnings, has_calculation_warnings
from app.conversion_types import BACKEND_ROOT, CONVERSION_TYPES
from app.converter import convert_file, export_rows, preview_file, validate_file
from app.error_check import check_file_for_errors
from app.misa_workflow import (
    EXPORT_MEDIA_TYPE,
    analyze_upload,
    confirm_mapping,
    export_confirmed_profile,
    preview_mapping,
    templates_payload,
)
from app.models import ExportRowsRequest, PreviewResponse, ValidationReport


app = FastAPI(title="EzFormat Converter API")


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
)

TMP_ROOT = BACKEND_ROOT / ".tmp"
SUPPORTED_SUFFIXES = {".xls", ".xlsx"}
EXCEL_MEDIA_TYPE = "application/vnd.ms-excel"


@app.get("/healthz")
def healthz() -> dict[str, str]:
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

    return {"status": "ok", "ai": ai_status}


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


@app.post("/api/v1/uploads/analyze")
async def analyze_raw_upload(
    file: Annotated[UploadFile, File()],
    target_template_id: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    try:
        content = await file.read()
        payload = await run_in_threadpool(
            analyze_upload,
            filename=file.filename or "upload.xlsx",
            content=content,
            requested_target_template_id=target_template_id,
        )
        return JSONResponse(jsonable_encoder(payload))
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
            content, filename = await run_in_threadpool(
                export_confirmed_profile,
                upload_id=str(body["upload_id"]),
                profile_id=str(body["profile_id"]),
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
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
