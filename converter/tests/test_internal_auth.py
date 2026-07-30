from __future__ import annotations

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

    monkeypatch.setenv(
        "CONVERTER_SERVICE_TOKEN", "Svc_7nP3xR8kV2mQ9tW4yZ6aB1dF5hJ0cLs"
    )
    monkeypatch.setenv(
        "CONVERSION_CONTEXT_SECRET", "Ctx_8mQ2vN7xK4pR9sT1wY6zA3dF5gH0jLc"
    )
    assert_secure_production_config()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("CONVERSION_CONTEXT_SECRET", "replace-with-a-long-random-secret"),
        (
            "CONVERSION_CONTEXT_SECRET",
            "replace-with-the-backend-conversion-context-secret",
        ),
        ("CONVERTER_SERVICE_TOKEN", "replace-with-another-long-random-secret"),
        (
            "CONVERTER_SERVICE_TOKEN",
            "replace-with-the-backend-converter-service-token",
        ),
        (
            "CONVERTER_SERVICE_TOKEN",
            "<different-same-private-value-on-both-services>",
        ),
    ],
)
def test_production_auth_config_rejects_documented_placeholders(
    monkeypatch, name, value
):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv(
        "CONVERTER_SERVICE_TOKEN", "Svc_7nP3xR8kV2mQ9tW4yZ6aB1dF5hJ0cLs"
    )
    monkeypatch.setenv(
        "CONVERSION_CONTEXT_SECRET", "Ctx_8mQ2vN7xK4pR9sT1wY6zA3dF5gH0jLc"
    )
    monkeypatch.setenv(name, value)

    with pytest.raises(RuntimeError, match=f"{name}.*high-entropy"):
        assert_secure_production_config()


@pytest.mark.parametrize(
    "name", ["CONVERSION_CONTEXT_SECRET", "CONVERTER_SERVICE_TOKEN"]
)
def test_production_auth_config_rejects_low_entropy_secrets(monkeypatch, name):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv(
        "CONVERTER_SERVICE_TOKEN", "Svc_7nP3xR8kV2mQ9tW4yZ6aB1dF5hJ0cLs"
    )
    monkeypatch.setenv(
        "CONVERSION_CONTEXT_SECRET", "Ctx_8mQ2vN7xK4pR9sT1wY6zA3dF5gH0jLc"
    )
    monkeypatch.setenv(name, "x" * 64)

    with pytest.raises(RuntimeError, match=f"{name}.*high-entropy"):
        assert_secure_production_config()


def test_production_auth_config_requires_distinct_internal_and_context_secrets(
    monkeypatch,
):
    shared = "Shared_7nP3xR8kV2mQ9tW4yZ6aB1dF5hJ0cLs"
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", shared)
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", shared)

    with pytest.raises(RuntimeError, match="must be distinct"):
        assert_secure_production_config()
