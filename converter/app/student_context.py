from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any

from app.context_secrets import conversion_context_secret


@dataclass(frozen=True)
class StudentContextClaims:
    purpose: str
    session_id: str
    user_id: str
    owner_scope: str
    workspace_id: str | None
    snapshot_set_hash: str | None
    allowed_scopes: tuple[str, ...]
    exp: int
    retention_expires_at: int


def verify_student_context(token: str, required_scope: str) -> StudentContextClaims:
    normalized_scope = str(required_scope or "").strip()
    if not normalized_scope:
        raise ValueError("Student context required scope là bắt buộc")

    secret = conversion_context_secret()

    try:
        header_part, payload_part, signature_part = str(token).split(".")
        header = _decode_json_part(header_part)
        payload = _decode_json_part(payload_part)
        actual_signature = _decode_bytes(signature_part)
    except (TypeError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("Student context token không hợp lệ") from exc

    if header.get("alg") != "HS256":
        raise ValueError("Thuật toán student context không được hỗ trợ")
    signed = f"{header_part}.{payload_part}".encode("ascii")
    expected_signature = hmac.new(
        secret.encode("utf-8"), signed, hashlib.sha256
    ).digest()
    if not hmac.compare_digest(expected_signature, actual_signature):
        raise ValueError("Chữ ký student context không hợp lệ")

    if payload.get("purpose") != "student_file_session":
        raise ValueError("Student context token sai mục đích")

    session_id = str(payload.get("session_id") or "").strip()
    user_id = str(payload.get("user_id") or "").strip()
    owner_scope = str(payload.get("owner_scope") or "").strip()
    if not session_id:
        raise ValueError("Student context thiếu session")
    if not user_id:
        raise ValueError("Student context thiếu user")
    if not owner_scope:
        raise ValueError("Student context thiếu owner scope")

    workspace_value = payload.get("workspace_id")
    workspace_id = (
        str(workspace_value).strip() if workspace_value not in (None, "") else None
    )
    if owner_scope.startswith("workspace:"):
        if not workspace_id or owner_scope != f"workspace:{workspace_id}":
            raise ValueError("Student context owner scope không hợp lệ")
    elif owner_scope != f"user:{user_id}":
        raise ValueError("Student context owner scope không hợp lệ")

    raw_scopes = payload.get("allowed_scopes")
    if not isinstance(raw_scopes, list):
        raise ValueError("Student context scopes không hợp lệ")
    allowed_scopes = tuple(str(scope) for scope in raw_scopes)
    if normalized_scope not in allowed_scopes:
        raise ValueError(f"Student context thiếu quyền {normalized_scope}")

    exp_value = payload.get("exp")
    if isinstance(exp_value, bool):
        raise ValueError("Student context exp không hợp lệ")
    try:
        exp = int(exp_value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Student context exp không hợp lệ") from exc
    if exp <= int(time.time()):
        raise ValueError("Student context token đã hết hạn")

    retention_value = payload.get("retention_expires_at")
    if isinstance(retention_value, bool):
        raise ValueError("Student context retention không hợp lệ")
    try:
        retention_expires_at = int(retention_value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Student context retention không hợp lệ") from exc
    now = int(time.time())
    if retention_expires_at <= now:
        raise ValueError("Student context retention đã hết hạn")
    if retention_expires_at - now > 24 * 60 * 60:
        raise ValueError("Student context retention vượt quá 24 giờ")

    snapshot_value = payload.get("snapshot_set_hash")
    snapshot_set_hash = (
        str(snapshot_value).strip() if snapshot_value not in (None, "") else None
    )
    return StudentContextClaims(
        purpose="student_file_session",
        session_id=session_id,
        user_id=user_id,
        owner_scope=owner_scope,
        workspace_id=workspace_id,
        snapshot_set_hash=snapshot_set_hash,
        allowed_scopes=allowed_scopes,
        exp=exp,
        retention_expires_at=retention_expires_at,
    )


def _decode_json_part(value: str) -> dict[str, Any]:
    decoded = _decode_bytes(value).decode("utf-8")
    payload = json.loads(decoded)
    if not isinstance(payload, dict):
        raise ValueError("JWT part must be a JSON object")
    return payload


def _decode_bytes(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))
