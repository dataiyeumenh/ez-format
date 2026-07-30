from __future__ import annotations

import os

import pytest

from app.internal_auth import assert_secure_production_config, require_internal_service


def test_internal_service_token_uses_constant_time_match(monkeypatch):
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "expected-token")
    request = type("Request", (), {"headers": {}, "state": type("State", (), {"request_id": "req-1"})()})()

    assert require_internal_service(request, "expected-token") == "req-1"
    with pytest.raises(Exception) as error:
        require_internal_service(request, "wrong-token")
    assert getattr(error.value, "status_code", None) == 401


def test_production_auth_config_requires_context_and_strong_service_token(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("CONVERTER_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("CONVERSION_CONTEXT_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="CONVERTER_SERVICE_TOKEN"):
        assert_secure_production_config()

    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "s" * 32)
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", "c" * 32)
    assert_secure_production_config()
