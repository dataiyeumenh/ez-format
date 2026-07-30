from __future__ import annotations

import hmac
import os
from contextvars import ContextVar, Token

from fastapi import Header, HTTPException, Request


_TRUE_VALUES = {"1", "true", "yes"}
_LOCAL_MODE = ContextVar("converter_local_mode", default=False)
_MIN_PRODUCTION_SECRET_CHARS = 32
_MIN_UNIQUE_SECRET_CHARS = 12
_UNSAFE_PRODUCTION_SECRETS = {
    "change-me",
    "changeme",
    "default",
    "dev_change_me_in_production",
    "password",
    "secret",
}


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
    if _env_enabled("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS"):
        unsafe.append("ALLOW_UNAUTHENTICATED_LOCAL_OPERATIONS must be false")
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    context_secret = os.getenv("CONVERSION_CONTEXT_SECRET", "").strip()
    _append_production_secret_error(unsafe, "CONVERTER_SERVICE_TOKEN", service_token)
    _append_production_secret_error(
        unsafe, "CONVERSION_CONTEXT_SECRET", context_secret
    )
    if service_token and context_secret and hmac.compare_digest(
        service_token, context_secret
    ):
        unsafe.append(
            "CONVERTER_SERVICE_TOKEN and CONVERSION_CONTEXT_SECRET must be distinct"
        )
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


def _append_production_secret_error(
    unsafe: list[str], name: str, value: str
) -> None:
    if not value:
        unsafe.append(f"{name} must be configured")
        return
    if not _is_high_entropy_production_secret(value):
        unsafe.append(
            f"{name} must be a high-entropy secret of at least 32 characters, "
            "not an example or placeholder"
        )


def _is_high_entropy_production_secret(value: str) -> bool:
    normalized = value.lower()
    if len(value) < _MIN_PRODUCTION_SECRET_CHARS:
        return False
    if len(set(value)) < _MIN_UNIQUE_SECRET_CHARS:
        return False
    if normalized in _UNSAFE_PRODUCTION_SECRETS:
        return False
    if normalized.startswith(("replace-with-", "your-")):
        return False
    if (
        "change_me_in_production" in normalized
        or "change-me-in-production" in normalized
    ):
        return False
    return not (value.startswith("<") and value.endswith(">"))


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=401, detail="Internal service authentication failed")
