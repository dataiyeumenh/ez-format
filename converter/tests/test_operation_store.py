from __future__ import annotations

import pytest

from app.operation_store import (
    assert_operation_store_configured,
    assert_student_metadata_v1_new_sessions_allowed,
    assert_student_metadata_v1_rollout_configured,
)


def test_operation_store_requires_node_or_explicit_local_provider(monkeypatch):
    monkeypatch.delenv("OPERATION_STORE_PROVIDER", raising=False)
    with pytest.raises(Exception, match="OPERATION_STORE_PROVIDER"):
        assert_operation_store_configured()

    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    assert assert_operation_store_configured() == "node"

    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "local")
    monkeypatch.setenv("NODE_ENV", "production")
    with pytest.raises(Exception, match="development/test"):
        assert_operation_store_configured()


def test_production_student_node_startup_requires_explicit_legacy_drain_gate(
    monkeypatch,
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.delenv("STUDENT_METADATA_V1_ROLLOUT_MODE", raising=False)
    monkeypatch.delenv("STUDENT_METADATA_V1_QUIESCE_ACKNOWLEDGED", raising=False)

    with pytest.raises(Exception, match="STUDENT_METADATA_V1_ROLLOUT_MODE"):
        assert_student_metadata_v1_rollout_configured()

    monkeypatch.setenv("STUDENT_METADATA_V1_ROLLOUT_MODE", "drain")
    with pytest.raises(Exception, match="STUDENT_METADATA_V1_QUIESCE_ACKNOWLEDGED"):
        assert_student_metadata_v1_rollout_configured()


@pytest.mark.parametrize("mode", ["drain", "complete"])
def test_production_student_legacy_drain_gate_accepts_attested_modes(
    monkeypatch,
    mode,
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.setenv("STUDENT_METADATA_V1_ROLLOUT_MODE", mode)
    monkeypatch.setenv("STUDENT_METADATA_V1_QUIESCE_ACKNOWLEDGED", "true")

    assert assert_student_metadata_v1_rollout_configured() == mode


def test_student_legacy_drain_mode_blocks_new_sessions_but_allows_completion(
    monkeypatch,
):
    monkeypatch.setenv("OPERATION_STORE_PROVIDER", "node")
    monkeypatch.setenv("STUDENT_METADATA_V1_ROLLOUT_MODE", "drain")
    with pytest.raises(Exception, match="new Student analyses are disabled"):
        assert_student_metadata_v1_new_sessions_allowed()

    monkeypatch.setenv("STUDENT_METADATA_V1_ROLLOUT_MODE", "complete")
    assert_student_metadata_v1_new_sessions_allowed() is None
