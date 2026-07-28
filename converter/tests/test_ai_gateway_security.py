from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from app.ai_gateway import _call_ai_with_backpressure, _validated_ollama_base_url


def test_gateway_allows_local_ollama_default(monkeypatch):
    monkeypatch.delenv("AI_PRIVATE_LOCAL_HOST_ALLOWLIST", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")

    assert _validated_ollama_base_url() == "http://127.0.0.1:11434"


def test_gateway_rejects_public_plaintext_ollama(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.example.test:11434")

    with pytest.raises(HTTPException, match="requires HTTPS"):
        _validated_ollama_base_url()


def test_gateway_rejects_private_ollama_without_allowlist(monkeypatch):
    monkeypatch.delenv("AI_PRIVATE_LOCAL_HOST_ALLOWLIST", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://192.168.1.20:11434")

    with pytest.raises(HTTPException, match="not in allowlist"):
        _validated_ollama_base_url()


def test_gateway_allows_explicit_private_ollama_allowlist(monkeypatch):
    monkeypatch.setenv("AI_PRIVATE_LOCAL_HOST_ALLOWLIST", "192.168.1.20")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://192.168.1.20:11434")

    assert _validated_ollama_base_url() == "http://192.168.1.20:11434"


def test_gateway_rejects_ai_request_when_concurrency_slots_are_exhausted(monkeypatch):
    import app.ai_gateway as gateway

    monkeypatch.setattr(gateway, "_AI_REQUEST_SLOTS", asyncio.BoundedSemaphore(0))
    called = False

    async def handler(_payload):
        nonlocal called
        called = True
        return {}

    with pytest.raises(HTTPException, match="busy"):
        asyncio.run(_call_ai_with_backpressure(handler, {}))

    assert called is False
