from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx

from app.excel_io import InputTable
from app.normalization import normalize_header


class MappingProfileV2Error(ValueError):
    def __init__(self, message: str, status_code: int = 409) -> None:
        self.status_code = status_code
        super().__init__(message)


class MappingProfileV2UnavailableError(MappingProfileV2Error):
    def __init__(self, message: str) -> None:
        super().__init__(message, status_code=503)


@dataclass(frozen=True)
class MappingProfileIdentity:
    source_family: str
    document_type: str
    normalized_header_fingerprint: str
    data_shape_fingerprint: str
    target_template_id: str
    target_template_version: str

    def request_payload(self) -> dict[str, str]:
        return {
            "sourceFamily": self.source_family,
            "documentType": self.document_type,
            "headerFingerprint": self.normalized_header_fingerprint,
            "dataShapeFingerprint": self.data_shape_fingerprint,
            "targetTemplateId": self.target_template_id,
            "targetTemplateVersion": self.target_template_version,
        }


@dataclass(frozen=True)
class MappingProfileV2:
    id: str
    version: int
    status: str
    owner_scope: str
    target_template_id: str
    mapping: dict[str, Any]
    defaults: dict[str, Any]
    formulas: dict[str, Any]
    risk_flags: list[str]
    header_fingerprint: str = ""
    data_shape_fingerprint: str = ""
    state_hash: str = ""
    approved_by: str = ""
    confidence: float = 0.0
    name: str = ""
    source_family: str = ""
    document_type: str = ""
    target_template_version: str = ""
    quarantined_at: str = ""
    quarantine_reason: str = ""


@dataclass(frozen=True)
class MappingProfileV2Match:
    match_tier: str
    profile: MappingProfileV2
    warnings: tuple[str, ...] = ()
    approval_state: str = "unapproved"
    approval_applies_to_match: bool = False
    approved_risk_flags: tuple[str, ...] = ()
    unapproved_risk_flags: tuple[str, ...] = ()
    can_suggest: bool = False
    requires_preview: bool = False


def mapping_profile_v2_enabled() -> bool:
    return os.getenv("FEATURE_MAPPING_PROFILE_V2", "false").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def build_profile_identity(
    table: InputTable,
    *,
    target_template_id: str,
    target_template_version: str,
    source_family: str | None = None,
) -> MappingProfileIdentity:
    normalized_headers = [normalize_header(header) for header in table.headers]
    header_payload = {
        "sheet": normalize_header(table.sheet_name or ""),
        "headers": normalized_headers,
    }
    shape_payload: list[dict[str, Any]] = []
    sample = table.rows[:100]
    for header in table.headers:
        values = [row.get(header) for row in sample]
        nonblank = [value for value in values if not _is_blank(value)]
        counts: dict[str, int] = {}
        for value in nonblank:
            kind = _value_kind(value)
            counts[kind] = counts.get(kind, 0) + 1
        dominant = max(counts, key=counts.get) if counts else "blank"
        populated_ratio = len(nonblank) / max(1, len(values))
        shape_payload.append(
            {
                "header": normalize_header(header),
                "dominant": dominant,
                "populated_bucket": round(populated_ratio * 4) / 4,
            }
        )
    resolved_family = (
        str(source_family).strip()
        if source_family is not None
        else normalize_header(table.sheet_name or "unknown")
    )
    return MappingProfileIdentity(
        source_family=resolved_family or "unknown",
        document_type=_document_type(target_template_id),
        normalized_header_fingerprint=_digest(header_payload),
        data_shape_fingerprint=_digest(shape_payload),
        target_template_id=target_template_id,
        target_template_version=target_template_version,
    )


