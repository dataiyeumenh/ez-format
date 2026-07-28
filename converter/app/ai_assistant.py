from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.conversion_types import get_conversion_type
from app.excel_io import read_input_table
from app.column_patterns import FIELD_PATTERNS, best_header_for_field
from app.field_detection import (
    ALLOWED_SEMANTIC_FIELDS,
    apply_column_mapping,
    detect_columns,
)
from app.models import ValidationReport
from app.normalization import normalize_header


DEFAULT_AI_MODE = "disabled"
DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "qwen3:4b"


class MappingSuggestion(BaseModel):
    field: str
    source_header: str
    confidence: float = Field(ge=0, le=1)
    rationale: str


class MappingSuggestionResponse(BaseModel):
    ok: bool
    provider: str
    model: str | None = None
    suggestions: list[MappingSuggestion] = Field(default_factory=list)
    suggested_mapping: dict[str, str] = Field(default_factory=dict)
    missing_fields: list[str] = Field(default_factory=list)
    detected_columns: dict[str, str] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list)


class ValidationIssueExplanation(BaseModel):
    severity: str
    code: str
    row: int | None = None
    field: str
    message: str


class ValidationExplanationResponse(BaseModel):
    ok: bool
    provider: str
    model: str | None = None
    summary: str
    explanations: list[ValidationIssueExplanation] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


def suggest_mapping_for_file(
    input_path: Path,
    conversion_type: str,
    options: dict[str, Any] | None = None,
) -> MappingSuggestionResponse:
    mode = _ai_mode(options)
    definition = get_conversion_type(conversion_type)
    table = read_input_table(input_path)
    detected_columns = detect_columns(table.headers)
    missing_fields = [
        field for field in definition.required_source_fields if field not in detected_columns
    ]

    if mode == "disabled":
        return MappingSuggestionResponse(
            ok=False,
            provider=mode,
            detected_columns=detected_columns,
            missing_fields=missing_fields,
            errors=["AI disabled. Set AI_MODE=mock or AI_MODE=ollama to enable suggestions."],
        )

    if mode == "mock":
        return _mock_mapping_response(table.headers, definition.required_source_fields, detected_columns)

    if mode == "ollama":
        return MappingSuggestionResponse(
            ok=False,
            provider="ollama",
            detected_columns=detected_columns,
            missing_fields=missing_fields,
            errors=["Direct Ollama đã tắt; hãy gọi AI Local Gateway bằng AI_PROVIDER=remote_http."],
        )

    return MappingSuggestionResponse(
        ok=False,
        provider=mode,
        detected_columns=detected_columns,
        missing_fields=missing_fields,
        errors=[f"Unsupported AI_MODE '{mode}'."],
    )


def explain_validation_report(
    report: ValidationReport,
    options: dict[str, Any] | None = None,
) -> ValidationExplanationResponse:
    mode = _ai_mode(options)
    if mode == "disabled":
        return ValidationExplanationResponse(
            ok=False,
            provider=mode,
            summary="AI disabled. Set AI_MODE=mock or AI_MODE=ollama to explain validation reports.",
            errors=["AI disabled."],
        )

    if mode == "mock":
        return _mock_explanation_response(report, provider=mode)

    if mode == "ollama":
        return ValidationExplanationResponse(
            ok=False,
            provider="ollama",
            summary="Direct Ollama đã tắt; hãy dùng AI Local Gateway.",
            errors=["Direct Ollama đã tắt; hãy dùng AI Local Gateway."],
        )

    return ValidationExplanationResponse(
        ok=False,
        provider=mode,
        summary=f"Unsupported AI_MODE '{mode}'.",
        errors=[f"Unsupported AI_MODE '{mode}'."],
    )


def _ai_mode(options: dict[str, Any] | None) -> str:
    option_mode = (options or {}).get("ai_mode")
    if isinstance(option_mode, str) and option_mode.strip():
        return option_mode.strip().lower()
    return os.getenv("AI_MODE", DEFAULT_AI_MODE).strip().lower()


