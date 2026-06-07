from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse


app = FastAPI(title="EzFormat Local AI Gateway")

MAX_AI_PAYLOAD_BYTES = 256 * 1024


@app.post("/v1/misa/suggest-mapping")
async def suggest_mapping(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    _require_token(authorization)
    body = await request.body()
    if len(body) > MAX_AI_PAYLOAD_BYTES:
        raise HTTPException(status_code=413, detail="AI mapping payload is too large.")
    try:
        payload = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Request body must be valid JSON.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object.")

    response = await _call_ollama(payload)
    return JSONResponse(response)


def _require_token(authorization: str | None) -> None:
    expected = os.getenv("AI_GATEWAY_TOKEN", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="AI_GATEWAY_TOKEN is not configured.")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid AI gateway token.")


async def _call_ollama(payload: dict[str, Any]) -> dict[str, Any]:
    model = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
    base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    try:
        timeout = float(os.getenv("AI_TIMEOUT_SECONDS", "30"))
    except ValueError:
        timeout = 30.0
    prompt = _build_prompt(payload)
    request_payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"{base_url}/api/generate", json=request_payload)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama request failed: {exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Ollama returned HTTP {response.status_code}.")
    data = response.json()
    text = data.get("response")
    if not isinstance(text, str):
        raise HTTPException(status_code=502, detail="Ollama response is missing JSON text.")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama returned invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="Ollama JSON must be an object.")
    return _normalize_gateway_response(parsed, payload)


def _build_prompt(payload: dict[str, Any]) -> str:
    target = payload.get("target_template") or {}
    source = payload.get("source") or {}
    compact = json.dumps(
        {
            "target_template_id": target.get("id"),
            "misa_headers": target.get("headers") or [],
            "raw_sheet_name": source.get("sheet_name"),
            "raw_headers": source.get("headers") or [],
            "nearby_profiles": payload.get("nearby_profiles") or [],
        },
        ensure_ascii=False,
    )
    return (
        "NHIỆM VỤ DUY NHẤT: đề xuất mapping cột Excel thô sang header template MISA. "
        "KHÔNG phân tích doanh số, KHÔNG viết báo cáo, KHÔNG tóm tắt dữ liệu. "
        "Chỉ được trả về đúng một JSON object theo schema:\n"
        "{\"target_template_id\":\"...\",\"mapping\":{},\"defaults\":{},"
        "\"formulas\":{},\"confidence\":0.0,\"notes\":[]}\n"
        "Quy tắc bắt buộc:\n"
        "- mapping dùng raw header làm key, MISA header làm value hoặc list value.\n"
        "- raw header key phải copy y nguyên từ raw_headers.\n"
        "- MISA header value phải copy y nguyên từ misa_headers.\n"
        "- Nếu không chắc thì bỏ qua cột đó, không bịa header.\n"
        "- confidence là số từ 0 đến 1.\n"
        "Ví dụ đúng: {\"target_template_id\":\"bsn_sales\","
        "\"mapping\":{\"Mã hóa đơn\":\"Số chứng từ (*)\","
        "\"Thời gian\":[\"Ngày hạch toán (*)\",\"Ngày chứng từ (*)\"]},"
        "\"defaults\":{},\"formulas\":{},\"confidence\":0.8,\"notes\":[]}\n\n"
        f"INPUT_HEADERS_ONLY:\n{compact}"
    )


def _normalize_gateway_response(response: dict[str, Any], request_payload: dict[str, Any]) -> dict[str, Any]:
    target_template = request_payload.get("target_template") or {}
    target_headers = set(target_template.get("headers") or [])
    source_headers = set((request_payload.get("source") or {}).get("headers") or [])
    mapping = _normalize_mapping(response.get("mapping"), source_headers, target_headers)
    confidence = _normalize_confidence(response.get("confidence"))
    return {
        "target_template_id": response.get("target_template_id") or target_template.get("id") or "",
        "mapping": mapping,
        "defaults": _normalize_target_dict(response.get("defaults"), target_headers),
        "formulas": _normalize_target_dict(response.get("formulas"), target_headers),
        "confidence": confidence if mapping else 0.0,
        "notes": _normalize_notes(response.get("notes")),
    }


def _normalize_mapping(
    mapping: Any,
    source_headers: set[str],
    target_headers: set[str],
) -> dict[str, Any]:
    if not isinstance(mapping, dict):
        return {}

    normalized: dict[str, list[str]] = {}

    def add_target(raw_header: str, target_header: str) -> None:
        if raw_header not in source_headers or target_header not in target_headers:
            return
        normalized.setdefault(raw_header, [])
        if target_header not in normalized[raw_header]:
            normalized[raw_header].append(target_header)

    for key, value in mapping.items():
        values = value if isinstance(value, list) else [value]
        if key in source_headers:
            for target_header in values:
                if isinstance(target_header, str):
                    add_target(key, target_header)
        elif key in target_headers:
            for raw_header in values:
                if isinstance(raw_header, str):
                    add_target(raw_header, key)

    return {
        raw_header: targets[0] if len(targets) == 1 else targets
        for raw_header, targets in normalized.items()
    }


def _normalize_target_dict(value: Any, target_headers: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if key in target_headers}


def _normalize_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.0
    if confidence > 1:
        confidence = confidence / 100
    return round(max(0.0, min(1.0, confidence)), 2)


def _normalize_notes(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []
