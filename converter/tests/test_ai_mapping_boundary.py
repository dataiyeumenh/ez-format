import pytest

from app.ai_mapping_client import AiMappingError, request_mapping_suggestion
from app.excel_io import InputTable
from app.misa_mapping import MappingSuggestion
from app.misa_workflow import apply_optional_ai_mapping


def test_mapping_client_redacts_samples_before_outbound_http(monkeypatch):
    captured = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"mapping": {}, "confidence": 0}

    monkeypatch.setenv(
        "AI_BASE_URL", "https://ai.example.test/v1/misa/suggest-mapping"
    )
    monkeypatch.setattr(
        "app.ai_mapping_client.httpx.post",
        lambda *_args, **kwargs: captured.update(kwargs) or Response(),
    )

    request_mapping_suggestion(
        {
            "target_template": {"id": "purchase", "headers": ["Số hóa đơn"]},
            "source": {
                "sheet_name": "Công ty bí mật",
                "headers": ["Số hóa đơn", "MST NCC", "Thành tiền"],
                "sample_rows": [
                    {"Số hóa đơn": "000123", "MST NCC": "0312345678", "Thành tiền": 200000}
                ],
            },
            "nearby_profiles": [],
        }
    )

    serialized = str(captured["json"])
    assert "000123" not in serialized
    assert "0312345678" not in serialized
    assert "200000" not in serialized
    assert "Công ty bí mật" not in serialized


def test_mapping_client_rejects_plaintext_public_remote_endpoint(monkeypatch):
    monkeypatch.setenv(
        "AI_BASE_URL", "http://ai.example.test/v1/misa/suggest-mapping"
    )
    monkeypatch.setattr(
        "app.ai_mapping_client.httpx.post",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("plaintext endpoint reached HTTP")
        ),
    )

    with pytest.raises(AiMappingError, match="HTTPS"):
        request_mapping_suggestion({"target_template": {}, "source": {}})


def test_mapping_client_rejects_invalid_json_response(monkeypatch):
    class Response:
        status_code = 200

        @staticmethod
        def json():
            raise ValueError("not json")

    monkeypatch.setenv(
        "AI_BASE_URL", "https://ai.example.test/v1/misa/suggest-mapping"
    )
    monkeypatch.setattr("app.ai_mapping_client.httpx.post", lambda *_args, **_kwargs: Response())

    with pytest.raises(AiMappingError, match="invalid JSON") as exc_info:
        request_mapping_suggestion({"target_template": {}, "source": {}})
    assert exc_info.value.gateway == "online"
    assert exc_info.value.model == "unknown"


def test_ai_failure_returns_heuristic_mapping_with_explicit_fallback_state(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    fallback = MappingSuggestion(
        source="heuristic",
        confidence=0.55,
        mapping={},
        defaults={},
        formulas={},
        warnings=[],
    )
    monkeypatch.setattr(
        "app.misa_workflow.ai_mapping_client.request_mapping_suggestion",
        lambda _payload: (_ for _ in ()).throw(AiMappingError("timeout")),
    )

    suggestion, state = apply_optional_ai_mapping(
        table=InputTable(
            headers=["Địa chỉ"],
            rows=[{"Địa chỉ": "Hà Nội"}],
            sheet_name="Data",
        ),
        target_template_id="bsn_sales",
        template_headers=["Mã hàng (*)"],
        fallback=fallback,
        issues=[],
        use_ai=True,
        ai_mapping_opt_in=True,
    )

    assert suggestion.source == "heuristic"
    assert "ai_unavailable" in suggestion.warnings
    assert state == {"gateway": "offline", "model": "unknown", "mapping": "failed"}


def test_ai_semantic_invalid_mapping_falls_back_without_changing_rule_severity(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    fallback = MappingSuggestion(
        source="heuristic",
        confidence=0.55,
        mapping={},
        defaults={},
        formulas={},
        warnings=[],
    )
    monkeypatch.setattr(
        "app.misa_workflow.ai_mapping_client.request_mapping_suggestion",
        lambda _payload: {"mapping": {"Địa chỉ": "Mã hàng (*)"}, "confidence": 0.99},
    )

    suggestion, state = apply_optional_ai_mapping(
        table=InputTable(
            headers=["Địa chỉ"],
            rows=[{"Địa chỉ": "Hà Nội"}],
            sheet_name="Data",
        ),
        target_template_id="bsn_sales",
        template_headers=["Mã hàng (*)"],
        fallback=fallback,
        issues=[],
        use_ai=True,
        ai_mapping_opt_in=True,
    )

    assert suggestion.source == "heuristic"
    assert "ai_unavailable" in suggestion.warnings
    assert state == {"gateway": "online", "model": "available", "mapping": "failed"}


def test_valid_ai_mapping_is_semantically_checked_and_marked_as_used(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    fallback = MappingSuggestion(
        source="heuristic",
        confidence=0.55,
        mapping={},
        defaults={},
        formulas={},
        warnings=[],
    )
    monkeypatch.setattr(
        "app.misa_workflow.ai_mapping_client.request_mapping_suggestion",
        lambda _payload: {"mapping": {"Mã hóa đơn": "Số chứng từ (*)"}, "confidence": 0.99},
    )

    suggestion, state = apply_optional_ai_mapping(
        table=InputTable(
            headers=["Mã hóa đơn"],
            rows=[{"Mã hóa đơn": "<text>"}],
            sheet_name="Data",
        ),
        target_template_id="bsn_sales",
        template_headers=["Số chứng từ (*)"],
        fallback=fallback,
        issues=[],
        use_ai=True,
        ai_mapping_opt_in=True,
    )

    assert suggestion.source == "mixed"
    assert state == {"gateway": "online", "model": "available", "mapping": "mixed"}


def test_optional_ai_mapping_forwards_bounded_nearby_profile_summaries(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    captured = {}
    nearby_profiles = [
        {
            "target_template_id": "bsn_sales",
            "source_headers": ["Mã hóa đơn"],
            "confidence": 0.81,
        }
    ]

    def capture_payload(payload):
        captured["payload"] = payload
        return {
            "mapping": {"Mã hóa đơn": "Số chứng từ (*)"},
            "confidence": 0.9,
        }

    monkeypatch.setattr(
        "app.misa_workflow.ai_mapping_client.request_mapping_suggestion",
        capture_payload,
    )

    apply_optional_ai_mapping(
        table=InputTable(
            headers=["Mã hóa đơn"],
            rows=[{"Mã hóa đơn": "HD001"}],
            sheet_name="Data",
        ),
        target_template_id="bsn_sales",
        template_headers=["Số chứng từ (*)"],
        fallback=MappingSuggestion(
            source="heuristic",
            confidence=0.55,
            mapping={},
            defaults={},
            formulas={},
            warnings=[],
        ),
        issues=[],
        use_ai=True,
        ai_mapping_opt_in=True,
        nearby_profiles=nearby_profiles,
    )

    assert captured["payload"]["nearby_profiles"] == nearby_profiles


def test_gateway_online_does_not_claim_ai_mapping_was_used(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv(
        "AI_BASE_URL", "https://ai.example.test/v1/misa/suggest-mapping"
    )
    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: object())

    from app.main import _ai_runtime_state

    assert _ai_runtime_state() == {
        "gateway": "online",
        "model": "unknown",
        "mapping": "not_run",
    }
