from __future__ import annotations

import hashlib
import multiprocessing
from pathlib import Path

import pytest

from app.excel_io import InputTable
from app.operation_store import (
    OperationStore,
    OperationStoreConflictError,
    OperationStoreError,
)


def _concurrent_revision_worker(
    root: str,
    session_id: str,
    state_hash: str,
    value: str,
    barrier,
    results,
) -> None:
    store = OperationStore(Path(root))
    barrier.wait(timeout=10)
    try:
        revision = store.create_revision(
            session_id,
            expected_revision=1,
            expected_state_hash=state_hash,
            changes={"r1": {"So hoa don": value}},
            created_by=f"process:{value}",
            activate=True,
        )
        results.put(("ok", revision.revision))
    except Exception as exc:  # Child-process results must remain pickle-safe.
        results.put((type(exc).__name__, str(exc)))


def _table() -> InputTable:
    return InputTable(
        headers=["So hoa don", "Thanh tien"],
        rows=[
            {"So hoa don": "HD001", "Thanh tien": "1000"},
            {"So hoa don": "HD002", "Thanh tien": "2000"},
        ],
        sheet_name="Data",
        header_row_index=1,
    )


def _session(store: OperationStore):
    raw = b"immutable workbook bytes"
    return store.create_session(
        upload_id="upload-1",
        owner_scope="user:user-1",
        user_id="user-1",
        workspace_id=None,
        target_template_id="misa_purchase_domestic",
        target_template_version="template-sha",
        source_signature={"hash": "source-sha"},
        table=_table(),
        raw_sha256=hashlib.sha256(raw).hexdigest(),
        ttl_seconds=3600,
    )


def test_create_session_persists_normalized_table_and_stable_state_hash(tmp_path):
    store = OperationStore(tmp_path)

    session = _session(store)
    loaded = store.load_session(session.session_id)

    assert loaded.active_revision == 1
    assert loaded.state_hash == session.state_hash
    assert loaded.raw_sha256 == hashlib.sha256(b"immutable workbook bytes").hexdigest()
    assert store.materialize_table(session.session_id) == _table()


def test_revision_write_rejects_stale_state_without_partial_change(tmp_path):
    store = OperationStore(tmp_path)
    session = _session(store)

    derived = store.create_revision(
        session.session_id,
        expected_revision=1,
        expected_state_hash=session.state_hash,
        changes={"r1": {"So hoa don": "HD001-A"}},
        created_by="user:user-1",
        patch_set_id="patch-1",
        activate=True,
    )

    with pytest.raises(OperationStoreConflictError):
        store.create_revision(
            session.session_id,
            expected_revision=1,
            expected_state_hash=session.state_hash,
            changes={"r2": {"So hoa don": "HD002-A"}},
            created_by="user:user-1",
            patch_set_id="patch-stale",
            activate=True,
        )

    loaded = store.load_session(session.session_id)
    assert loaded.active_revision == derived.revision
    assert store.materialize_table(session.session_id).rows[1]["So hoa don"] == "HD002"


def test_activate_parent_revision_undoes_overlay_without_mutating_raw_hash(tmp_path):
    store = OperationStore(tmp_path)
    session = _session(store)
    derived = store.create_revision(
        session.session_id,
        expected_revision=1,
        expected_state_hash=session.state_hash,
        changes={"r1": {"So hoa don": "HD001-A"}},
        created_by="user:user-1",
        patch_set_id="patch-1",
        activate=True,
    )

    restored = store.activate_revision(
        session.session_id,
        revision=1,
        expected_revision=derived.revision,
        expected_state_hash=derived.state_hash,
        activated_by="user:user-1",
    )

    assert restored.active_revision == 1
    assert restored.raw_sha256 == session.raw_sha256
    assert store.materialize_table(session.session_id).rows[0]["So hoa don"] == "HD001"
    assert [item.revision for item in store.list_revisions(session.session_id)] == [1, 2]


def test_mapping_context_is_part_of_revision_state_hash(tmp_path):
    store = OperationStore(tmp_path)
    session = _session(store)

    derived = store.create_revision(
        session.session_id,
        expected_revision=1,
        expected_state_hash=session.state_hash,
        changes={},
        context_changes={"mapping": {"So hoa don": "Số chứng từ (*)"}},
        created_by="user:user-1",
        activate=True,
    )

    assert derived.state_hash != session.state_hash
    assert store.active_context(session.session_id)["mapping"]["So hoa don"] == "Số chứng từ (*)"


def test_revision_cas_is_safe_across_processes(tmp_path):
    store = OperationStore(tmp_path)
    session = _session(store)
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(4)
    results = context.Queue()
    processes = [
        context.Process(
            target=_concurrent_revision_worker,
            args=(
                str(tmp_path),
                session.session_id,
                session.state_hash,
                f"value-{index}",
                barrier,
                results,
            ),
        )
        for index in range(4)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=20)
        assert process.exitcode == 0
    outcomes = [results.get(timeout=5) for _ in processes]

    assert sum(kind == "ok" for kind, _ in outcomes) == 1
    assert sum(kind == "OperationStoreConflictError" for kind, _ in outcomes) == 3
    current = store.load_session(session.session_id)
    assert current.active_revision == 2
    assert len(current.revisions) == 2


@pytest.mark.parametrize(
    ("owner_scope", "user_id", "workspace_id"),
    [
        ("user:user-1", "user-2", None),
        ("workspace:workspace-1", "user-1", "workspace-2"),
        ("local:default", "user-1", None),
        ("unknown:value", None, None),
    ],
)
def test_session_owner_scope_must_match_bound_identity(
    tmp_path, owner_scope, user_id, workspace_id
):
    store = OperationStore(tmp_path)

    with pytest.raises(OperationStoreError, match="Owner scope"):
        store.create_session(
            upload_id="invalid-owner",
            owner_scope=owner_scope,
            user_id=user_id,
            workspace_id=workspace_id,
            target_template_id="bsn_sales",
            target_template_version="v1",
            source_signature={},
            table=_table(),
            raw_sha256="raw",
            ttl_seconds=3600,
        )
