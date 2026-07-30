from __future__ import annotations

import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from datetime import date, datetime
from typing import Any

import httpx

from app.ai_endpoint_policy import validate_remote_ai_endpoint
from app.ai_mapping_client import ai_enabled
from app.normalization import normalize_header


ALLOWED_GROUPING_KEYS = {
    "invoice_number",
    "invoice_symbol",
    "invoice_date",
    "posting_date",
    "supplier_tax_code",
    "customer_tax_code",
    "purchase_receipt",
}

ALLOWED_SEMANTIC_FIELDS = {
    "invoice",
    "invoice_symbol",
    "invoice_date",
    "date",
    "purchase_receipt",
    "supplier_code",
    "supplier_tax_code",
    "supplier_name",
    "customer_code",
    "customer_tax_code",
    "customer_name",
    "item_code",
    "item_name",
    "item_type",
    "unit",
    "quantity",
    "unit_price",
    "line_amount",
    "vat_rate",
    "vat_amount",
}

ALLOWED_RESPONSE_KEYS = {
    "field_roles",
    "grouping_keys",
    "direction",
    "nature",
    "confidence",
    "notes",
}
SAFE_SAMPLE_ENUMS = {
    "hang_hoa",
    "dich_vu",
    "goods",
    "service",
    "mixed",
    "kct",
    "0",
    "0%",
    "5",
    "5%",
    "8",
    "8%",
    "10",
    "10%",
}


class AiReconstructionError(ValueError):
    pass


_CACHE_LOCK = threading.Lock()
_SUGGESTION_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_INFLIGHT: dict[str, threading.Event] = {}


def request_reconstruction_suggestion(
    payload: dict[str, Any],
    *,
    cache_key: str | None = None,
) -> dict[str, Any]:
    if not ai_enabled():
        raise AiReconstructionError("AI reconstruction đang tắt")
    payload = redact_reconstruction_payload(payload)
    url = _endpoint()
    resolved_cache_key = (
        f"{url}|{_prompt_version()}|{cache_key}" if cache_key else ""
    )
    if resolved_cache_key:
        cached = _cached_suggestion(resolved_cache_key)
        if cached is not None:
            return cached
        owner, event = _claim_inflight(resolved_cache_key)
        if not owner:
            if not event.wait(timeout=_timeout_seconds() + 2):
                raise AiReconstructionError(
                    "AI reconstruction đang xử lý cùng cấu trúc file quá lâu"
                )
            cached = _cached_suggestion(resolved_cache_key)
            if cached is not None:
                return cached
            raise AiReconstructionError(
                "AI reconstruction không trả được gợi ý cho cấu trúc file này"
            )
    else:
        owner, event = True, None

    try:
        result = _request_remote_suggestion(payload, url=url)
        if resolved_cache_key:
            _store_suggestion(resolved_cache_key, result)
        return result
    finally:
        if resolved_cache_key and owner:
            _release_inflight(resolved_cache_key, event)


