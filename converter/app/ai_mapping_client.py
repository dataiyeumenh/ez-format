from __future__ import annotations

import os
import re
from typing import Any

import httpx

from app.ai_endpoint_policy import validate_remote_ai_endpoint


class AiMappingError(Exception):
    def __init__(
        self,
        message: str,
        *,
        gateway: str = "offline",
        model: str = "unknown",
    ) -> None:
        self.gateway = gateway
        self.model = model
        super().__init__(message)


DEFAULT_MAPPING_TIMEOUT_SECONDS = 60.0
DEFAULT_MAPPING_TIMEOUT_CAP_SECONDS = 120.0
MAX_MAPPING_HEADERS = 128
MAX_HEADER_LENGTH = 160
MAX_SAMPLE_ROWS = 3
MAX_PROFILE_SUMMARIES = 3


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
        base_url = validate_remote_ai_endpoint(base_url)
    except ValueError as exc:
        raise AiMappingError(str(exc)) from exc
    timeout = mapping_timeout_seconds()

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    safe_payload = redact_mapping_payload(payload)
    try:
        response = httpx.post(base_url, json=safe_payload, headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise AiMappingError(f"AI Gateway request failed: {exc}") from exc

    if response.status_code >= 400:
        raise AiMappingError(
            f"AI Gateway returned HTTP {response.status_code}.",
            gateway="online",
            model="offline" if response.status_code in {502, 503, 504} else "unknown",
        )
    try:
        data = response.json()
    except ValueError as exc:
        raise AiMappingError(
            "AI Gateway returned invalid JSON.", gateway="online", model="unknown"
        ) from exc
    if not isinstance(data, dict):
        raise AiMappingError(
            "AI Gateway returned a non-object response.",
            gateway="online",
            model="unknown",
        )
    _validate_mapping_response(
        data,
        expected_target_template_id=str(
            (payload.get("target_template") or {}).get("id") or ""
        ),
    )
    return data


def redact_mapping_payload(payload: dict[str, Any]) -> dict[str, Any]:
    target = payload.get("target_template") if isinstance(payload.get("target_template"), dict) else {}
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    source_headers = _bounded_strings(source.get("headers"), MAX_MAPPING_HEADERS)
    return {
        "target_template": {
            "id": str(target.get("id") or ""),
            "headers": _bounded_strings(target.get("headers"), MAX_MAPPING_HEADERS),
        },
        "source": {
            "sheet_name": "<sheet>",
            "headers": source_headers,
            "sample_rows": _redact_sample_rows(source.get("sample_rows"), source_headers),
        },
        "nearby_profiles": _redact_profile_summaries(payload.get("nearby_profiles")),
    }


def _redact_sample_rows(value: Any, headers: list[str]) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    allowed = set(headers)
    output: list[dict[str, str]] = []
    for row in value[:MAX_SAMPLE_ROWS]:
        if not isinstance(row, dict):
            continue
        output.append(
            {
                str(header): _redacted_sample_value(item)
                for header, item in row.items()
                if header in allowed
            }
        )
    return output


def _bounded_strings(value: Any, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item)[:MAX_HEADER_LENGTH] for item in value[:limit] if item is not None]


def _redact_profile_summaries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    output: list[dict[str, Any]] = []
    for profile in value[:MAX_PROFILE_SUMMARIES]:
        if not isinstance(profile, dict):
            continue
        summary: dict[str, Any] = {
            "target_template_id": str(profile.get("target_template_id") or "")[:MAX_HEADER_LENGTH],
            "source_headers": _bounded_strings(profile.get("source_headers"), MAX_MAPPING_HEADERS),
        }
        try:
            summary["confidence"] = max(0.0, min(1.0, float(profile.get("confidence"))))
        except (TypeError, ValueError):
            pass
        output.append(summary)
    return output


def _validate_mapping_response(
    data: dict[str, Any], *, expected_target_template_id: str
) -> None:
    returned_template_id = data.get("target_template_id")
    if returned_template_id and str(returned_template_id) != expected_target_template_id:
        raise _invalid_response("AI Gateway returned a different target template.")
    for key in ("mapping", "defaults", "formulas"):
        if key in data and not isinstance(data[key], dict):
            raise _invalid_response(f"AI Gateway field '{key}' must be an object.")
    if "notes" in data and not isinstance(data["notes"], list):
        raise _invalid_response("AI Gateway field 'notes' must be a list.")
    mapping = data.get("mapping") or {}
    for source_header, target_spec in mapping.items():
        if not isinstance(source_header, str):
            raise _invalid_response("AI Gateway mapping keys must be strings.")
        targets = target_spec if isinstance(target_spec, list) else [target_spec]
        if not all(isinstance(target, str) for target in targets):
            raise _invalid_response(
                "AI Gateway mapping values must be strings or string lists."
            )


def _invalid_response(message: str) -> AiMappingError:
    return AiMappingError(message, gateway="online", model="unknown")


def _redacted_sample_value(value: Any) -> str:
    if value is None or value == "":
        return "<blank>"
    if isinstance(value, (int, float)):
        return "<number>"
    text = str(value).strip()
    if re.fullmatch(r"\d{1,4}[-/]\d{1,2}[-/]\d{1,4}", text):
        return "<date>"
    normalized = text.casefold()
    if normalized in {"hàng hóa", "hang hoa", "goods"}:
        return "hang_hoa"
    if normalized in {"dịch vụ", "dich vu", "service"}:
        return "dich_vu"
    return "<text>"


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
