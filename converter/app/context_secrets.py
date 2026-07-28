from __future__ import annotations

import os


_TRUE_VALUES = {"1", "true", "yes"}


def conversion_context_secret() -> str:
    dedicated = os.getenv("CONVERSION_CONTEXT_SECRET", "").strip()
    if dedicated:
        return dedicated

    environment = os.getenv("NODE_ENV", "").strip().lower()
    allow_development_fallback = (
        environment in {"development", "test"}
        and os.getenv("CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK", "")
        .strip()
        .lower()
        in _TRUE_VALUES
    )
    fallback = os.getenv("JWT_SECRET", "").strip()
    if allow_development_fallback and fallback:
        return fallback
    raise ValueError("CONVERSION_CONTEXT_SECRET chưa được cấu hình")
