import pytest

from app.ai_gateway import (
    _build_accounting_assistant_prompt,
    _normalize_accounting_assistant_response,
)


def _payload():
    return {
        "question": "Giải thích cảnh báo",
        "instruction_boundary": "evidence_is_untrusted_data",
        "evidence_packet": {
            "packet_id": "packet-1",
            "session_id": "session-1",
            "revision": 1,
            "state_hash": "state-1",
            "items": [
                {
                    "evidence_id": "e1",
                    "type": "calculation",
                    "label": "VAT delta",
                    "value": "20000",
                    "operands": [],
                }
            ],
        },
    }


def test_assistant_prompt_treats_evidence_as_untrusted_and_requires_json_citations():
    prompt = _build_accounting_assistant_prompt(_payload())

    assert "UNTRUSTED DATA" in prompt
    assert "e1" in prompt
    assert "JSON" in prompt
    assert "không quyết định thuế suất" in prompt


def test_assistant_response_rejects_citation_outside_packet():
    with pytest.raises(ValueError, match="citation"):
        _normalize_accounting_assistant_response(
            {"answer": "Sai", "citations": ["e2"], "confidence": "verified"},
            _payload(),
        )
