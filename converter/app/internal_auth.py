from __future__ import annotations

import hmac
import os
from contextvars import ContextVar, Token

from fastapi import Header, HTTPException, Request


_TRUE_VALUES = {"1", "true", "yes"}
_LOCAL_MODE = ContextVar("converter_local_mode", default=False)
_CONVERTER_SERVICE_TOKEN_PLACEHOLDER = "replace-with-a-long-random-secret"
_MIN_PRODUCTION_SERVICE_TOKEN_CHARS = 32


def production_environment() -> bool:
    return os.getenv("NODE_ENV", "").strip().lower() == "production"


def internal_service_token_required() -> bool:
    return True


def bind_local_mode_request(request: Request) -> Token[bool]:
    requested = request.headers.get("x-converter-local-mode", "")
    return _LOCAL_MODE.set(requested.strip().lower() in _TRUE_VALUES)


def reset_local_mode_request(token: Token[bool]) -> None:
    _LOCAL_MODE.reset(token)


def unauthenticated_local_operations_enabled() -> bool:
    return (
        not production_environment()
        and _env_enabled("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS")
        and _LOCAL_MODE.get()
    )


def require_internal_service(
    request: Request,
    x_converter_service_token: str | None = Header(default=None),
) -> str:
    expected = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    supplied = str(x_converter_service_token or "")
    if expected and hmac.compare_digest(supplied, expected):
        return str(getattr(request.state, "request_id", "") or "")
    raise _unauthorized()


def assert_secure_production_config() -> None:
    if not production_environment():
        return

    unsafe: list[str] = []
    if _env_enabled("ALLOW_LEGACY_ROW_EXPORT"):
        unsafe.append("ALLOW_LEGACY_ROW_EXPORT must be false")
    if _env_enabled("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS"):
        unsafe.append("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS must be false")
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if not service_token:
        unsafe.append("CONVERTER_SERVICE_TOKEN must be configured")
    elif len(service_token) < _MIN_PRODUCTION_SERVICE_TOKEN_CHARS:
        unsafe.append("CONVERTER_SERVICE_TOKEN must be at least 32 characters")
    elif service_token == _CONVERTER_SERVICE_TOKEN_PLACEHOLDER:
        unsafe.append("CONVERTER_SERVICE_TOKEN must not use the documented placeholder")
    if not os.getenv("CONVERSION_CONTEXT_SECRET", "").strip():
        unsafe.append("CONVERSION_CONTEXT_SECRET must be configured")
    elif len(os.getenv("CONVERSION_CONTEXT_SECRET", "").strip()) < 32:
        unsafe.append("CONVERSION_CONTEXT_SECRET must be at least 32 characters")
    if _env_enabled("STUDENT_ASSISTANT_ENABLED"):
        anonymization_secret = os.getenv("STUDENT_ANONYMIZATION_SECRET", "").strip()
        if not anonymization_secret:
            unsafe.append("STUDENT_ANONYMIZATION_SECRET must be configured")
        elif len(anonymization_secret) < 32:
            unsafe.append(
                "STUDENT_ANONYMIZATION_SECRET must be at least 32 characters"
            )
    if unsafe:
        raise RuntimeError("Unsafe production converter config: " + "; ".join(unsafe))


def _env_enabled(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in _TRUE_VALUES


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=401, detail="Internal service authentication failed")