def _mock_mapping_response(
    headers: list[str],
    required_fields: tuple[str, ...],
    detected_columns: dict[str, str],
) -> MappingSuggestionResponse:
    suggestions: list[MappingSuggestion] = []
    suggested_mapping: dict[str, str] = {}
    used_headers: set[str] = set()

    for field, header in detected_columns.items():
        if field in ALLOWED_SEMANTIC_FIELDS:
            suggested_mapping[field] = header
            used_headers.add(header)
            suggestions.append(
                MappingSuggestion(
                    field=field,
                    source_header=header,
                    confidence=1.0,
                    rationale="Đã nhận diện bằng alias cột có sẵn.",
                )
            )

    for field in required_fields:
        if field in suggested_mapping:
            continue
        header = best_header_for_field(headers, field, used_headers)
        if not header:
            continue
        suggested_mapping[field] = header
        used_headers.add(header)
        suggestions.append(
            MappingSuggestion(
                field=field,
                source_header=header,
                confidence=0.82,
                rationale="Mock AI gợi ý dựa trên từ khóa trong tên cột.",
            )
        )

    for field in (
        "line_amount",
        "discount_percent",
        "discount_amount",
        "discount_total",
        "invoice_subtotal",
        "vat_rate",
        "vat_amount",
        "payable",
        "payment_method",
        "debit_account",
        "revenue_account",
        "vat_account",
        "input_vat_account",
        "inventory_account",
        "cogs_account",
        "payable_account",
        "discount_account",
        "item_type",
    ):
        if field in suggested_mapping:
            continue
        header = best_header_for_field(headers, field, used_headers)
        if not header:
            continue
        suggested_mapping[field] = header
        used_headers.add(header)
        suggestions.append(
            MappingSuggestion(
                field=field,
                source_header=header,
                confidence=0.74,
                rationale="Mock AI gợi ý cột phụ để kiểm tra phép tính.",
            )
        )

    missing_fields = [field for field in required_fields if field not in suggested_mapping]
    return MappingSuggestionResponse(
        ok=not missing_fields,
        provider="mock",
        model="mock-deterministic",
        suggestions=suggestions,
        suggested_mapping=suggested_mapping,
        missing_fields=missing_fields,
        detected_columns=detected_columns,
    )


def _ollama_mapping_response(
    headers: list[str],
    required_fields: tuple[str, ...],
    detected_columns: dict[str, str],
) -> MappingSuggestionResponse:
    model = os.getenv("AI_MODEL", DEFAULT_OLLAMA_MODEL)
    prompt = (
        "Bạn là trợ lý EzFormat. Hãy map header Excel sang semantic fields.\n"
        f"Headers: {json.dumps(headers, ensure_ascii=False)}\n"
        f"Required fields: {json.dumps(required_fields, ensure_ascii=False)}\n"
        f"Detected columns: {json.dumps(detected_columns, ensure_ascii=False)}\n"
        "Chỉ trả JSON: {\"suggestions\":[{\"field\":\"...\",\"source_header\":\"...\","
        "\"confidence\":0.0,\"rationale\":\"...\"}]}."
    )
    response = _call_ollama(prompt, model)
    if response.get("error"):
        return MappingSuggestionResponse(
            ok=False,
            provider="ollama",
            model=model,
            detected_columns=detected_columns,
            missing_fields=[field for field in required_fields if field not in detected_columns],
            errors=[response["error"]],
        )

    raw_suggestions = response.get("suggestions", [])
    suggestions: list[MappingSuggestion] = []
    candidate_mapping: dict[str, str] = {}
    for item in raw_suggestions if isinstance(raw_suggestions, list) else []:
        if not isinstance(item, dict):
            continue
        field = str(item.get("field", "")).strip()
        source_header = str(item.get("source_header", "")).strip()
        if not field or not source_header:
            continue
        confidence = item.get("confidence", 0.0)
        try:
            confidence_float = max(0.0, min(1.0, float(confidence)))
        except (TypeError, ValueError):
            confidence_float = 0.0
        suggestions.append(
            MappingSuggestion(
                field=field,
                source_header=source_header,
                confidence=confidence_float,
                rationale=str(item.get("rationale", "")).strip() or "Ollama suggestion.",
            )
        )
        candidate_mapping[field] = source_header

    safe_mapping, mapping_errors = apply_column_mapping({}, headers, candidate_mapping)
    missing_fields = [field for field in required_fields if field not in safe_mapping]
    safe_suggestions = [
        suggestion
        for suggestion in suggestions
        if safe_mapping.get(suggestion.field) == suggestion.source_header
    ]
    return MappingSuggestionResponse(
        ok=not missing_fields and not mapping_errors,
        provider="ollama",
        model=model,
        suggestions=safe_suggestions,
        suggested_mapping=safe_mapping,
        missing_fields=missing_fields,
        detected_columns=detected_columns,
        errors=[error["message"] for error in mapping_errors],
    )


