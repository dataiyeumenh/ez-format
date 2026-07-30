from __future__ import annotations

import pytest

from app.operation_store import assert_operation_store_configured


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
