from __future__ import annotations

import os
from typing import Any

import httpx


class AiMappingError(Exception):
    pass


def ai_enabled() -> bool:
    return os.getenv("AI_PROVIDER", "disabled").lower() == "remote_http"


def ai_required() -> bool:
    return os.getenv("AI_REQUIRED", "false").lower() in {"1", "true", "yes"}


def request_mapping_suggestion(payload: dict[str, Any]) -> dict[str, Any]:
    base_url = os.getenv("AI_BASE_URL", "").strip()
    token = os.getenv("AI_TOKEN", "").strip()
    if not base_url:
        raise AiMappingError("AI_BASE_URL is not configured.")
    try:
        timeout = float(os.getenv("AI_TIMEOUT_SECONDS", "20"))
    except ValueError:
        timeout = 20.0

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
