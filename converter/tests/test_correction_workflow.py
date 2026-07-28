from __future__ import annotations

import hashlib
import json

import pytest

from app.correction_workflow import (
    apply_corrections,
    propose_corrections,
    simulate_corrections,
    undo_corrections,
)
from app.excel_io import InputTable
from app.operation_store import OperationStore, OperationStoreConflictError, OperationStoreError


def _session(store: OperationStore):
    return store.create_session(
        upload_id="upload-correction",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="template-v1",
        source_signature={"hash": "source-v1"},
        table=InputTable(
            headers=[
                "Tên nhà cung cấp",
                "Tiền thuế GTGT",
                "TK Nợ",
                "TK",
                "Phân loại hàng hóa dịch vụ",
                "Dấu số tiền",
                "Trường tùy ý",
            ],
            rows=[
                {
                    "Tên nhà cung cấp": "  Công ty A\x00  ",
                    "Tiền thuế GTGT": " 1000 ",
                    "TK Nợ": " 1561 ",
                    "TK": " 331 ",
                    "Phân loại hàng hóa dịch vụ": " Hàng hóa ",
                    "Dấu số tiền": " + ",
                    "Trường tùy ý": " Không rõ ",
                }
            ],
        ),
        raw_sha256="raw-sha",
        ttl_seconds=3600,
    )


def test_proposal_only_contains_safe_non_accounting_text_normalization(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)

    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    assert len(proposal["patches"]) == 1
    patch = proposal["patches"][0]
    assert patch["field"] == "Tên nhà cung cấp"
    assert patch["after_value"] == "Công ty A"
    assert patch["risk"] == "safe"
    assert all(
        item["field"]
        not in {
            "Tiền thuế GTGT",
            "TK Nợ",
            "TK",
            "Phân loại hàng hóa dịch vụ",
            "Dấu số tiền",
            "Trường tùy ý",
        }
        for item in proposal["patches"]
    )


def test_apply_atomically_rechecks_positive_field_eligibility(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    patch_path = (
        store.root
        / session.session_id
        / f"correction-{proposal['patch_set_id']}.json"
    )
    payload = json.loads(patch_path.read_text(encoding="utf-8"))
    payload["patches"][0].update(
        {
            "field": "Trường tùy ý",
            "before_fingerprint": hashlib.sha256(
                json.dumps(
                    " Không rõ ", ensure_ascii=False, sort_keys=True, default=str
                ).encode("utf-8")
            ).hexdigest(),
            "after_value": "Không rõ",
        }
    )
    patch_path.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )

    with pytest.raises(OperationStoreError, match="không được phép"):
        apply_corrections(
            store,
            session_id=session.session_id,
            patch_set_id=proposal["patch_set_id"],
            revision=1,
            state_hash=session.state_hash,
            selected_patch_ids=[proposal["patches"][0]["patch_id"]],
            idempotency_key="tampered-field",
            applied_by="user:user-1",
        )

    assert len(store.list_revisions(session.session_id)) == 1
    assert store.load_session(session.session_id).active_revision == 1


def test_simulation_rejects_semantic_change_disguised_as_safe_normalization(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    patch_path = (
        store.root
        / session.session_id
        / f"correction-{proposal['patch_set_id']}.json"
    )
    payload = json.loads(patch_path.read_text(encoding="utf-8"))
    payload["patches"][0]["after_value"] = "Công ty B"
    patch_path.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )

    with pytest.raises(OperationStoreError, match="không được phép"):
        simulate_corrections(
            store,
            session_id=session.session_id,
            patch_set_id=proposal["patch_set_id"],
            revision=1,
            state_hash=session.state_hash,
            selected_patch_ids=[proposal["patches"][0]["patch_id"]],
        )


