from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import unicodedata
import uuid
from pathlib import Path
from typing import Any

from app.normalization import normalize_header
from app.operation_store import OperationStore, OperationStoreError


class CorrectionFeatureDisabledError(OperationStoreError):
    pass


_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SAFE_TEXT_FIELDS = {
    "ten_nha_cung_cap",
    "nha_cung_cap",
    "ten_nguoi_ban",
    "ten_khach_hang",
    "khach_hang",
    "ten_nguoi_mua",
    "ten_doi_tuong",
    "dia_chi",
    "dia_chi_nha_cung_cap",
    "dia_chi_khach_hang",
    "dien_giai",
    "dien_giai_ly_do_nop",
    "noi_dung",
    "ghi_chu",
    "ten_hang",
    "ten_hang_hoa",
    "ten_vat_tu",
    "ten_dich_vu",
}
_APPLY_LOCKS: dict[str, threading.RLock] = {}
_APPLY_LOCKS_GUARD = threading.Lock()


def bulk_correction_enabled() -> bool:
    return os.getenv("FEATURE_BULK_CORRECTION", "false").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def propose_corrections(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
    state_hash: str,
) -> dict[str, Any]:
    _require_enabled()
    store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    patches: list[dict[str, Any]] = []
    for row in store.materialize_rows_with_ids(session_id, revision=revision):
        row_id = str(row["row_id"])
        for field, value in row["values"].items():
            if not isinstance(value, str) or not _is_safe_text_field(str(field)):
                continue
            normalized = _normalize_safe_text(value)
            if normalized == value:
                continue
            patch_id = str(uuid.uuid4())
            patches.append(
                {
                    "patch_id": patch_id,
                    "operation": "normalize_text",
                    "row_ids": [row_id],
                    "field": str(field),
                    "before_fingerprint": _fingerprint(value),
                    "after_value": normalized,
                    "risk": "safe",
                    "selected_by_default": True,
                    "evidence_ids": [f"evidence:correction:{patch_id}"],
                }
            )
    patch_set = {
        "patch_set_id": str(uuid.uuid4()),
        "session_id": session_id,
        "base_revision": revision,
        "base_state_hash": state_hash,
        "status": "proposed",
        "patches": patches,
        "summary": _summary(patches),
        "applications": {},
    }
    _write_patch_set(store, session_id, patch_set)
    return patch_set


def simulate_corrections(
    store: OperationStore,
    *,
    session_id: str,
    patch_set_id: str,
    revision: int,
    state_hash: str,
    selected_patch_ids: list[str],
) -> dict[str, Any]:
    _require_enabled()
    store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    patch_set = _read_patch_set(store, session_id, patch_set_id)
    _assert_patch_base(patch_set, revision, state_hash)
    selected = _selected_patches(patch_set, selected_patch_ids)
    rows = {
        str(row["row_id"]): row["values"]
        for row in store.materialize_rows_with_ids(session_id, revision=revision)
    }
    diffs: list[dict[str, Any]] = []
    for patch in selected:
        row_id = str(patch["row_ids"][0])
        before = rows[row_id].get(patch["field"])
        if _fingerprint(before) != patch["before_fingerprint"]:
            raise OperationStoreError("Giá trị nguồn của correction đã thay đổi")
        diff = {
            "patch_id": patch["patch_id"],
            "row_id": row_id,
            "field": patch["field"],
            "before": before,
            "after": patch["after_value"],
        }
        _assert_diff_eligible(diff)
        diffs.append(diff)
    patch_set["status"] = "simulated"
    patch_set["last_simulation"] = {
        "selected_patch_ids": selected_patch_ids,
        "diffs": diffs,
        "summary": _summary(selected),
    }
    _write_patch_set(store, session_id, patch_set)
    return patch_set["last_simulation"]


