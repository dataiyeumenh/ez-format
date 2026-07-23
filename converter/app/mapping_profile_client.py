from __future__ import annotations

import os
from typing import Any

import httpx

from app.misa_profiles import MappingProfile


class MappingProfileClientError(ValueError):
    pass


def find_mapping_profile(
    token: str,
    *,
    target_template_id: str,
    source_signature_hash: str,
) -> MappingProfile | None:
    payload = _request(
        "GET",
        "/mapping-profiles/by-signature",
        token,
        params={
            "targetTemplateId": target_template_id,
            "sourceSignatureHash": source_signature_hash,
        },
    )
    profile = payload.get("profile")
    return _profile_from_payload(profile) if isinstance(profile, dict) else None


def get_mapping_profile(token: str, profile_id: str) -> MappingProfile:
    payload = _request("GET", f"/mapping-profiles/{profile_id}", token)
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        raise MappingProfileClientError("Backend trả về mapping profile không hợp lệ")
    return _profile_from_payload(profile)


def save_mapping_profile(
    token: str,
    *,
    name: str,
    target_template_id: str,
    source_signature_hash: str,
    source_headers: list[str],
    sheet_name: str,
    header_row: int,
    mapping: dict[str, Any],
    defaults: dict[str, Any],
    formulas: dict[str, Any],
    confidence: float,
) -> MappingProfile:
    payload = _request(
        "POST",
        "/mapping-profiles",
        token,
        json_body={
            "name": name,
            "targetTemplateId": target_template_id,
            "sourceSignatureHash": source_signature_hash,
            "sourceHeaders": source_headers,
            "sheetName": sheet_name,
            "headerRow": header_row,
            "mapping": mapping,
            "defaults": defaults,
            "formulas": formulas,
            "confidence": confidence,
        },
    )
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        raise MappingProfileClientError("Backend không lưu được mapping profile")
    return _profile_from_payload(profile)


def mark_mapping_profile_used(token: str, profile_id: str) -> None:
    _request("POST", f"/mapping-profiles/{profile_id}/used", token)


def _request(
    method: str,
    path: str,
    token: str,
    *,
    params: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_url = str(
        os.getenv("NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal")
    ).rstrip("/")
    headers = {"x-conversion-context": token}
    service_token = os.getenv("CONVERTER_SERVICE_TOKEN", "").strip()
    if service_token:
        headers["x-converter-service-token"] = service_token
    try:
        response = httpx.request(
            method,
            f"{base_url}{path}",
            headers=headers,
            params=params,
            json=json_body,
            timeout=float(os.getenv("MAPPING_PROFILE_TIMEOUT_SECONDS", "15")),
        )
    except httpx.HTTPError as exc:
        raise MappingProfileClientError(
            f"Không kết nối được kho mapping profile: {exc}"
        ) from exc
    if response.status_code >= 400:
        try:
            detail = response.json().get("message") or response.json().get("detail")
        except ValueError:
            detail = None
        raise MappingProfileClientError(
            f"Kho mapping profile từ chối yêu cầu: {detail or f'HTTP {response.status_code}'}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise MappingProfileClientError(
            "Backend trả về mapping profile không hợp lệ"
        ) from exc
    if not isinstance(payload, dict):
        raise MappingProfileClientError("Backend trả về mapping profile không hợp lệ")
    return payload


def _profile_from_payload(payload: dict[str, Any]) -> MappingProfile:
    workspace_id = str(payload.get("workspaceId") or "")
    owner_scope = str(payload.get("ownerScope") or "").strip()
    if not owner_scope and workspace_id:
        owner_scope = f"workspace:{workspace_id}"
    return MappingProfile(
        id=str(payload.get("id") or ""),
        name=str(payload.get("name") or ""),
        target_template_id=str(payload.get("targetTemplateId") or ""),
        source_signature_hash=str(payload.get("sourceSignatureHash") or ""),
        source_headers=[str(item) for item in payload.get("sourceHeaders") or []],
        sheet_name=str(payload.get("sheetName") or ""),
        header_row=max(1, int(payload.get("headerRow") or 1)),
        mapping=dict(payload.get("mapping") or {}),
        defaults=dict(payload.get("defaults") or {}),
        formulas=dict(payload.get("formulas") or {}),
        confidence=float(payload.get("confidence") or 0),
        usage_count=int(payload.get("usageCount") or 0),
        owner_scope=owner_scope,
        workspace_id=workspace_id,
    )
