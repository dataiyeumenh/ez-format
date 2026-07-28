from app.mapping_profile_client import (
    find_mapping_profile,
    get_mapping_profile,
    save_mapping_profile,
)


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


def _profile_payload():
    return {
        "id": "profile-1",
        "ownerScope": "workspace:workspace-1",
        "workspaceId": "workspace-1",
        "name": "BAE purchase",
        "targetTemplateId": "bsn_purchase",
        "sourceSignatureHash": "signature-1",
        "sourceHeaders": ["Mã NCC"],
        "sheetName": "Sheet1",
        "headerRow": 1,
        "mapping": {"Mã NCC": "Mã nhà cung cấp"},
        "defaults": {},
        "formulas": {},
        "confidence": 1,
        "usageCount": 2,
    }


def test_find_mapping_profile_uses_internal_context_headers(monkeypatch):
    captured = {}

    def request(method, url, **kwargs):
        captured.update({"method": method, "url": url, **kwargs})
        return FakeResponse({"profile": _profile_payload()})

    monkeypatch.setenv("NODE_INTERNAL_API_URL", "http://node/api/internal")
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", "service-secret")
    monkeypatch.setattr("app.mapping_profile_client.httpx.request", request)

    profile = find_mapping_profile(
        "context-token",
        target_template_id="bsn_purchase",
        source_signature_hash="signature-1",
    )

    assert profile is not None
    assert profile.owner_scope == "workspace:workspace-1"
    assert profile.workspace_id == "workspace-1"
    assert captured["headers"]["x-conversion-context"] == "context-token"
    assert captured["headers"]["x-converter-service-token"] == "service-secret"
    assert captured["params"]["sourceSignatureHash"] == "signature-1"


def test_save_and_get_mapping_profile(monkeypatch):
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return FakeResponse({"profile": _profile_payload()}, status_code=201)

    monkeypatch.setattr("app.mapping_profile_client.httpx.request", request)

    saved = save_mapping_profile(
        "context-token",
        name="BAE purchase",
        target_template_id="bsn_purchase",
        source_signature_hash="signature-1",
        source_headers=["Mã NCC"],
        sheet_name="Sheet1",
        header_row=1,
        mapping={"Mã NCC": "Mã nhà cung cấp"},
        defaults={},
        formulas={},
        confidence=1,
    )
    loaded = get_mapping_profile("context-token", saved.id)

    assert saved.id == "profile-1"
    assert loaded.mapping == {"Mã NCC": "Mã nhà cung cấp"}
    assert calls[0][0] == "POST"
    assert calls[0][2]["json"]["targetTemplateId"] == "bsn_purchase"


def test_profile_payload_keeps_workspace_compatibility_when_owner_scope_is_absent(monkeypatch):
    payload = _profile_payload()
    payload.pop("ownerScope")

    monkeypatch.setattr(
        "app.mapping_profile_client.httpx.request",
        lambda *args, **kwargs: FakeResponse({"profile": payload}),
    )

    profile = get_mapping_profile("context-token", "profile-1")

    assert profile.owner_scope == "workspace:workspace-1"
    assert profile.workspace_id == "workspace-1"