def _mock_explanation_response(
    report: ValidationReport,
    *,
    provider: str,
    model: str | None = "mock-deterministic",
) -> ValidationExplanationResponse:
    explanations: list[ValidationIssueExplanation] = []
    for issue in report.errors:
        explanations.append(
            ValidationIssueExplanation(
                severity="error",
                code=issue.code,
                row=issue.row,
                field=issue.field,
                message=_explain_issue("Lỗi", issue.code, issue.message, issue.row),
            )
        )
    for issue in report.warnings:
        explanations.append(
            ValidationIssueExplanation(
                severity="warning",
                code=issue.code,
                row=issue.row,
                field=issue.field,
                message=_explain_issue("Cảnh báo", issue.code, issue.message, issue.row),
            )
        )

    summary = (
        f"Báo cáo có {report.summary.error_count} lỗi và "
        f"{report.summary.warning_count} cảnh báo trên {report.summary.input_rows} dòng dữ liệu."
    )
    return ValidationExplanationResponse(
        ok=True,
        provider=provider,
        model=model,
        summary=summary,
        explanations=explanations,
    )


def _ollama_explanation_response(report: ValidationReport) -> ValidationExplanationResponse:
    model = os.getenv("AI_MODEL", DEFAULT_OLLAMA_MODEL)
    prompt = (
        "Bạn là trợ lý EzFormat. Giải thích ValidationReport bằng tiếng Việt ngắn gọn, "
        "không thay đổi dữ liệu. Chỉ trả JSON: {\"summary\":\"...\","
        "\"explanations\":[{\"severity\":\"error|warning\",\"code\":\"...\",\"row\":null,"
        "\"field\":\"...\",\"message\":\"...\"}]}.\n"
        f"ValidationReport: {report.model_dump_json()}"
    )
    response = _call_ollama(prompt, model)
    if response.get("error"):
        return ValidationExplanationResponse(
            ok=False,
            provider="ollama",
            model=model,
            summary="Không thể gọi Ollama để giải thích ValidationReport.",
            errors=[response["error"]],
        )

    try:
        explanations = [
            ValidationIssueExplanation(
                severity=str(item.get("severity", "warning")),
                code=str(item.get("code", "")),
                row=item.get("row"),
                field=str(item.get("field", "")),
                message=str(item.get("message", "")),
            )
            for item in response.get("explanations", [])
            if isinstance(item, dict)
        ]
    except (TypeError, ValueError):
        return ValidationExplanationResponse(
            ok=False,
            provider="ollama",
            model=model,
            summary="Ollama returned an invalid explanation schema.",
            errors=["Invalid Ollama explanation schema."],
        )

    return ValidationExplanationResponse(
        ok=True,
        provider="ollama",
        model=model,
        summary=str(response.get("summary", "")).strip() or "Đã giải thích ValidationReport.",
        explanations=explanations,
    )


def _call_ollama(prompt: str, model: str) -> dict[str, Any]:
    base_url = os.getenv("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL).rstrip("/")
    timeout_raw = os.getenv("AI_TIMEOUT_SECONDS", "30")
    try:
        timeout = float(timeout_raw)
    except ValueError:
        timeout = 30.0
    payload = json.dumps(
        {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "format": "json",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as handle:
            body = json.loads(handle.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        return {"error": f"Ollama request failed: {exc}"}

    text = body.get("response", "")
    if not isinstance(text, str):
        return {"error": "Ollama response is missing text content."}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        return {"error": f"Ollama returned invalid JSON: {exc}"}
    if not isinstance(parsed, dict):
        return {"error": "Ollama returned a non-object JSON payload."}
    return parsed


def _explain_issue(prefix: str, code: str, message: str, row: int | None) -> str:
    row_text = f" tại dòng {row}" if row is not None else ""
    if code.startswith("calculation_"):
        return f"{prefix}{row_text}: phép tính không khớp. {message}"
    if code.startswith("missing_"):
        return f"{prefix}{row_text}: thiếu dữ liệu/cột bắt buộc. {message}"
    if code.startswith("invalid_"):
        return f"{prefix}{row_text}: định dạng dữ liệu chưa hợp lệ. {message}"
    return f"{prefix}{row_text}: {message}"