def test_simulate_apply_is_atomic_idempotent_and_returns_exact_diff(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    selected = [proposal["patches"][0]["patch_id"]]

    simulation = simulate_corrections(
        store,
        session_id=session.session_id,
        patch_set_id=proposal["patch_set_id"],
        revision=1,
        state_hash=session.state_hash,
        selected_patch_ids=selected,
    )
    applied = apply_corrections(
        store,
        session_id=session.session_id,
        patch_set_id=proposal["patch_set_id"],
        revision=1,
        state_hash=session.state_hash,
        selected_patch_ids=selected,
        idempotency_key="apply-1",
        applied_by="user:user-1",
    )
    duplicate = apply_corrections(
        store,
        session_id=session.session_id,
        patch_set_id=proposal["patch_set_id"],
        revision=1,
        state_hash=session.state_hash,
        selected_patch_ids=selected,
        idempotency_key="apply-1",
        applied_by="user:user-1",
    )

    assert simulation["diffs"] == [
        {
            "patch_id": selected[0],
            "row_id": "r1",
            "field": "Tên nhà cung cấp",
            "before": "  Công ty A\x00  ",
            "after": "Công ty A",
        }
    ]
    assert applied["revision"] == 2
    assert duplicate == applied
    assert len(store.list_revisions(session.session_id)) == 2
    assert store.materialize_table(session.session_id).rows[0]["Tên nhà cung cấp"] == "Công ty A"


def test_apply_rejects_stale_revision_without_partial_patch(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    store.create_revision(
        session.session_id,
        expected_revision=1,
        expected_state_hash=session.state_hash,
        changes={"r1": {"Tên nhà cung cấp": "Đã đổi"}},
        created_by="user:user-1",
        activate=True,
    )

    with pytest.raises(OperationStoreConflictError):
        apply_corrections(
            store,
            session_id=session.session_id,
            patch_set_id=proposal["patch_set_id"],
            revision=1,
            state_hash=session.state_hash,
            selected_patch_ids=[proposal["patches"][0]["patch_id"]],
            idempotency_key="stale",
            applied_by="user:user-1",
        )

    assert store.materialize_table(session.session_id).rows[0]["Tên nhà cung cấp"] == "Đã đổi"


def test_apply_rejects_empty_selection_and_idempotency_key_reuse_with_other_request(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    patch_id = proposal["patches"][0]["patch_id"]

    with pytest.raises(OperationStoreError, match="ít nhất một"):
        apply_corrections(
            store,
            session_id=session.session_id,
            patch_set_id=proposal["patch_set_id"],
            revision=1,
            state_hash=session.state_hash,
            selected_patch_ids=[],
            idempotency_key="empty",
            applied_by="user:user-1",
        )

    applied = apply_corrections(
        store,
        session_id=session.session_id,
        patch_set_id=proposal["patch_set_id"],
        revision=1,
        state_hash=session.state_hash,
        selected_patch_ids=[patch_id],
        idempotency_key="same-key",
        applied_by="user:user-1",
    )
    with pytest.raises(OperationStoreError, match="Idempotency key"):
        apply_corrections(
            store,
            session_id=session.session_id,
            patch_set_id=proposal["patch_set_id"],
            revision=1,
            state_hash=session.state_hash,
            selected_patch_ids=[],
            idempotency_key="same-key",
            applied_by="user:user-1",
        )
    assert applied["revision"] == 2


def test_validation_failure_rolls_back_revision_and_patch_state(tmp_path, monkeypatch):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    monkeypatch.setenv("FEATURE_ANOMALY_DETECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )

    monkeypatch.setattr(
        "app.correction_workflow._validate_proposed_revision",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("validation failed")),
    )

    with pytest.raises(RuntimeError, match="validation failed"):
        apply_corrections(
            store,
            session_id=session.session_id,
            patch_set_id=proposal["patch_set_id"],
            revision=1,
            state_hash=session.state_hash,
            selected_patch_ids=[proposal["patches"][0]["patch_id"]],
            idempotency_key="validation-failure",
            applied_by="user:user-1",
        )

    current = store.load_session(session.session_id)
    assert current.active_revision == 1
    assert current.state_hash == session.state_hash
    assert len(current.revisions) == 1
    assert store.materialize_table(session.session_id).rows[0]["Tên nhà cung cấp"] != "Công ty A"


def test_undo_applied_correction_is_cas_bound_and_returns_exact_inverse_diff(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("FEATURE_BULK_CORRECTION", "true")
    store = OperationStore(tmp_path)
    session = _session(store)
    proposal = propose_corrections(
        store,
        session_id=session.session_id,
        revision=1,
        state_hash=session.state_hash,
    )
    patch_id = proposal["patches"][0]["patch_id"]
    applied = apply_corrections(
        store,
        session_id=session.session_id,
        patch_set_id=proposal["patch_set_id"],
        revision=1,
        state_hash=session.state_hash,
        selected_patch_ids=[patch_id],
        idempotency_key="apply-for-undo",
        applied_by="user:user-1",
    )

    undone = undo_corrections(
        store,
        session_id=session.session_id,
        patch_set_id=proposal["patch_set_id"],
        revision=applied["revision"],
        state_hash=applied["state_hash"],
        idempotency_key="undo-1",
        undone_by="user:user-1",
    )

    assert undone["revision"] == 1
    assert undone["parent_revision"] == 2
    assert undone["inverse_diffs"] == [
        {
            "patch_id": patch_id,
            "row_id": "r1",
            "field": "Tên nhà cung cấp",
            "before": "Công ty A",
            "after": "  Công ty A\x00  ",
        }
    ]
    assert store.materialize_table(session.session_id).rows[0]["Tên nhà cung cấp"] == "  Công ty A\x00  "

    with pytest.raises(OperationStoreConflictError):
        undo_corrections(
            store,
            session_id=session.session_id,
            patch_set_id=proposal["patch_set_id"],
            revision=2,
            state_hash=applied["state_hash"],
            idempotency_key="undo-stale",
            undone_by="user:user-1",
        )
