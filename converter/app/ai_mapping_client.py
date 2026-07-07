from __future__ import annotations

import os
from typing import Any

import httpx


class AiMappingError(Exception):
    pass


DEFAULT_MAPPING_TIMEOUT_SECONDS = 60.0
DEFAULT_MAPPING_TIMEOUT_CAP_SECONDS = 120.0


def ai_enabled() -> bool:
    return os.getenv("AI_PROVIDER", "disabled").lower() == "remote_http"


def ai_required() -> bool:
    return os.getenv("AI_REQUIRED", "false").lower() in {"1", "true", "yes"}


def request_mapping_suggestion(payload: dict[str, Any]) -> dict[str, Any]:
    base_url = os.getenv("AI_BASE_URL", "").strip()
    token = os.getenv("AI_TOKEN", "").strip()
    if not base_url:
        raise AiMappingError("AI_BASE_URL is not configured.")
    timeout = mapping_timeout_seconds()

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        response = httpx.post(base_url, json=payload, headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise AiMappingError(f"AI Gateway request failed: {exc}") from exc

    if response.status_code >= 400:
        raise AiMappingError(f"AI Gateway returned HTTP {response.status_code}.")
    try:
        data = response.json()
    except ValueError as exc:
        raise AiMappingError("AI Gateway returned invalid JSON.") from exc
    if not isinstance(data, dict):
        raise AiMappingError("AI Gateway returned a non-object response.")
    return data


def mapping_timeout_seconds() -> float:
    configured = os.getenv("AI_MAPPING_TIMEOUT_SECONDS")
    legacy = os.getenv("AI_TIMEOUT_SECONDS")
    raw_timeout = configured if configured not in (None, "") else legacy
    try:
        timeout = float(raw_timeout) if raw_timeout not in (None, "") else DEFAULT_MAPPING_TIMEOUT_SECONDS
    except ValueError:
        timeout = DEFAULT_MAPPING_TIMEOUT_SECONDS

    try:
        cap = float(os.getenv("AI_MAPPING_TIMEOUT_CAP_SECONDS", str(DEFAULT_MAPPING_TIMEOUT_CAP_SECONDS)))
    except ValueError:
        cap = DEFAULT_MAPPING_TIMEOUT_CAP_SECONDS

    return max(1.0, min(timeout, cap))