def template_version(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def match_mapping_profile_v2(
    token: str,
    identity: MappingProfileIdentity,
) -> MappingProfileV2Match | None:
    if not mapping_profile_v2_enabled():
        return None
    payload = _request(
        "POST",
        "/mapping-profiles/v2/match",
        token,
        json_body=identity.request_payload(),
    )
    raw_match = payload.get("match")
    if not isinstance(raw_match, dict):
        raise MappingProfileV2Error("Backend trả kết quả match V2 không hợp lệ")
    raw_profile = raw_match.get("profile")
    if not isinstance(raw_profile, dict):
        return None
    match_tier = str(raw_match.get("tier") or "rejected")
    if match_tier not in {"exact", "compatible", "review", "rejected"}:
        raise MappingProfileV2Error("Backend trả match tier V2 không hợp lệ")
    profile = _profile_from_payload(raw_profile)
    approval_state = str(raw_match.get("approvalState") or "unapproved")
    if approval_state not in {"approved", "unapproved"}:
        raise MappingProfileV2Error("Backend trả approval state V2 không hợp lệ")
    approval_applies = bool(raw_match.get("approvalAppliesToMatch"))
    can_suggest = bool(raw_match.get("canSuggest")) and all(
        (
            match_tier == "exact",
            profile.status == "active",
            approval_state == "approved",
            approval_applies,
        )
    )
    risk_flags = tuple(str(item) for item in raw_match.get("riskFlags") or profile.risk_flags)
    approved_risk_flags = (
        tuple(str(item) for item in raw_match.get("approvedRiskFlags") or [])
        if approval_applies
        else ()
    )
    unapproved_risk_flags = tuple(
        str(item)
        for item in (
            raw_match.get("unapprovedRiskFlags")
            or ([] if approval_applies else risk_flags)
        )
    )
    return MappingProfileV2Match(
        match_tier=match_tier,
        profile=profile,
        warnings=tuple(str(item) for item in raw_match.get("driftFields") or []),
        approval_state=approval_state,
        approval_applies_to_match=approval_applies,
        approved_risk_flags=approved_risk_flags,
        unapproved_risk_flags=unapproved_risk_flags,
        can_suggest=can_suggest,
        requires_preview=bool(raw_match.get("requiresPreview")),
    )


def get_mapping_profile_v2(token: str, profile_id: str) -> MappingProfileV2:
    payload = _request("GET", f"/mapping-profiles/v2/{profile_id}", token)
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        raise MappingProfileV2Error("Backend trả mapping profile V2 không hợp lệ")
    return _profile_from_payload(profile)


def confirm_mapping_profile_v2(
    token: str,
    *,
    candidate_profile_id: str,
    source_signature_hash: str,
    target_template_id: str,
    mapping: dict[str, Any],
    defaults: dict[str, Any],
    formulas: dict[str, Any],
    expected_version: int,
) -> MappingProfileV2:
    payload = _request(
        "POST",
        "/mapping-profiles/v2/confirm",
        token,
        json_body={
            "candidate_profile_id": candidate_profile_id,
            "source_signature_hash": source_signature_hash,
            "target_template_id": target_template_id,
            "mapping": mapping,
            "defaults": defaults,
            "formulas": formulas,
            "expected_version": expected_version,
            "user_correction": True,
        },
    )
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        raise MappingProfileV2Error("Backend không xác nhận được mapping profile V2")
    return _profile_from_payload(profile)


def record_confirmed_export_v2(
    token: str,
    *,
    profile_id: str,
    version: int,
    upload_id: str,
    state_hash: str,
) -> None:
    export_id = _digest(
        {
            "profile_id": profile_id,
            "version": version,
            "upload_id": upload_id,
            "state_hash": state_hash,
        }
    )
    _request(
        "POST",
        f"/mapping-profiles/v2/{profile_id}/confirmed-export",
        token,
        json_body={
            "exportId": export_id,
            "version": version,
            "stateHash": state_hash,
        },
    )


def quarantine_mapping_profile_v2(
    token: str,
    *,
    profile_id: str,
    reason: str,
) -> None:
    _request(
        "POST",
        f"/mapping-profiles/v2/{profile_id}/quarantine",
        token,
        json_body={"reason": str(reason or "semantic_validation_failed")[:500]},
    )


def _request(
    method: str,
    path: str,
    token: str,
    *,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_url = os.getenv(
        "NODE_INTERNAL_API_URL", "http://127.0.0.1:5000/api/internal"
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
            json=json_body,
            timeout=float(os.getenv("MAPPING_PROFILE_TIMEOUT_SECONDS", "15")),
        )
    except httpx.HTTPError as exc:
        raise MappingProfileV2UnavailableError(
            f"Không kết nối được mapping profile V2: {exc}"
        ) from exc
    if response.status_code >= 400:
        error_type = (
            MappingProfileV2UnavailableError
            if response.status_code in {404, 502, 503, 504}
            else MappingProfileV2Error
        )
        raise error_type(
            f"Kho mapping profile V2 từ chối yêu cầu: HTTP {response.status_code}"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise MappingProfileV2Error("Backend trả JSON V2 không hợp lệ") from exc
    if not isinstance(payload, dict):
        raise MappingProfileV2Error("Backend trả mapping profile V2 không hợp lệ")
    return payload


def _profile_from_payload(payload: dict[str, Any]) -> MappingProfileV2:
    return MappingProfileV2(
        id=str(payload.get("id") or ""),
        version=max(1, int(payload.get("version") or 1)),
        status=str(payload.get("status") or "draft"),
        owner_scope=str(payload.get("ownerScope") or ""),
        target_template_id=str(
            payload.get("targetTemplateId")
            or ((payload.get("identity") or {}).get("targetTemplateId") if isinstance(payload.get("identity"), dict) else "")
        ),
        header_fingerprint=str(payload.get("headerFingerprint") or ""),
        data_shape_fingerprint=str(payload.get("dataShapeFingerprint") or ""),
        mapping=dict(payload.get("mapping") or {}),
        defaults=dict(payload.get("defaults") or {}),
        formulas=dict(payload.get("formulas") or {}),
        risk_flags=[str(item) for item in payload.get("riskFlags") or []],
        state_hash=str(payload.get("stateHash") or ""),
        approved_by=str(payload.get("approvedBy") or ""),
        confidence=float(payload.get("confidence") or 0),
        name=str(payload.get("name") or ""),
        source_family=str(payload.get("sourceFamily") or ""),
        document_type=str(payload.get("documentType") or ""),
        target_template_version=str(payload.get("targetTemplateVersion") or ""),
        quarantined_at=str(payload.get("quarantinedAt") or ""),
        quarantine_reason=str(payload.get("quarantineReason") or ""),
    )


def _document_type(target_template_id: str) -> str:
    normalized = target_template_id.lower()
    if "purchase" in normalized or "mua" in normalized:
        return "purchase"
    if "sales" in normalized or "sale" in normalized or "ban" in normalized:
        return "sales"
    return "unknown"


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _value_kind(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (datetime, date)):
        return "date"
    if isinstance(value, (int, float, Decimal)):
        return "number"
    text = str(value).strip()
    if not text:
        return "blank"
    if any(separator in text for separator in ("/", "-")) and any(
        char.isdigit() for char in text
    ):
        parts = text.replace("-", "/").split("/")
        if len(parts) == 3 and all(part.isdigit() for part in parts):
            return "date"
    compact = text.replace(".", "").replace(",", "").replace("-", "")
    if compact.isdigit():
        return "number"
    return "text"