def _request_remote_suggestion(
    payload: dict[str, Any],
    *,
    url: str,
) -> dict[str, Any]:
    token = os.getenv("AI_TOKEN", "").strip()
    headers = {
        "Content-Type": "application/json",
        "X-Request-ID": uuid.uuid4().hex,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        response = httpx.post(
            url,
            json=payload,
            headers=headers,
            timeout=_timeout_seconds(),
        )
    except httpx.HTTPError as exc:
        raise AiReconstructionError(f"AI reconstruction unavailable: {exc}") from exc
    if response.status_code >= 400:
        raise AiReconstructionError(
            f"AI reconstruction returned HTTP {response.status_code}"
        )
    try:
        result = response.json()
    except ValueError as exc:
        raise AiReconstructionError("AI reconstruction trả JSON không hợp lệ") from exc
    return normalize_reconstruction_suggestion(
        result,
        source_headers=payload.get("source", {}).get("headers") or [],
    )


def clear_reconstruction_suggestion_cache() -> None:
    with _CACHE_LOCK:
        _SUGGESTION_CACHE.clear()
        for event in _INFLIGHT.values():
            event.set()
        _INFLIGHT.clear()


def _cached_suggestion(cache_key: str) -> dict[str, Any] | None:
    now = time.monotonic()
    with _CACHE_LOCK:
        expired = [
            key for key, (expires_at, _) in _SUGGESTION_CACHE.items()
            if expires_at <= now
        ]
        for key in expired:
            _SUGGESTION_CACHE.pop(key, None)
        cached = _SUGGESTION_CACHE.get(cache_key)
        if cached is None:
            return None
        _SUGGESTION_CACHE.move_to_end(cache_key)
        return dict(cached[1])


def _store_suggestion(cache_key: str, suggestion: dict[str, Any]) -> None:
    expires_at = time.monotonic() + _cache_ttl_seconds()
    with _CACHE_LOCK:
        _SUGGESTION_CACHE[cache_key] = (expires_at, dict(suggestion))
        _SUGGESTION_CACHE.move_to_end(cache_key)
        while len(_SUGGESTION_CACHE) > _cache_max_entries():
            _SUGGESTION_CACHE.popitem(last=False)


def _claim_inflight(cache_key: str) -> tuple[bool, threading.Event]:
    with _CACHE_LOCK:
        existing = _INFLIGHT.get(cache_key)
        if existing is not None:
            return False, existing
        event = threading.Event()
        _INFLIGHT[cache_key] = event
        return True, event


def _release_inflight(cache_key: str, event: threading.Event | None) -> None:
    with _CACHE_LOCK:
        current = _INFLIGHT.get(cache_key)
        if current is event:
            _INFLIGHT.pop(cache_key, None)
            current.set()


def _timeout_seconds() -> float:
    return max(1.0, float(os.getenv("AI_RECONSTRUCTION_TIMEOUT_SECONDS", "20")))


def _cache_ttl_seconds() -> float:
    return max(1.0, float(os.getenv("AI_RECONSTRUCTION_CACHE_TTL_SECONDS", "3600")))


def _cache_max_entries() -> int:
    return max(1, int(os.getenv("AI_RECONSTRUCTION_CACHE_MAX_ENTRIES", "500")))


def _prompt_version() -> str:
    return (
        os.getenv("AI_RECONSTRUCTION_PROMPT_VERSION", "phase3-v1").strip()
        or "phase3-v1"
    )


def normalize_reconstruction_suggestion(
    payload: Any,
    *,
    source_headers: list[str],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AiReconstructionError("AI reconstruction response phải là object")
    unknown_keys = set(payload) - ALLOWED_RESPONSE_KEYS
    if unknown_keys:
        raise AiReconstructionError(
            "AI reconstruction response có field không được hỗ trợ: "
            + ", ".join(sorted(unknown_keys))
        )
    header_set = set(source_headers)
    roles: dict[str, str] = {}
    raw_roles = payload.get("field_roles")
    if not isinstance(raw_roles, dict):
        raise AiReconstructionError("AI field_roles phải là object")
    for semantic, header in raw_roles.items():
        if semantic not in ALLOWED_SEMANTIC_FIELDS or header not in header_set:
            raise AiReconstructionError("AI field_roles chứa semantic/header không hợp lệ")
        roles[semantic] = header
    raw_grouping = payload.get("grouping_keys")
    if not isinstance(raw_grouping, list):
        raise AiReconstructionError("AI grouping_keys phải là array")
    grouping_keys = [str(item) for item in raw_grouping]
    if any(item not in ALLOWED_GROUPING_KEYS for item in grouping_keys):
        raise AiReconstructionError("AI grouping_keys chứa field không hợp lệ")
    grouping_keys = grouping_keys[:6]
    direction = str(payload.get("direction") or "unknown").lower()
    if direction not in {"purchase", "sales", "unknown"}:
        raise AiReconstructionError("AI direction không hợp lệ")
    nature = str(payload.get("nature") or "unknown").lower()
    if nature not in {"goods", "service", "mixed", "unknown"}:
        raise AiReconstructionError("AI nature không hợp lệ")
    try:
        confidence = max(0.0, min(1.0, float(payload.get("confidence") or 0)))
    except (TypeError, ValueError):
        raise AiReconstructionError("AI confidence không hợp lệ")
    notes = payload.get("notes")
    if not isinstance(notes, list):
        raise AiReconstructionError("AI notes phải là array")
    return {
        "field_roles": roles,
        "grouping_keys": list(dict.fromkeys(grouping_keys)),
        "direction": direction,
        "nature": nature,
        "confidence": round(confidence, 2),
        "notes": [str(item)[:300] for item in notes[:10]],
    }


def redact_reconstruction_sample_rows(
    sample_rows: Any,
    source_headers: list[str],
    *,
    max_rows: int = 3,
) -> list[dict[str, Any]]:
    if not isinstance(sample_rows, list):
        return []
    allowed_headers = set(source_headers)
    output: list[dict[str, Any]] = []
    for row in sample_rows[:max_rows]:
        if not isinstance(row, dict):
            continue
        output.append(
            {
                str(header): _redacted_value(value)
                for header, value in row.items()
                if header in allowed_headers
            }
        )
    return output


def redact_reconstruction_payload(payload: dict[str, Any]) -> dict[str, Any]:
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    source_headers = [str(item) for item in source.get("headers") or []]
    return {
        "mode": str(payload.get("mode") or "auto"),
        "workspace_tax_code_configured": bool(
            payload.get("workspace_tax_code_configured")
        ),
        "source": {
            "sheet_name": _redacted_value(source.get("sheet_name")),
            "headers": source_headers,
            "sample_rows": redact_reconstruction_sample_rows(
                source.get("sample_rows"), source_headers
            ),
        },
        "detected_columns": {
            str(key): str(value)
            for key, value in (payload.get("detected_columns") or {}).items()
            if isinstance(key, str) and isinstance(value, str) and value in source_headers
        },
        "unresolved_codes": [
            str(item)[:100] for item in (payload.get("unresolved_codes") or [])[:20]
        ],
    }


def _redacted_value(value: Any) -> str:
    if value is None or str(value).strip() == "":
        return "<blank>"
    if isinstance(value, bool):
        return "<boolean>"
    if isinstance(value, (int, float)):
        return "<number>"
    if isinstance(value, (date, datetime)):
        return "<date>"
    text = str(value).strip()
    normalized = normalize_header(text)
    if normalized in SAFE_SAMPLE_ENUMS:
        return normalized
    if re.fullmatch(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}", text) or re.fullmatch(
        r"\d{4}-\d{1,2}-\d{1,2}",
        text,
    ):
        return "<date>"
    if re.fullmatch(r"[-+()\d.,%\s]+", text):
        return "<number_or_identifier>"
    return "<text>"


def _endpoint() -> str:
    configured = os.getenv("AI_RECONSTRUCTION_BASE_URL", "").strip()
    if configured:
        try:
            return validate_remote_ai_endpoint(configured)
        except ValueError as exc:
            raise AiReconstructionError(str(exc)) from exc
    mapping_url = os.getenv("AI_BASE_URL", "").strip()
    if mapping_url.endswith("/v1/misa/suggest-mapping"):
        candidate = (
            mapping_url[: -len("/v1/misa/suggest-mapping")]
            + "/v1/misa/suggest-reconstruction"
        )
        try:
            return validate_remote_ai_endpoint(candidate)
        except ValueError as exc:
            raise AiReconstructionError(str(exc)) from exc
    if mapping_url:
        try:
            return validate_remote_ai_endpoint(
                mapping_url.rstrip("/") + "/v1/misa/suggest-reconstruction"
            )
        except ValueError as exc:
            raise AiReconstructionError(str(exc)) from exc
    raise AiReconstructionError("AI_RECONSTRUCTION_BASE_URL chưa được cấu hình")
