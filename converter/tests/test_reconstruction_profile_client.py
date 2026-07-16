from __future__ import annotations

import httpx
import pytest

from app.reconstruction_profile_client import (
    ReconstructionProfileClientError,
    assert_reconstruction_profile_current,
)


def test_current_reconstruction_profile_check_uses_version_and_context(monkeypatch):
    monkeypatch.setenv("NODE_INTERNAL_API_URL", "https://node.example/api/internal")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-token")
    captured = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"success": True, "current": True}

    def get(url, **kwargs):
        captured.update({"url": url, **kwargs})
        return Response()

    monkeypatch.setattr("app.reconstruction_profile_client.httpx.get", get)

    assert_reconstruction_profile_current(
        "context-token",
        profile_id="profile-1",
        version=4,
    )

    assert captured["url"].endswith(
        "/reconstruction-profiles/profile-1/current"
    )
    assert captured["params"] == {"version": 4}
    assert captured["headers"]["x-reconstruction-context"] == "context-token"
    assert captured["headers"]["x-converter-service-token"] == "service-token"


def test_stale_reconstruction_profile_returns_clear_error(monkeypatch):
    class Response:
        status_code = 409

        @staticmethod
        def json():
            return {"message": "Profile đã bị thay thế"}

    monkeypatch.setattr(
        "app.reconstruction_profile_client.httpx.get",
        lambda *_args, **_kwargs: Response(),
    )

    with pytest.raises(ReconstructionProfileClientError, match="thay thế"):
        assert_reconstruction_profile_current(
            "context-token",
            profile_id="profile-1",
            version=1,
        )


def test_profile_status_network_failure_is_not_silently_ignored(monkeypatch):
    def get(*_args, **_kwargs):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr("app.reconstruction_profile_client.httpx.get", get)

    with pytest.raises(ReconstructionProfileClientError, match="Không xác minh"):
        assert_reconstruction_profile_current(
            "context-token",
            profile_id="profile-1",
            version=1,
        )
