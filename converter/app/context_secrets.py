from __future__ import annotations

import os


def conversion_context_secret() -> str:
    dedicated = os.getenv("CONVERSION_CONTEXT_SECRET", "").strip()
    if dedicated:
        return dedicated
    environment = os.getenv("NODE_ENV", "").strip().lower()
    fallback_allowed = environment in {"development", "test"} and os.getenv(
        "CONVERSION_CONTEXT_ALLOW_JWT_SECRET_FALLBACK", ""
    ).strip().lower() in {"1", "true", "yes"}
    fallback = os.getenv("JWT_SECRET", "").strip()
    if fallback_allowed and fallback:
        return fallback
    raise ValueError("CONVERSION_CONTEXT_SECRET chưa được cấu hình")