def apply_corrections(
    store: OperationStore,
    *,
    session_id: str,
    patch_set_id: str,
    revision: int,
    state_hash: str,
    selected_patch_ids: list[str],
    idempotency_key: str,
    applied_by: str,
) -> dict[str, Any]:
    _require_enabled()
    if not idempotency_key.strip():
        raise OperationStoreError("Idempotency key là bắt buộc")
    request_hash = _fingerprint(
        {
            "patch_set_id": patch_set_id,
            "revision": revision,
            "state_hash": state_hash,
            "selected_patch_ids": sorted(set(selected_patch_ids)),
        }
    )
    with _apply_lock(session_id):
        patch_set = _read_patch_set(store, session_id, patch_set_id)
        existing = (patch_set.get("applications") or {}).get(idempotency_key)
        if existing is not None:
            if existing.get("request_hash") != request_hash:
                raise OperationStoreError("Idempotency key đã được dùng cho yêu cầu khác")
            return dict(existing["result"])
        if not selected_patch_ids:
            raise OperationStoreError("Phải chọn ít nhất một correction patch")
        simulation = simulate_corrections(
            store,
            session_id=session_id,
            patch_set_id=patch_set_id,
            revision=revision,
            state_hash=state_hash,
            selected_patch_ids=selected_patch_ids,
        )
        changes: dict[str, dict[str, Any]] = {}
        for diff in simulation["diffs"]:
            _assert_diff_eligible(diff)
            changes.setdefault(diff["row_id"], {})[diff["field"]] = diff["after"]
        validation_result: dict[str, Any] | None = None

        def validate_before_commit(table, derived_revision) -> None:
            nonlocal validation_result
            validation_result = _validate_proposed_revision(
                store,
                session_id=session_id,
                table=table,
                revision=derived_revision.revision,
                state_hash=derived_revision.state_hash,
                context=derived_revision.context,
            )

        derived = store.create_revision(
            session_id,
            expected_revision=revision,
            expected_state_hash=state_hash,
            changes=changes,
            created_by=applied_by,
            patch_set_id=patch_set_id,
            activate=True,
            validate=validate_before_commit,
        )
        result = {
            "patch_set_id": patch_set_id,
            "revision": derived.revision,
            "parent_revision": derived.parent_revision,
            "state_hash": derived.state_hash,
            "diffs": simulation["diffs"],
            "summary": simulation["summary"],
        }
        if validation_result is not None:
            from app.anomaly_workflow import _write_payload

            _write_payload(store, session_id, derived.revision, validation_result)
            result["validation"] = validation_result
        patch_set = _read_patch_set(store, session_id, patch_set_id)
        patch_set["status"] = "applied"
        patch_set.setdefault("applications", {})[idempotency_key] = {
            "request_hash": request_hash,
            "result": result,
        }
        _write_patch_set(store, session_id, patch_set)
        return result


def undo_corrections(
    store: OperationStore,
    *,
    session_id: str,
    patch_set_id: str,
    revision: int,
    state_hash: str,
    idempotency_key: str,
    undone_by: str,
) -> dict[str, Any]:
    """Reactivate the exact parent revision, guarded by the active CAS state."""
    _require_enabled()
    if not idempotency_key.strip():
        raise OperationStoreError("Idempotency key là bắt buộc")
    request_hash = _fingerprint(
        {
            "patch_set_id": patch_set_id,
            "revision": revision,
            "state_hash": state_hash,
        }
    )
    with _apply_lock(session_id):
        patch_set = _read_patch_set(store, session_id, patch_set_id)
        existing = (patch_set.get("undos") or {}).get(idempotency_key)
        if existing is not None:
            if existing.get("request_hash") != request_hash:
                raise OperationStoreError("Idempotency key đã được dùng cho yêu cầu khác")
            return dict(existing["result"])

        session = store.assert_current(
            session_id,
            expected_revision=revision,
            expected_state_hash=state_hash,
        )
        applied_result = next(
            (
                item.get("result")
                for item in (patch_set.get("applications") or {}).values()
                if int((item.get("result") or {}).get("revision") or 0) == revision
            ),
            None,
        )
        if not applied_result:
            raise OperationStoreError(
                "Không tìm thấy lần apply correction đang active để undo"
            )
        parent_revision = int(applied_result.get("parent_revision") or 0)
        if parent_revision < 1 or parent_revision >= revision:
            raise OperationStoreError("Revision gốc của correction không hợp lệ")
        inverse_diffs = [
            {
                "patch_id": diff.get("patch_id"),
                "row_id": diff.get("row_id"),
                "field": diff.get("field"),
                "before": diff.get("after"),
                "after": diff.get("before"),
            }
            for diff in applied_result.get("diffs") or []
        ]
        activated = store.activate_revision(
            session_id,
            revision=parent_revision,
            expected_revision=revision,
            expected_state_hash=state_hash,
            activated_by=undone_by,
            activation_reason=f"undo:{patch_set_id}",
        )
        result = {
            "patch_set_id": patch_set_id,
            "revision": activated.active_revision,
            "parent_revision": revision,
            "state_hash": activated.state_hash,
            "inverse_diffs": inverse_diffs,
            "summary": _summary(
                [
                    {
                        "row_ids": [diff.get("row_id")],
                        "field": diff.get("field"),
                    }
                    for diff in inverse_diffs
                ]
            ),
        }
        patch_set["status"] = "undone"
        patch_set.setdefault("undos", {})[idempotency_key] = {
            "request_hash": request_hash,
            "result": result,
        }
        _write_patch_set(store, session_id, patch_set)
        return result


