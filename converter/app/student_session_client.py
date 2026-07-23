from __future__ import annotations

import os
from typing import Any

import httpx


class StudentSessionClientError(ValueError):
    def __init__(self, message: str, *, status_code: int = 503) -> None:
        self.status_code = status_code
        super().__init__(message)


def assert_student_session_active(
    token: str,
    session_id: str,
    upload_id: str,
    required_scope: str = "ask",
) -> None:
    normalized_session_id = str(session_id or "").strip()
    normalized_upload_id = str(upload_id or "").strip()
    if not normalized_session_id:
        raise StudentSessionClientError("Thiếu student session id để kiểm tra")
    if not normalized_upload_id:
        raise StudentSessionClientError(
            "Thiếu converter upload id để kiểm tra phiên học",
            status_code=409,
        )
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if not service_token:
        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    try:
        response = httpx.get(
            f"{base_url}/student/sessions/{normalized_session_id}/active",
            headers={
                "x-converter-service-token": service_token,
                "x-student-context": token,
            },
            params={
                "uploadId": normalized_upload_id,
                **({"scope": required_scope} if required_scope != "ask" else {}),
            },
            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
        )
    except httpx.HTTPError as exc:
        raise StudentSessionClientError(
            f"Không kiểm tra được trạng thái phiên học: {exc}",
            status_code=503,
        ) from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if response.status_code >= 400:
        mapped_status = (
            response.status_code
            if response.status_code in {403, 409, 410}
            else 503
        )
        detail = payload.get("message") or payload.get("detail")
        raise StudentSessionClientError(
            detail or f"Backend từ chối kiểm tra phiên học: HTTP {response.status_code}",
            status_code=mapped_status,
        )
    if payload.get("active") is not True:
        raise StudentSessionClientError(
            "Backend không xác nhận phiên học đang hoạt động",
            status_code=503,
        )


def record_analysis_completed(token: str, payload: dict[str, Any]) -> None:
    session_id = str(payload.get("sessionId") or "").strip()
    if not session_id:
        raise StudentSessionClientError("Thiếu student session id để đồng bộ")
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if not service_token:
        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    try:
        response = httpx.post(
            f"{base_url}/student/sessions/{session_id}/events",
            headers={
                "x-converter-service-token": service_token,
                "x-student-context": token,
            },
            json=payload,
            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
        )
    except httpx.HTTPError as exc:
        raise StudentSessionClientError(
            f"Không đồng bộ được metadata phiên học: {exc}"
        ) from exc
    if response.status_code >= 400:
        try:
            body = response.json()
            detail = body.get("message") or body.get("detail")
        except ValueError:
            detail = None
        raise StudentSessionClientError(
            f"Backend từ chối metadata phiên học: {detail or f'HTTP {response.status_code}'}"
        )


def record_question_event(token: str, payload: dict[str, Any]) -> None:
    session_id = str(payload.get("sessionId") or "").strip()
    if not session_id:
        raise StudentSessionClientError("Thiếu student session id để ghi nhận câu hỏi")
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if not service_token:
        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    try:
        response = httpx.post(
            f"{base_url}/student/sessions/{session_id}/questions",
            headers={
                "x-converter-service-token": service_token,
                "x-student-context": token,
            },
            json=payload,
            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
        )
    except httpx.HTTPError as exc:
        raise StudentSessionClientError(
            f"Không ghi nhận được student question event: {exc}"
        ) from exc
    if response.status_code >= 400:
        try:
            body = response.json()
            detail = body.get("message") or body.get("detail")
        except ValueError:
            detail = None
        raise StudentSessionClientError(
            f"Backend từ chối student question event: {detail or f'HTTP {response.status_code}'}"
        )


def record_attempt_completed(token: str, payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("sessionId") or "").strip()
    if not session_id:
        raise StudentSessionClientError("Thiếu student session id để ghi nhận bài làm")
    return _post_student_metadata(
        token,
        payload,
        path=f"student/sessions/{session_id}/attempts",
        failure_message="Không ghi nhận được student attempt",
    )


def record_hint_revealed(token: str, payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("sessionId") or "").strip()
    attempt_id = str(payload.get("attemptId") or "").strip()
    if not session_id or not attempt_id:
        raise StudentSessionClientError("Thiếu student session hoặc attempt id")
    return _post_student_metadata(
        token,
        payload,
        path=f"student/sessions/{session_id}/attempts/{attempt_id}/hints",
        failure_message="Không ghi nhận được student hint",
    )


def record_activity_event(token: str, payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("sessionId") or "").strip()
    if not session_id:
        raise StudentSessionClientError("Thiếu student session id để ghi nhận hoạt động")
    return _post_student_metadata(
        token,
        payload,
        path=f"student/sessions/{session_id}/activities",
        failure_message="Không ghi nhận được student activity",
    )


def get_verified_activities(token: str, session_id: str) -> dict[str, Any]:
    normalized_session_id = str(session_id or "").strip()
    if not normalized_session_id:
        raise StudentSessionClientError("Thiếu student session id để tải hoạt động")
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if not service_token:
        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    try:
        response = httpx.get(
            f"{base_url}/student/sessions/{normalized_session_id}/activities",
            headers={
                "x-converter-service-token": service_token,
                "x-student-context": token,
            },
            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
        )
    except httpx.HTTPError as exc:
        raise StudentSessionClientError(
            f"Không tải được student activity: {exc}"
        ) from exc
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400:
        detail = body.get("message") or body.get("detail")
        mapped_status = (
            response.status_code
            if response.status_code in {400, 403, 404, 409, 410}
            else 503
        )
        raise StudentSessionClientError(
            f"Backend từ chối student activity: {detail or f'HTTP {response.status_code}'}",
            status_code=mapped_status,
        )
    if not isinstance(body, dict) or body.get("success") is not True:
        raise StudentSessionClientError("Backend không xác nhận student activity")
    return body


def _post_student_metadata(
    token: str,
    payload: dict[str, Any],
    *,
    path: str,
    failure_message: str,
) -> dict[str, Any]:
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if not service_token:
        raise StudentSessionClientError("CONVERTER_SERVICE_TOKEN chưa được cấu hình")
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    try:
        response = httpx.post(
            f"{base_url}/{path.lstrip('/')}",
            headers={
                "x-converter-service-token": service_token,
                "x-student-context": token,
            },
            json=payload,
            timeout=float(os.getenv("STUDENT_SESSION_SYNC_TIMEOUT_SECONDS", "5")),
        )
    except httpx.HTTPError as exc:
        raise StudentSessionClientError(f"{failure_message}: {exc}") from exc
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400:
        detail = body.get("message") or body.get("detail")
        mapped_status = response.status_code if response.status_code in {400, 403, 404, 409, 410} else 503
        raise StudentSessionClientError(
            f"Backend từ chối student metadata: {detail or f'HTTP {response.status_code}'}",
            status_code=mapped_status,
        )
    if not isinstance(body, dict) or body.get("success") is not True:
        raise StudentSessionClientError("Backend không xác nhận student metadata")
    return body
