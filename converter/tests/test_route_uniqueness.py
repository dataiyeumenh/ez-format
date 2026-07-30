from __future__ import annotations

from collections import Counter

from app.main import app


HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}


def registered_routes() -> list[tuple[str, str]]:
    return [
        (method, route.path)
        for route in app.routes
        for method in (route.methods or set())
        if method in HTTP_METHODS
    ]


def test_fastapi_path_and_method_registrations_are_unique() -> None:
    counts = Counter(registered_routes())
    duplicates = sorted(route for route, count in counts.items() if count > 1)
    assert duplicates == []


def test_all_transplanted_converter_endpoints_register_once() -> None:
    counts = Counter(registered_routes())
    required = {
        ("POST", "/api/v1/import-results/analyze"),
        ("POST", "/api/v1/import-results/normalize"),
        ("POST", "/api/v1/import-repairs/readiness"),
        ("POST", "/api/v1/import-repairs/export"),
        ("POST", "/api/v1/exports/manifest"),
    }
    assert {route: counts[route] for route in required} == {
        route: 1 for route in required
    }
