from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import _normalize_reconstruction_response, app
from fastapi import HTTPException
from app.ai_reconstruction_client import (
    AiReconstructionError,
    clear_reconstruction_suggestion_cache,
    normalize_reconstruction_suggestion,
    redact_reconstruction_sample_rows,
    request_reconstruction_suggestion,
)


client = TestClient(app)


def test_ai_reconstruction_rejects_unknown_headers_and_fields():
    with pytest.raises(AiReconstructionError, match="semantic/header"):
        normalize_reconstruction_suggestion(
            {
                "field_roles": {
                    "invoice": "Số hóa đơn",
                    "unsafe": "Số hóa đơn",
                },
                "grouping_keys": ["invoice_number"],
                "direction": "PURCHASE",
                "nature": "goods",
                "confidence": 0.9,
                "notes": ["Cần kiểm tra"],
            },
            source_headers=["Số hóa đơn", "MST NCC"],
        )


def test_ai_reconstruction_redacts_transaction_values_before_http(monkeypatch):
    clear_reconstruction_suggestion_cache()
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv(
        "AI_RECONSTRUCTION_BASE_URL",
        "https://ai.example.test/v1/misa/suggest-reconstruction",
    )
    captured = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "field_roles": {"invoice": "Số hóa đơn"},
                "grouping_keys": ["invoice_number"],
                "direction": "purchase",
                "nature": "goods",
                "confidence": 0.9,
                "notes": [],
            }

    def post(*_args, **kwargs):
        captured.update(kwargs)
        return Response()

    monkeypatch.setattr("app.ai_reconstruction_client.httpx.post", post)
    headers = ["Số hóa đơn", "Nhà cung cấp", "Thành tiền", "Phân loại"]
    payload = {
        "source": {
            "headers": headers,
            "sample_rows": redact_reconstruction_sample_rows(
                [
                    {
                        "Số hóa đơn": "000123",
                        "Nhà cung cấp": "Công ty nhạy cảm",
                        "Thành tiền": 200000,
                        "Phân loại": "Hàng hóa",
                    }
                ],
                headers,
            ),
        }
    }

    request_reconstruction_suggestion(payload, cache_key="redaction")

    serialized = str(captured["json"])
    assert "000123" not in serialized
    assert "Công ty nhạy cảm" not in serialized
    assert "200000" not in serialized
    assert "hang_hoa" in serialized
    assert captured["headers"]["X-Request-ID"]
    clear_reconstruction_suggestion_cache()


def test_ai_reconstruction_rejects_plaintext_public_remote_endpoint(monkeypatch):
    clear_reconstruction_suggestion_cache()
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv(
        "AI_RECONSTRUCTION_BASE_URL",
        "http://ai.example.test/v1/misa/suggest-reconstruction",
    )
    monkeypatch.setattr(
        "app.ai_reconstruction_client.httpx.post",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("plaintext endpoint reached HTTP")
        ),
    )

    with pytest.raises(AiReconstructionError, match="HTTPS"):
        request_reconstruction_suggestion(
            {"source": {"headers": ["Số hóa đơn"], "sample_rows": []}},
            cache_key="plaintext",
        )


def test_ai_reconstruction_client_redacts_even_when_caller_passes_raw_rows(monkeypatch):
    clear_reconstruction_suggestion_cache()
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv(
        "AI_RECONSTRUCTION_BASE_URL",
        "https://ai.example.test/v1/misa/suggest-reconstruction",
    )
    captured = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "field_roles": {},
                "grouping_keys": [],
                "direction": "unknown",
                "nature": "unknown",
                "confidence": 0,
                "notes": [],
            }

    monkeypatch.setattr(
        "app.ai_reconstruction_client.httpx.post",
        lambda *_args, **kwargs: captured.update(kwargs) or Response(),
    )
    request_reconstruction_suggestion(
        {
            "source": {
                "headers": ["Số hóa đơn", "MST NCC", "Thành tiền"],
                "sample_rows": [
                    {
                        "Số hóa đơn": "000123",
                        "MST NCC": "0312345678",
                        "Thành tiền": 200000,
                    }
                ],
            }
        },
        cache_key="raw-redaction",
    )

    serialized = str(captured["json"])
    assert "000123" not in serialized
    assert "0312345678" not in serialized
    assert "200000" not in serialized
    clear_reconstruction_suggestion_cache()


def test_ai_gateway_reconstruction_requires_token(monkeypatch):
    monkeypatch.setenv("AI_GATEWAY_TOKEN", "secret")
    response = client.post(
        "/v1/misa/suggest-reconstruction",
        json={"source": {"headers": ["Số hóa đơn"]}},
    )
    assert response.status_code == 401


