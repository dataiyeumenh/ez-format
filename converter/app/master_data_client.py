from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

import httpx

from app.context_secrets import conversion_context_secret


class ConversionContextError(ValueError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(message)


_CONTEXT_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def verify_conversion_context_token(token: str) -> dict[str, Any]:
    payload = _verify_signed_context_token(token)
    if payload.get("purpose") not in {"misa_conversion", "misa_reconstruction"}:
        raise ConversionContextError("Conversion context token sai mục đích")
    payload["owner_scope"] = conversion_context_owner_scope(payload)
    return payload


def conversion_context_owner_scope(payload: dict[str, Any]) -> str:
    user_id = str(payload.get("user_id") or "").strip()
    workspace_id = str(payload.get("workspace_id") or "").strip()
    if workspace_id:
        if not payload.get("snapshot_set_hash"):
            raise ConversionContextError("Conversion context token thiếu phạm vi dữ liệu")
        expected = f"workspace:{workspace_id}"
    else:
        if not user_id:
            raise ConversionContextError("Conversion context token thiếu user")
        expected = f"user:{user_id}"
    supplied = str(payload.get("owner_scope") or "").strip()
    if supplied and supplied != expected:
        raise ConversionContextError("Conversion context token có owner scope không hợp lệ")
    return expected


def verify_reconstruction_context_token(
    token: str,
    *,
    required_scope: str | None = None,
) -> dict[str, Any]:
    payload = _verify_signed_context_token(token)
    if payload.get("purpose") != "misa_reconstruction":
        raise ConversionContextError("Reconstruction context token sai mục đích")
    if not payload.get("run_id") or not payload.get("user_id"):
        raise ConversionContextError("Reconstruction context token thiếu run hoặc user")
    if required_scope and required_scope not in (payload.get("scopes") or []):
        raise ConversionContextError(
            f"Reconstruction context thiếu quyền {required_scope}"
        )
    return payload


def _verify_signed_context_token(token: str) -> dict[str, Any]:
    try:
        secret = conversion_context_secret()
    except ValueError as exc:
        raise ConversionContextError(str(exc)) from exc
    try:
        header_part, payload_part, signature_part = token.split(".")
        header = json.loads(_decode_part(header_part))
        payload = json.loads(_decode_part(payload_part))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ConversionContextError("Conversion context token không hợp lệ") from exc
    if header.get("alg") != "HS256":
        raise ConversionContextError("Thuật toán conversion context không được hỗ trợ")
    signed = f"{header_part}.{payload_part}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).digest()
    try:
        actual = _decode_bytes(signature_part)
    except ValueError as exc:
        raise ConversionContextError("Chữ ký conversion context không hợp lệ") from exc
    if not hmac.compare_digest(expected, actual):
        raise ConversionContextError("Chữ ký conversion context không hợp lệ")
    if int(payload.get("exp") or 0) <= int(time.time()):
        raise ConversionContextError("Conversion context token đã hết hạn")
    return payload


def fetch_master_data_context(token: str) -> dict[str, Any]:
    claims = verify_conversion_context_token(token)
    snapshot_hash = str(claims["snapshot_set_hash"])
    now = time.time()
    _prune_context_cache(now)
    cache_key = f"{snapshot_hash}:{int(claims.get('master_data_revision') or 0)}"
    cached = _CONTEXT_CACHE.get(cache_key)
    if cached and cached[0] > now:
        _validate_cached_context(token, snapshot_hash)
        return cached[1]

    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    headers = {"x-conversion-context": token}
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if service_token:
        headers["x-converter-service-token"] = service_token
    try:
        response = httpx.get(
            f"{base_url}/master-data/context/{snapshot_hash}",
            headers=headers,
            timeout=float(os.getenv("MASTER_DATA_CONTEXT_TIMEOUT_SECONDS", "15")),
        )
    except httpx.HTTPError as exc:
        raise ConversionContextError(f"Không tải được danh mục MISA: {exc}") from exc
    if response.status_code >= 400:
        try:
            detail = response.json().get("message") or response.json().get("detail")
        except ValueError:
            detail = None
        raise ConversionContextError(
            f"Không tải được danh mục MISA: {detail or f'HTTP {response.status_code}'}",
            status_code=response.status_code,
        )
    try:
        context = response.json()
    except ValueError as exc:
        raise ConversionContextError("Backend trả về danh mục MISA không hợp lệ") from exc
    if context.get("snapshotSetHash") != snapshot_hash:
        raise ConversionContextError("Snapshot danh mục MISA không khớp")
    ttl = max(30, int(os.getenv("MASTER_DATA_CONTEXT_CACHE_SECONDS", "300")))
    _CONTEXT_CACHE[cache_key] = (now + ttl, context)
    return context


def clear_master_data_context_cache() -> None:
    _CONTEXT_CACHE.clear()


def _prune_context_cache(now: float) -> None:
    expired = [key for key, (expires_at, _) in _CONTEXT_CACHE.items() if expires_at <= now]
    for key in expired:
        _CONTEXT_CACHE.pop(key, None)
    if len(_CONTEXT_CACHE) <= 128:
        return
    oldest = sorted(_CONTEXT_CACHE.items(), key=lambda item: item[1][0])
    for key, _ in oldest[: len(_CONTEXT_CACHE) - 128]:
        _CONTEXT_CACHE.pop(key, None)


def _validate_cached_context(token: str, snapshot_hash: str) -> None:
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    headers = {"x-conversion-context": token}
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if service_token:
        headers["x-converter-service-token"] = service_token
    try:
        response = httpx.get(
            f"{base_url}/master-data/context-status/{snapshot_hash}",
            headers=headers,
            timeout=float(os.getenv("MASTER_DATA_CONTEXT_TIMEOUT_SECONDS", "15")),
        )
    except httpx.HTTPError as exc:
        raise ConversionContextError(f"Không xác minh được danh mục MISA: {exc}") from exc
    if response.status_code >= 400:
        try:
            detail = response.json().get("message") or response.json().get("detail")
        except ValueError:
            detail = None
        raise ConversionContextError(
            f"Không xác minh được danh mục MISA: {detail or f'HTTP {response.status_code}'}",
            status_code=response.status_code,
        )
def _decode_part(value: str) -> str:
    return _decode_bytes(value).decode("utf-8")


def _decode_bytes(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid base64") from exc