def _is_safe_text_field(field: str) -> bool:
    return normalize_header(field) in _SAFE_TEXT_FIELDS


def _normalize_safe_text(value: str) -> str:
    return unicodedata.normalize("NFC", _CONTROL_CHARACTERS.sub("", value)).strip()


def _selected_patches(
    patch_set: dict[str, Any], selected_patch_ids: list[str]
) -> list[dict[str, Any]]:
    requested = set(selected_patch_ids)
    selected = [
        patch for patch in patch_set.get("patches") or [] if patch.get("patch_id") in requested
    ]
    if len(selected) != len(requested):
        raise OperationStoreError("Correction patch không tồn tại")
    for patch in selected:
        _assert_patch_eligible(patch)
    return selected


def _assert_patch_eligible(patch: dict[str, Any]) -> None:
    if (
        patch.get("operation") != "normalize_text"
        or patch.get("risk") != "safe"
        or not _is_safe_text_field(str(patch.get("field") or ""))
        or len(patch.get("row_ids") or []) != 1
        or not isinstance(patch.get("after_value"), str)
    ):
        raise OperationStoreError("Trường correction không được phép áp dụng hàng loạt")


def _assert_diff_eligible(diff: dict[str, Any]) -> None:
    before = diff.get("before")
    if (
        not _is_safe_text_field(str(diff.get("field") or ""))
        or not isinstance(before, str)
        or diff.get("after") != _normalize_safe_text(before)
    ):
        raise OperationStoreError("Trường correction không được phép áp dụng hàng loạt")


def _assert_patch_base(
    patch_set: dict[str, Any], revision: int, state_hash: str
) -> None:
    if (
        int(patch_set.get("base_revision") or 0) != revision
        or patch_set.get("base_state_hash") != state_hash
    ):
        raise OperationStoreError("Correction patch set không thuộc revision hiện tại")


def _summary(patches: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "affected_rows": len(
            {row_id for patch in patches for row_id in patch.get("row_ids") or []}
        ),
        "affected_fields": len({patch.get("field") for patch in patches}),
        "amount_delta": "0",
        "vat_delta": "0",
    }


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _patch_path(store: OperationStore, session_id: str, patch_set_id: str) -> Path:
    safe_session = "".join(
        char for char in session_id if char.isalnum() or char in {"-", "_"}
    )
    safe_patch = "".join(
        char for char in patch_set_id if char.isalnum() or char in {"-", "_"}
    )
    if safe_session != session_id or safe_patch != patch_set_id:
        raise OperationStoreError("Correction identifier không hợp lệ")
    return store.root / safe_session / f"correction-{safe_patch}.json"


def _write_patch_set(
    store: OperationStore, session_id: str, patch_set: dict[str, Any]
) -> None:
    path = _patch_path(store, session_id, str(patch_set["patch_set_id"]))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(patch_set, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )
    temporary.replace(path)


def _read_patch_set(
    store: OperationStore, session_id: str, patch_set_id: str
) -> dict[str, Any]:
    path = _patch_path(store, session_id, patch_set_id)
    if not path.exists():
        raise OperationStoreError("Correction patch set không tồn tại")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationStoreError("Correction patch set không hợp lệ") from exc


def _require_enabled() -> None:
    if not bulk_correction_enabled():
        raise CorrectionFeatureDisabledError("Bulk Correction đang tắt")


def _validate_proposed_revision(
    store: OperationStore,
    *,
    session_id: str,
    table: Any,
    revision: int,
    state_hash: str,
    context: dict[str, Any],
) -> dict[str, Any] | None:
    if os.getenv("FEATURE_ANOMALY_DETECTION", "false").strip().lower() not in {
        "1",
        "true",
        "yes",
    }:
        return None
    from app.anomaly_workflow import evaluate_anomalies_for_table

    return evaluate_anomalies_for_table(
        store,
        session_id=session_id,
        revision=revision,
        state_hash=state_hash,
        table=table,
        context=context,
    )


def _apply_lock(session_id: str) -> threading.RLock:
    with _APPLY_LOCKS_GUARD:
        return _APPLY_LOCKS.setdefault(session_id, threading.RLock())