def test_ai_gateway_reconstruction_normalizes_mock_response(monkeypatch):
    monkeypatch.setenv("AI_GATEWAY_TOKEN", "secret")

    async def fake_call(payload):
        return {
            "field_roles": {"invoice": "Số hóa đơn"},
            "grouping_keys": ["invoice_number"],
            "direction": "purchase",
            "nature": "goods",
            "confidence": 0.8,
            "notes": [],
        }

    monkeypatch.setattr("app.ai_gateway._call_ollama_reconstruction", fake_call)
    response = client.post(
        "/v1/misa/suggest-reconstruction",
        headers={"Authorization": "Bearer secret"},
        json={"source": {"headers": ["Số hóa đơn"]}},
    )
    assert response.status_code == 200
    assert response.json()["grouping_keys"] == ["invoice_number"]
    assert response.headers["x-request-id"]


def test_ai_gateway_rejects_unknown_reconstruction_response_fields():
    with pytest.raises(HTTPException) as error:
        _normalize_reconstruction_response(
            {
                "field_roles": {},
                "grouping_keys": [],
                "direction": "purchase",
                "nature": "goods",
                "confidence": 0.8,
                "notes": [],
                "amount": 100000,
            },
            {"source": {"headers": []}},
        )

    assert error.value.status_code == 502


def test_ai_reconstruction_calls_remote_once_per_source_signature(monkeypatch):
    clear_reconstruction_suggestion_cache()
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv(
        "AI_RECONSTRUCTION_BASE_URL",
        "https://ai.example.test/v1/misa/suggest-reconstruction",
    )
    calls = []

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "field_roles": {"invoice": "Số hóa đơn"},
                "grouping_keys": ["invoice_number"],
                "direction": "purchase",
                "nature": "goods",
                "confidence": 0.9,
                "notes": [],
            }

    def post(*_args, **_kwargs):
        calls.append(1)
        return Response()

    monkeypatch.setattr("app.ai_reconstruction_client.httpx.post", post)
    payload = {"source": {"headers": ["Số hóa đơn"]}}

    first = request_reconstruction_suggestion(payload, cache_key="signature-1")
    second = request_reconstruction_suggestion(payload, cache_key="signature-1")
    request_reconstruction_suggestion(payload, cache_key="signature-2")

    assert first == second
    assert len(calls) == 2
    clear_reconstruction_suggestion_cache()


def test_ai_reconstruction_cache_isolated_by_prompt_version(monkeypatch):
    clear_reconstruction_suggestion_cache()
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv(
        "AI_RECONSTRUCTION_BASE_URL",
        "https://ai.example.test/v1/misa/suggest-reconstruction",
    )
    monkeypatch.setenv("AI_RECONSTRUCTION_PROMPT_VERSION", "phase3-v1")
    calls = []

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "field_roles": {"invoice": "Số hóa đơn"},
                "grouping_keys": ["invoice_number"],
                "direction": "purchase",
                "nature": "goods",
                "confidence": 0.9,
                "notes": [],
            }

    def post(*_args, **_kwargs):
        calls.append(1)
        return Response()

    monkeypatch.setattr("app.ai_reconstruction_client.httpx.post", post)
    payload = {"source": {"headers": ["Số hóa đơn"]}}

    request_reconstruction_suggestion(payload, cache_key="same-signature")
    request_reconstruction_suggestion(payload, cache_key="same-signature")
    monkeypatch.setenv("AI_RECONSTRUCTION_PROMPT_VERSION", "phase3-v2")
    request_reconstruction_suggestion(payload, cache_key="same-signature")

    assert len(calls) == 2
    clear_reconstruction_suggestion_cache()


def test_ai_reconstruction_deduplicates_concurrent_signature_calls(monkeypatch):
    clear_reconstruction_suggestion_cache()
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv(
        "AI_RECONSTRUCTION_BASE_URL",
        "https://ai.example.test/v1/misa/suggest-reconstruction",
    )
    calls = []

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "field_roles": {"invoice": "Số hóa đơn"},
                "grouping_keys": ["invoice_number"],
                "direction": "purchase",
                "nature": "goods",
                "confidence": 0.9,
                "notes": [],
            }

    def post(*_args, **_kwargs):
        calls.append(1)
        time.sleep(0.1)
        return Response()

    monkeypatch.setattr("app.ai_reconstruction_client.httpx.post", post)
    payload = {"source": {"headers": ["Số hóa đơn"]}}
    results = []

    def run():
        results.append(
            request_reconstruction_suggestion(payload, cache_key="concurrent")
        )

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 2
    assert results[0] == results[1]
    assert len(calls) == 1
    clear_reconstruction_suggestion_cache()
