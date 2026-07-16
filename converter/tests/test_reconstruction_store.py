from __future__ import annotations

import json
import time

import pytest

from app.reconstruction_store import (
    FilesystemReconstructionStore,
    ReconstructionStoreConflictError,
    ReconstructionStoreError,
    redis_connection_config,
)


def test_filesystem_store_writes_atomically_and_loads(tmp_path):
    store = FilesystemReconstructionStore(tmp_path)
    store.save("run-1", {"value": 1, "expires_at": time.time() + 60})

    assert store.load("run-1")["value"] == 1
    assert json.loads((tmp_path / "run-1.json").read_text(encoding="utf-8"))["value"] == 1
    assert not (tmp_path / "run-1.tmp").exists()


def test_filesystem_store_removes_expired_state(tmp_path):
    store = FilesystemReconstructionStore(tmp_path)
    store.save("run-expired", {"expires_at": time.time() - 1})

    with pytest.raises(ReconstructionStoreError, match="hết hạn"):
        store.load("run-expired")
    assert not (tmp_path / "run-expired.json").exists()


def test_filesystem_store_rejects_stale_state_revision(tmp_path):
    store = FilesystemReconstructionStore(tmp_path)
    state = {"value": 1, "expires_at": time.time() + 60}
    store.save("run-versioned", state)
    assert state["state_revision"] == 1

    stale = {"value": 2, "expires_at": time.time() + 60}
    with pytest.raises(ReconstructionStoreConflictError):
        store.save("run-versioned", stale, expected_state_revision=0)


def test_production_redis_requires_tls_and_environment_namespace(monkeypatch):
    monkeypatch.setenv("RECONSTRUCTION_ENVIRONMENT", "production")
    monkeypatch.setenv("RECONSTRUCTION_REDIS_URL", "redis://redis.internal:6379/0")
    monkeypatch.delenv("RECONSTRUCTION_REDIS_PREFIX", raising=False)

    with pytest.raises(ReconstructionStoreError, match="rediss"):
        redis_connection_config()

    monkeypatch.setenv("RECONSTRUCTION_REDIS_URL", "rediss://redis.internal:6380/0")
    url, prefix = redis_connection_config()
    assert url.startswith("rediss://")
    assert prefix == "ezformat:production:reconstruction"
