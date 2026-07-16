from __future__ import annotations

import os
from typing import Any

import httpx


class ReconstructionProfileClientError(ValueError):
    pass


def find_reconstruction_profile(
    context_token: str,
    *,
    source_signature_hash: str,
) -> dict[str, Any] | None:
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    headers = {"x-reconstruction-context": context_token}
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if service_token:
        headers["x-converter-service-token"] = service_token
    try:
        response = httpx.get(
            f"{base_url}/reconstruction-profiles/by-signature",
            params={"sourceSignatureHash": source_signature_hash},
            headers=headers,
            timeout=float(os.getenv("NODE_INTERNAL_TIMEOUT_SECONDS", "15")),
        )
    except httpx.HTTPError as exc:
        raise ReconstructionProfileClientError(
            f"Không tải được reconstruction profile: {exc}"
        ) from exc
    if response.status_code >= 400:
        try:
            detail = response.json().get("message") or response.json().get("detail")
        except ValueError:
            detail = None
        raise ReconstructionProfileClientError(
            detail or f"Reconstruction profile HTTP {response.status_code}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ReconstructionProfileClientError(
            "Backend trả reconstruction profile không hợp lệ"
        ) from exc
    profile = payload.get("profile")
    return profile if isinstance(profile, dict) else None


def assert_reconstruction_profile_current(
    context_token: str,
    *,
    profile_id: str,
    version: int,
) -> None:
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    headers = {"x-reconstruction-context": context_token}
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if service_token:
        headers["x-converter-service-token"] = service_token
    try:
        response = httpx.get(
            f"{base_url}/reconstruction-profiles/{profile_id}/current",
            params={"version": int(version)},
            headers=headers,
            timeout=float(os.getenv("NODE_INTERNAL_TIMEOUT_SECONDS", "15")),
        )
    except httpx.HTTPError as exc:
        raise ReconstructionProfileClientError(
            f"Không xác minh được reconstruction profile: {exc}"
        ) from exc
    if response.status_code >= 400:
        try:
            detail = response.json().get("message") or response.json().get("detail")
        except ValueError:
            detail = None
        raise ReconstructionProfileClientError(
            detail or f"Reconstruction profile HTTP {response.status_code}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ReconstructionProfileClientError(
            "Backend trả trạng thái reconstruction profile không hợp lệ"
        ) from exc
    if payload.get("current") is not True:
        raise ReconstructionProfileClientError(
            "Reconstruction profile đã thay đổi; vui lòng phân tích lại file"
        )
