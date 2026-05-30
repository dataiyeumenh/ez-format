from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from app.ai_assistant import explain_validation_report, suggest_mapping_for_file
from app.calculation_rules import allow_calculation_warnings, has_calculation_warnings
from app.conversion_types import BACKEND_ROOT, CONVERSION_TYPES
from app.converter import convert_file, export_rows, preview_file, validate_file
from app.error_check import check_file_for_errors
from app.models import ExportRowsRequest, PreviewResponse, ValidationReport


app = FastAPI(title="EzFormat Converter API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TMP_ROOT = BACKEND_ROOT / ".tmp"
SUPPORTED_SUFFIXES = {".xls", ".xlsx"}
EXCEL_MEDIA_TYPE = "application/vnd.ms-excel"


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/conversion-types")
def conversion_types() -> dict[str, list[dict[str, str]]]:
    return {
        "items": [
            {"id": definition.id, "label": definition.label, "kind": definition.kind}
            for definition in CONVERSION_TYPES.values()
        ]
    }


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
        report = validate_file(input_path, conversion_type, option_payload)
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
        headers, rows, report = preview_file(input_path, conversion_type, option_payload)
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
async def export_conversion_rows(body: ExportRowsRequest) -> Response:
    workdir = _create_workdir()
    try:
        output_path = workdir / f"{body.conversion_type}_import.xls"
        export_rows(
            body.conversion_type,
            body.rows,
            output_path,
            body.options,
        )
        content = output_path.read_bytes()
        return Response(
            content=content,
            media_type=EXCEL_MEDIA_TYPE,
            headers={
                "Content-Disposition": f'attachment; filename="{body.conversion_type}_import.xls"'
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
            strict_report = check_file_for_errors(input_path, conversion_type, option_payload)
            if strict_report.strict_blocked:
                return JSONResponse(
                    status_code=422,
                    content=strict_report.model_dump(mode="json"),
                )
            option_payload = dict(option_payload)
            option_payload["allow_calculation_warnings"] = True

        output_path = workdir / f"{conversion_type}_import.xls"
        report = convert_file(input_path, conversion_type, output_path, option_payload)
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
        response = suggest_mapping_for_file(input_path, conversion_type, option_payload)
        return JSONResponse(response.model_dump(mode="json"))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        _cleanup_tmp_root()


@app.post("/api/v1/ai/explain-validation")
async def ai_explain_validation(report: ValidationReport) -> JSONResponse:
    response = explain_validation_report(report)
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
        response = check_file_for_errors(input_path, conversion_type, option_payload)
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
