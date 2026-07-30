from __future__ import annotations

import base64
import hashlib
import ipaddress
import os
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.master_data_client import verify_conversion_context_token


class OperationStoreClientError(ValueError):
    def __init__(self, message: str, *, status_code: int = 503, code: str = "") -> None:
        self.status_code = status_code
        self.code = code
        super().__init__(message)


class NodeOperationStoreClient:
    """Authenticated client for Node-owned converter session storage."""

    def __init__(
        self,
        context_token: str,
        *,
        base_url: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self.context_token = str(context_token or "").strip()
        if not self.context_token:
            raise OperationStoreClientError(
                "Conversion context token là bắt buộc", status_code=401
            )
        claims = verify_conversion_context_token(self.context_token)
        self.run_id = str(claims.get("conversion_run_id") or "").strip()
        self.session_id = str(claims.get("operation_session_id") or "").strip()
        if not self.run_id or not self.session_id:
            raise OperationStoreClientError(
                "Conversion context thiếu binding session hoặc run", status_code=409
            )
        self.base_url = _validated_base_url(
            base_url
            or os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
        )
        self.timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else _positive_timeout("OPERATION_STORE_TIMEOUT_SECONDS", 15.0)
        )

    def put_state(
        self,
        *,
        session_id: str,
        run_id: str,
        revision: int,
        state: dict[str, Any],
        expires_at: datetime,
    ) -> dict[str, Any]:
        self._assert_binding(session_id, run_id)
        return self._request(
            "PUT",
            f"/converter-sessions/{session_id}/state",
            json={
                "run_id": run_id,
                "revision": revision,
                "state": state,
                "expires_at": expires_at.isoformat(),
            },
        )

    def get_state(self, *, session_id: str, run_id: str) -> dict[str, Any]:
        self._assert_binding(session_id, run_id)
        return self._request(
            "GET",
            f"/converter-sessions/{session_id}/state",
            params={"run_id": run_id},
        )

    def put_artifact(
        self,
        *,
        session_id: str,
        run_id: str,
        kind: str,
        revision: int,
        content: bytes,
        content_type: str,
        expires_at: datetime,
    ) -> dict[str, Any]:
        self._assert_binding(session_id, run_id)
        digest = hashlib.sha256(content).hexdigest()
        return self._request(
            "PUT",
            f"/converter-sessions/{session_id}/artifacts/{kind}",
            json={
                "run_id": run_id,
                "revision": revision,
                "content_base64": base64.b64encode(content).decode("ascii"),
                "content_type": content_type,
                "expires_at": expires_at.isoformat(),
                "sha256": digest,
            },
        )

    def get_artifact(
        self,
        *,
        session_id: str,
        run_id: str,
        kind: str,
        revision: int | None = None,
    ) -> bytes:
        self._assert_binding(session_id, run_id)
        response = self._request_response(
            "GET",
            f"/converter-sessions/{session_id}/artifacts/{kind}",
            params={
                "run_id": run_id,
                **({"revision": str(revision)} if revision is not None else {}),
            },
        )
        content = response.content
        expected = str(response.headers.get("x-artifact-sha256") or "").lower()
        if expected and hashlib.sha256(content).hexdigest() != expected:
            raise OperationStoreClientError(
                "Artifact checksum không khớp", status_code=409, code="ARTIFACT_CHECKSUM_MISMATCH"
            )
        return content

    def _assert_binding(self, session_id: str, run_id: str) -> None:
        if str(session_id) != self.session_id or str(run_id) != self.run_id:
            raise OperationStoreClientError(
                "Session hoặc run không khớp conversion context",
                status_code=403,
                code="CONTEXT_BINDING_MISMATCH",
            )

    def _headers(self) -> dict[str, str]:
        service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
        if not service_token:
            raise OperationStoreClientError(
                "CONVERTER_SERVICE_TOKEN chưa được cấu hình", status_code=503
            )
        return {
            "x-converter-service-token": service_token,
            "x-conversion-context": self.context_token,
        }

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = self._request_response(method, path, **kwargs)
        try:
            payload = response.json()
        except ValueError as exc:
            raise OperationStoreClientError("Node trả về session payload không hợp lệ") from exc
        if not isinstance(payload, dict):
            raise OperationStoreClientError("Node trả về session payload không hợp lệ")
        return payload

    def _request_response(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = httpx.request(
                method,
                f"{self.base_url}{path}",
                headers=self._headers(),
                timeout=self.timeout_seconds,
                **kwargs,
            )
        except httpx.HTTPError as exc:
            raise OperationStoreClientError(
                f"Không kết nối được Node operation store: {exc}"
            ) from exc
        if response.status_code >= 400:
            message, code = _error_details(response)
            raise OperationStoreClientError(message, status_code=response.status_code, code=code)
        return response


def _error_details(response: httpx.Response) -> tuple[str, str]:
    try:
        payload = response.json()
    except ValueError:
        return "Node operation store trả về lỗi", ""
    if not isinstance(payload, dict):
        return "Node operation store trả về lỗi", ""
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "Node operation store trả về lỗi"), str(
            error.get("code") or ""
        )
    return str(payload.get("message") or payload.get("detail") or "Node operation store trả về lỗi"), ""


def _positive_timeout(name: str, default: float) -> float:
    try:
        return max(0.1, float(os.getenv(name, str(default))))
    except ValueError:
        return default


def _validated_base_url(value: str) -> str:
    normalized = str(value or "").strip().rstrip("/")
    try:
        parsed = urlsplit(normalized)
        hostname = parsed.hostname or ""
        _ = parsed.port
    except ValueError as exc:
        raise OperationStoreClientError(
            "NODE_INTERNAL_API_URL không hợp lệ; HTTPS là bắt buộc"
        ) from exc

    if (
        not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise OperationStoreClientError(
            "NODE_INTERNAL_API_URL không hợp lệ; HTTPS là bắt buộc"
        )
    if parsed.scheme.lower() == "https":
        return normalized
    if parsed.scheme.lower() != "http" or not _loopback_host(hostname):
        raise OperationStoreClientError(
            "NODE_INTERNAL_API_URL phải dùng HTTPS ngoài localhost"
        )

    environment = os.getenv("NODE_ENV", "").strip().lower()
    allow_insecure = (
        environment in {"development", "test"}
        and os.getenv("NODE_INTERNAL_ALLOW_INSECURE_LOCALHOST", "")
        .strip()
        .lower()
        in {"1", "true", "yes"}
    )
    if not allow_insecure:
        raise OperationStoreClientError(
            "HTTP localhost chỉ được phép khi development/test bật explicit override; HTTPS là bắt buộc"
        )
    return normalized


def _loopback_host(hostname: str) -> bool:
    if hostname.rstrip(".").lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False
