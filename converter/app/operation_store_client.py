from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import re
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.master_data_client import verify_conversion_context_token


LEGACY_NODE_JSON_MAX_BODY_BYTES = 50 * 1024 * 1024
LEGACY_JSON_METADATA_ALLOWANCE_BYTES = 64 * 1024


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
        configured_protocol = os.getenv("OPERATION_STORE_PROTOCOL", "auto").strip().lower()
        if configured_protocol not in {"auto", "raw-v2", "legacy-json-v1"}:
            raise OperationStoreClientError(
                "OPERATION_STORE_PROTOCOL không hợp lệ", status_code=503
            )
        self._configured_protocol = configured_protocol
        self._protocol = "raw-v2" if configured_protocol == "raw-v2" else None
        self._legacy_json_state_encoding: str | None = None
        self._legacy_json_max_body_bytes: int | None = None

    def put_state(
        self,
        *,
        session_id: str,
        run_id: str,
        revision: int,
        expected_revision: int,
        expected_state_sha256: str,
        state: dict[str, Any],
        expires_at: datetime,
    ) -> dict[str, Any]:
        self._assert_binding(session_id, run_id)
        content = json.dumps(
            state,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        _assert_artifact_size(content)
        digest = hashlib.sha256(content).hexdigest()
        if self._operation_protocol() == "legacy-json-v1":
            payload: dict[str, Any] = {
                "run_id": run_id,
                "revision": revision,
                "expected_revision": expected_revision,
                "expected_sha256": expected_state_sha256,
                "expires_at": expires_at.isoformat(),
                "sha256": digest,
            }
            if self._legacy_state_encoding() == "base64":
                payload["state_base64"] = base64.b64encode(content).decode("ascii")
            else:
                payload["state"] = json.loads(content.decode("utf-8"))
            body = _encode_json_body(payload)
            _assert_legacy_node_json_body_size(
                body,
                max_body_bytes=self._legacy_body_limit(),
            )
            return self._request(
                "PUT",
                f"/converter-sessions/{session_id}/state",
                content=body,
                headers={"content-type": "application/json"},
            )
        return self._request(
            "PUT",
            f"/converter-sessions/{session_id}/state",
            params={
                "run_id": run_id,
                "revision": str(revision),
                "expected_revision": str(expected_revision),
                "expected_sha256": expected_state_sha256,
                "sha256": digest,
                "expires_at": expires_at.isoformat(),
            },
            content=content,
        )

    def get_state(self, *, session_id: str, run_id: str) -> dict[str, Any]:
        self._assert_binding(session_id, run_id)
        return self._request(
            "GET",
            f"/converter-sessions/{session_id}/state",
            params={"run_id": run_id},
        )

    def delete_session_artifacts(
        self, *, session_id: str, run_id: str
    ) -> dict[str, Any]:
        self._assert_binding(session_id, run_id)
        return self._request(
            "DELETE",
            f"/converter-sessions/{session_id}/artifacts",
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
        _assert_artifact_size(content)
        digest = hashlib.sha256(content).hexdigest()
        if self._operation_protocol() == "legacy-json-v1":
            body = _encode_json_body(
                {
                    "run_id": run_id,
                    "revision": revision,
                    "content_base64": base64.b64encode(content).decode("ascii"),
                    "content_type": content_type,
                    "expires_at": expires_at.isoformat(),
                    "sha256": digest,
                }
            )
            _assert_legacy_node_json_body_size(
                body,
                max_body_bytes=self._legacy_body_limit(),
            )
            return self._request(
                "PUT",
                f"/converter-sessions/{session_id}/artifacts/{kind}",
                content=body,
                headers={"content-type": "application/json"},
            )
        return self._request(
            "PUT",
            f"/converter-sessions/{session_id}/artifacts/{kind}",
            params={
                "run_id": run_id,
                "revision": str(revision),
                "content_type": content_type,
                "expires_at": expires_at.isoformat(),
                "sha256": digest,
            },
            content=content,
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
        params = {
            "run_id": run_id,
            **({"revision": str(revision)} if revision is not None else {}),
        }
        digest = hashlib.sha256()
        chunks: list[bytes] = []
        size = 0
        try:
            with httpx.stream(
                "GET",
                f"{self.base_url}/converter-sessions/{session_id}/artifacts/{kind}",
                headers=self._headers(),
                params=params,
                timeout=self.timeout_seconds,
            ) as response:
                if response.status_code >= 400:
                    response.read()
                    message, code = _error_details(response)
                    raise OperationStoreClientError(
                        message, status_code=response.status_code, code=code
                    )
                expected = str(
                    response.headers.get("x-artifact-sha256") or ""
                ).lower()
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > _artifact_max_bytes():
                        raise OperationStoreClientError(
                            "Artifact vượt giới hạn kích thước",
                            status_code=413,
                            code="ARTIFACT_TOO_LARGE",
                        )
                    digest.update(chunk)
                    chunks.append(chunk)
        except OperationStoreClientError:
            raise
        except httpx.HTTPError as exc:
            raise OperationStoreClientError(
                f"Không kết nối được Node operation store: {exc}"
            ) from exc
        if expected and digest.hexdigest() != expected:
            raise OperationStoreClientError(
                "Artifact checksum không khớp", status_code=409, code="ARTIFACT_CHECKSUM_MISMATCH"
            )
        return b"".join(chunks)

    def _assert_binding(self, session_id: str, run_id: str) -> None:
        if str(session_id) != self.session_id or str(run_id) != self.run_id:
            raise OperationStoreClientError(
                "Session hoặc run không khớp conversion context",
                status_code=403,
                code="CONTEXT_BINDING_MISMATCH",
            )

    def _operation_protocol(self) -> str:
        if self._protocol == "raw-v2":
            return self._protocol
        if self._protocol == "legacy-json-v1" and getattr(
            self, "_legacy_json_state_encoding", None
        ) in {"base64", "state"}:
            return self._protocol
        configured_protocol = getattr(self, "_configured_protocol", "auto")
        try:
            payload = self._request("GET", "/converter-sessions/protocol")
        except OperationStoreClientError as exc:
            if exc.status_code not in {404, 405}:
                raise
            if configured_protocol == "raw-v2":
                raise OperationStoreClientError(
                    "Node operation store không hỗ trợ raw-v2",
                    status_code=503,
                    code="OPERATION_PROTOCOL_MISMATCH",
                ) from exc
            self._protocol = "legacy-json-v1"
            self._legacy_json_state_encoding = "state"
            self._legacy_json_max_body_bytes = LEGACY_NODE_JSON_MAX_BODY_BYTES
            return self._protocol
        supported = payload.get("supported") if isinstance(payload, dict) else None
        preferred = str(payload.get("preferred") or "") if isinstance(payload, dict) else ""
        if (
            configured_protocol != "legacy-json-v1"
            and preferred == "raw-v2"
            and isinstance(supported, list)
            and "raw-v2" in supported
        ):
            self._protocol = "raw-v2"
            return self._protocol
        if isinstance(supported, list) and "legacy-json-v1" in supported:
            self._protocol = "legacy-json-v1"
            advertised_encoding = str(
                payload.get("legacy_json_state_encoding") or "state"
            ).strip().lower()
            self._legacy_json_state_encoding = (
                "base64" if advertised_encoding == "base64" else "state"
            )
            advertised_limit = payload.get("legacy_json_max_body_bytes")
            self._legacy_json_max_body_bytes = (
                advertised_limit
                if isinstance(advertised_limit, int) and advertised_limit > 0
                else LEGACY_NODE_JSON_MAX_BODY_BYTES
            )
            return self._protocol
        raise OperationStoreClientError(
            "Node operation store không công bố protocol tương thích",
            status_code=503,
            code="OPERATION_PROTOCOL_MISMATCH",
        )

    def _legacy_state_encoding(self) -> str:
        return (
            "base64"
            if getattr(self, "_legacy_json_state_encoding", None) == "base64"
            else "state"
        )

    def _legacy_body_limit(self) -> int:
        configured = getattr(self, "_legacy_json_max_body_bytes", None)
        if isinstance(configured, int) and configured > 0:
            return configured
        if self._legacy_state_encoding() == "state":
            return LEGACY_NODE_JSON_MAX_BODY_BYTES
        return (
            4 * ((_artifact_max_bytes() + 2) // 3)
            + LEGACY_JSON_METADATA_ALLOWANCE_BYTES
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
        headers = self._headers()
        headers.update(kwargs.pop("headers", {}) or {})
        try:
            response = httpx.request(
                method,
                f"{self.base_url}{path}",
                headers=headers,
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


def _encode_json_body(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _assert_legacy_node_json_body_size(
    body: bytes,
    *,
    max_body_bytes: int = LEGACY_NODE_JSON_MAX_BODY_BYTES,
) -> None:
    if len(body) > max_body_bytes:
        raise OperationStoreClientError(
            "Legacy Node 50 MiB JSON protocol cannot carry this artifact; raw-v2 is required",
            status_code=413,
            code="OPERATION_PROTOCOL_SIZE_MISMATCH",
        )


def _artifact_max_bytes() -> int:
    default = 64 * 1024 * 1024
    raw = os.getenv("CONVERTER_ARTIFACT_MAX_BYTES")
    if raw is None or re.fullmatch(r"[0-9]+", raw) is None:
        return default
    configured = int(raw)
    if configured <= 0 or configured > (2**53 - 1):
        configured = default
    return min(configured, 512 * 1024 * 1024)


def _assert_artifact_size(content: bytes) -> None:
    if len(content) > _artifact_max_bytes():
        raise OperationStoreClientError(
            "Artifact vượt giới hạn kích thước",
            status_code=413,
            code="ARTIFACT_TOO_LARGE",
        )


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
