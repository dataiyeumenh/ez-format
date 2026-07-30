from __future__ import annotations

import hashlib
import hmac
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.operation_models import EvidenceItem, EvidencePacket
from app.operation_store import OperationStore, OperationStoreError


def create_evidence_packet(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
    state_hash: str,
    items: list[EvidenceItem],
) -> EvidencePacket:
    session = store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    packet = EvidencePacket(
        packet_id=str(uuid.uuid4()),
        session_id=session_id,
        owner_scope=session.owner_scope,
        revision=revision,
        state_hash=state_hash,
        expires_at=session.expires_at,
        items=items,
        seal="pending",
    )
    payload = packet.model_dump(mode="json", exclude={"seal"})
    packet.seal = _seal(payload)
    _write_packet(store, packet)
    return packet


def load_evidence_packet(
    store: OperationStore,
    *,
    session_id: str,
    packet_id: str,
    revision: int,
    state_hash: str,
) -> EvidencePacket:
    store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    path = _packet_path(store, session_id, packet_id)
    if not path.exists():
        raise OperationStoreError("Evidence packet không tồn tại")
    try:
        packet = EvidencePacket.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise OperationStoreError("Evidence packet không hợp lệ") from exc
    if packet.expires_at <= datetime.now(timezone.utc):
        raise OperationStoreError("Evidence packet đã hết hạn")
    if not validate_packet_seal(packet.model_dump(mode="json")):
        raise OperationStoreError("Evidence packet seal không hợp lệ")
    if (
        packet.session_id != session_id
        or packet.revision != revision
        or packet.state_hash != state_hash
    ):
        raise OperationStoreError("Evidence packet không thuộc revision hiện tại")
    return packet


def validate_packet_seal(packet: dict[str, Any]) -> bool:
    supplied = str(packet.get("seal") or "")
    payload = {key: value for key, value in packet.items() if key != "seal"}
    return bool(supplied) and hmac.compare_digest(supplied, _seal(payload))


def validate_citations(packet: EvidencePacket, citations: list[str]) -> bool:
    if not citations or not packet.items:
        return False
    permitted = {item.evidence_id for item in packet.items}
    return len(citations) == len(set(citations)) and set(citations) <= permitted


def _seal(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hmac.new(_secret(), encoded, hashlib.sha256).hexdigest()


def _secret() -> bytes:
    value = (
        os.getenv("EVIDENCE_PACKET_SECRET", "").strip()
        or os.getenv("CONVERSION_CONTEXT_SECRET", "").strip()
    )
    environment = os.getenv("NODE_ENV", "development").strip().lower()
    if not value and environment in {"production", "prod"}:
        raise OperationStoreError("EVIDENCE_PACKET_SECRET là bắt buộc ở production")
    return (value or "ezformat-local-evidence-development-only").encode("utf-8")


def _write_packet(store: OperationStore, packet: EvidencePacket) -> None:
    path = _packet_path(store, packet.session_id, packet.packet_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(packet.model_dump_json(), encoding="utf-8")
    temporary.replace(path)


def _packet_path(store: OperationStore, session_id: str, packet_id: str) -> Path:
    for value in (session_id, packet_id):
        safe = "".join(char for char in value if char.isalnum() or char in {"-", "_"})
        if safe != value:
            raise OperationStoreError("Evidence identifier không hợp lệ")
    return store.root / session_id / "evidence" / f"{packet_id}.json"
