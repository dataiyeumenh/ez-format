import io
import json
import os
import sqlite3
from pathlib import Path

import xlrd
from fastapi.testclient import TestClient

from app.main import app
from app.misa_profiles import ProfileStore


ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "fixtures" / "samples"


client = TestClient(app)


def _profile_values(**overrides):
    values = {
        "name": "Owner-scoped mapping",
        "target_template_id": "bsn_purchase",
        "source_signature_hash": "signature-1",
        "source_headers": ["Mã NCC"],
        "sheet_name": "Sheet1",
        "header_row": 1,
        "mapping": {"Mã NCC": "Mã nhà cung cấp"},
        "defaults": {},
        "formulas": {},
        "confidence": 1.0,
    }
    values.update(overrides)
    return values


def test_sqlite_profiles_are_isolated_by_non_empty_owner_scope(tmp_path):
    store = ProfileStore(tmp_path / "profiles.sqlite")
    owner_a = store.save_profile(**_profile_values(), owner_scope="user:user-a")
    owner_b = store.save_profile(**_profile_values(), owner_scope="user:user-b")

    assert owner_a.id != owner_b.id
    assert owner_a.owner_scope == "user:user-a"
    assert owner_b.owner_scope == "user:user-b"
    assert (
        store.find_by_signature(
            target_template_id="bsn_purchase",
            source_signature_hash="signature-1",
            owner_scope="user:user-a",
        ).id
        == owner_a.id
    )

    try:
        store.get_profile(owner_a.id, owner_scope="user:user-b")
    except KeyError:
        pass
    else:
        raise AssertionError("cross-owner profile get must fail")

    try:
        store.mark_used(owner_a.id, owner_scope="user:user-b")
    except KeyError:
        pass
    else:
        raise AssertionError("cross-owner profile use must fail")


def test_sqlite_profile_migration_backfills_owner_scope_and_rejects_empty(tmp_path):
    path = tmp_path / "legacy.sqlite"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE mapping_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                target_template_id TEXT NOT NULL,
                source_signature_hash TEXT NOT NULL,
                source_headers_json TEXT NOT NULL,
                sheet_name TEXT NOT NULL,
                header_row INTEGER NOT NULL,
                mapping_json TEXT NOT NULL,
                defaults_json TEXT NOT NULL,
                formulas_json TEXT NOT NULL,
                confidence REAL NOT NULL,
                usage_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                workspace_id TEXT NOT NULL DEFAULT ''
            );
            """
        )
        rows = [
            ("workspace-profile", "workspace-123"),
            ("local-profile", ""),
            ("local-get-profile", ""),
        ]
        for profile_id, workspace_id in rows:
            connection.execute(
                """
                INSERT INTO mapping_profiles (
                    id, name, target_template_id, source_signature_hash,
                    source_headers_json, sheet_name, header_row, mapping_json,
                    defaults_json, formulas_json, confidence, usage_count,
                    created_at, updated_at, workspace_id
                ) VALUES (?, 'Legacy', 'bsn_purchase', ?, '[]', 'Sheet1', 1,
                          '{}', '{}', '{}', 1, 0, 'now', 'now', ?)
                """,
                (profile_id, f"signature-{profile_id}", workspace_id),
            )

    ProfileStore(path)

    with sqlite3.connect(path) as connection:
        migrated = dict(
            connection.execute(
                "SELECT id, owner_scope FROM mapping_profiles ORDER BY id"
            ).fetchall()
        )
        assert migrated == {
            "local-get-profile": "local:legacy",
            "local-profile": "local:legacy",
            "workspace-profile": "workspace:workspace-123",
        }
        try:
            connection.execute(
                "UPDATE mapping_profiles SET owner_scope = '' WHERE id = 'local-profile'"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("empty owner_scope update must fail")

    store = ProfileStore(path)
    found = store.find_by_signature(
        target_template_id="bsn_purchase",
        source_signature_hash="signature-local-profile",
    )
    loaded = store.get_profile("local-get-profile")

    assert found is not None
    assert found.owner_scope == "local:default"
    assert loaded.owner_scope == "local:default"
    with sqlite3.connect(path) as connection:
        claimed = dict(
            connection.execute(
                "SELECT id, owner_scope FROM mapping_profiles WHERE id LIKE 'local-%'"
            ).fetchall()
        )
    assert claimed == {
        "local-get-profile": "local:default",
        "local-profile": "local:default",
    }


def test_sqlite_new_local_profiles_default_to_local_owner_scope(tmp_path, monkeypatch):
    monkeypatch.delenv("LOCAL_MAPPING_OWNER_SCOPE", raising=False)
    profile = ProfileStore(tmp_path / "profiles.sqlite").save_profile(**_profile_values())

    assert profile.owner_scope == "local:default"


def test_templates_endpoint_reads_real_misa_headers():
    response = client.get("/api/v1/templates")

    assert response.status_code == 200
    items = response.json()["items"]
    bsn_sales = next(item for item in items if item["id"] == "bsn_sales")
    assert bsn_sales["header_row"] == 8
    assert bsn_sales["data_start_row"] == 9
    assert bsn_sales["headers"][:8] == [
        "Hình thức bán hàng",
        "Phương thức thanh toán",
        "Kiêm phiếu xuất kho",
        "Lập kèm hóa đơn",
        "Đã lập hóa đơn",
        "Ngày hạch toán (*)",
        "Ngày chứng từ (*)",
        "Số chứng từ (*)",
    ]


def test_analyze_preview_confirm_export_learns_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")

    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        analyze = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    "raw_sales_sample.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert analyze.status_code == 200
    analyze_payload = analyze.json()
    assert analyze_payload["target_template_id"] == "bsn_sales"
    assert "Số chứng từ (*)" in analyze_payload["target_headers"]
    assert "Mã hàng (*)" in analyze_payload["target_headers"]
    assert analyze_payload["detected"]["header_row"] == 1
    assert analyze_payload["detected"]["row_count"] == 1930
    suggestion = analyze_payload["mapping_suggestion"]
    assert suggestion["mapping"]["Mã hóa đơn"] == "Số chứng từ (*)"
    assert suggestion["mapping"]["Thời gian"] == [
        "Ngày hạch toán (*)",
        "Ngày chứng từ (*)",
    ]
    assert suggestion["mapping"]["Column1"] == "Tiền chiết khấu"
    assert "Địa chỉ (Khách hàng)" not in suggestion["mapping"]
    assert suggestion["defaults"]["Mã khách hàng"] == "KH_LE"
    assert suggestion["formulas"]["Số phiếu xuất"] == "XK_${Số chứng từ (*)}"

    preview = client.post(
        "/api/v1/mappings/preview",
        json={
            "upload_id": analyze_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": suggestion["mapping"],
            "defaults": suggestion["defaults"],
            "formulas": suggestion["formulas"],
        },
    )
    assert preview.status_code == 200
    preview_payload = preview.json()
    assert preview_payload["stats"] == {"source_rows": 1930, "output_rows": 1930}
    first = preview_payload["rows"][0]
    assert first["Số chứng từ (*)"] == "HD046178"
    assert first["Số phiếu xuất"] == "XK_HD046178"
    assert first["Mã hàng (*)"] == "SP094030"
    assert first["Số lượng"] == 1
    assert first["Đơn giá"] == 700000
    assert first["Thành tiền"] == 700000
    assert first["Tiền chiết khấu"] == 315000
    assert first["Số lô"] == "01072029"
    assert first["Hạn sử dụng"] == "2029-07-01T00:00:00"
    assert preview_payload["rows"][35]["ĐVT"] == "Hộp"
    assert preview_payload["rows"][113]["Mã khách hàng"] == "KH_LE"
    assert preview_payload["rows"][1870]["Số chứng từ (*)"] == "HDO1764925151999"
    assert preview_payload["rows"][1870]["Số phiếu xuất"] == "XK_HDO1764925151999"

    confirm = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": analyze_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": suggestion["mapping"],
            "defaults": suggestion["defaults"],
            "formulas": suggestion["formulas"],
            "profile_name": "KiotViet bán hàng chi tiết",
        },
    )
    assert confirm.status_code == 200
    profile_id = confirm.json()["profile_id"]
    db = tmp_path / "profiles.sqlite"
    with sqlite3.connect(db) as connection:
        stored = connection.execute(
            "select mapping_json from mapping_profiles where id = ?", (profile_id,)
        ).fetchone()[0]
        stored_mapping = json.loads(stored)
        stored_mapping["Địa chỉ (Khách hàng)"] = "Địa chỉ"
        connection.execute(
            "update mapping_profiles set mapping_json = ? where id = ?",
            (json.dumps(stored_mapping, ensure_ascii=False), profile_id),
        )

    export = client.post(
        "/api/v1/conversions/export",
        json={
            "upload_id": analyze_payload["upload_id"],
            "profile_id": profile_id,
            "acknowledge_warnings": True,
        },
    )
    assert export.status_code == 200
    assert export.headers["content-type"].startswith("application/vnd.ms-excel")
    assert "Import misa" in export.headers["content-disposition"]

    workbook = xlrd.open_workbook(file_contents=export.content)
    sheet = workbook.sheet_by_index(0)
    assert sheet.row_values(7)[:8] == preview_payload["headers"][:8]
    headers = preview_payload["headers"]
    assert sheet.cell_value(6, headers.index("TK thuế GTGT")) == ""
    assert sheet.cell_value(6, headers.index("Mã kho")) == "Chi tiết giá vốn"
    assert sheet.cell_value(8, headers.index("Số chứng từ (*)")) == "HD046178"
    assert sheet.cell_value(8, headers.index("Địa chỉ")) == ""
    assert sheet.cell_value(8, headers.index("Hạn sử dụng")) == 47300
    assert sheet.cell_value(8, headers.index("Ngày hạch toán (*)")) == 46016.724817905095
    assert sheet.cell_value(9, headers.index("Mã hàng (*)")) == "SP094013"
    assert sheet.cell_value(9, headers.index("ĐVT")) == "Hộp"
    assert sheet.cell_value(43, headers.index("ĐVT")) == "Hộp"
    assert sheet.cell_value(121, headers.index("Mã khách hàng")) == "KH_LE"
    assert sheet.cell_value(1878, headers.index("Số chứng từ (*)")) == "HDO1764925151999"
    assert sheet.cell_value(1878, headers.index("Số phiếu xuất")) == "XK_HDO1764925151999"

    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        reanalyze = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    "raw_sales_sample.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert reanalyze.status_code == 200
    assert reanalyze.json()["mapping_suggestion"]["source"] == "profile"
    assert reanalyze.json()["mapping_suggestion"]["profile_id"] == profile_id


def test_high_confidence_heuristic_skips_remote_ai(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv("AI_REQUIRED", "false")

    def fail_if_called(_payload):
        raise AssertionError("AI should not be called when heuristic confidence is already high")

    monkeypatch.setattr("app.misa_workflow.request_mapping_suggestion", fail_if_called)

    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        response = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    "raw_sales_sample.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert response.status_code == 200
    suggestion = response.json()["mapping_suggestion"]
    assert suggestion["source"] == "heuristic"


def test_analyze_repairs_stale_profile_missing_required_mapping(tmp_path, monkeypatch):
    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "disabled")

    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        first_analyze = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    "raw_sales_sample.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert first_analyze.status_code == 200
    first_payload = first_analyze.json()
    suggestion = first_payload["mapping_suggestion"]
    broken_mapping = dict(suggestion["mapping"])
    broken_mapping.pop("Mã hàng", None)

    confirm = client.post(
        "/api/v1/mappings/confirm",
        json={
            "upload_id": first_payload["upload_id"],
            "target_template_id": "bsn_sales",
            "mapping": broken_mapping,
            "defaults": suggestion["defaults"],
            "formulas": suggestion["formulas"],
            "profile_name": "Broken stale profile",
        },
    )
    assert confirm.status_code == 200

    with (SAMPLES / "raw_sales_sample.xlsx").open("rb") as handle:
        repaired = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    "raw_sales_sample.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert repaired.status_code == 200
    repaired_suggestion = repaired.json()["mapping_suggestion"]
    assert repaired_suggestion["source"] == "mixed"
    assert repaired_suggestion["mapping"]["Mã hàng"] == "Mã hàng (*)"
    assert not any(issue["code"] == "missing_required_mapping" for issue in repaired.json()["issues"])


def test_high_confidence_unknown_schema_still_uses_remote_ai(tmp_path, monkeypatch):
    import openpyxl

    from app.conversion_types import CONVERSION_TYPES
    from app.misa_mapping import MappingSuggestion

    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv("AI_REQUIRED", "false")

    raw_path = tmp_path / "unknown_but_confident.xlsx"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["InvoiceX", "DateX", "ItemX"])
    sheet.append(["HD001", "01/01/2026", "SKU001"])
    workbook.save(raw_path)

    def high_confidence_unknown_heuristic(_table, _target_template_id, _target_headers):
        return MappingSuggestion(
            source="heuristic",
            confidence=0.95,
            mapping={
                "InvoiceX": "Số chứng từ (*)",
                "DateX": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
                "ItemX": "Mã hàng (*)",
            },
            defaults=CONVERSION_TYPES["bsn_sales"].defaults,
            formulas={},
            warnings=[],
        )

    ai_called = False

    def mark_ai_called(_payload):
        nonlocal ai_called
        ai_called = True
        return {"mapping": {}, "defaults": {}, "formulas": {}, "confidence": 0.0}

    monkeypatch.setattr("app.misa_workflow.heuristic_suggestion", high_confidence_unknown_heuristic)
    monkeypatch.setattr("app.misa_workflow.request_mapping_suggestion", mark_ai_called)

    with raw_path.open("rb") as handle:
        response = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    raw_path.name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert response.status_code == 200
    assert ai_called is True


def test_analyze_falls_back_when_low_confidence_remote_ai_fails(tmp_path, monkeypatch):
    import openpyxl

    monkeypatch.setenv("MAPPING_DB_PATH", str(tmp_path / "profiles.sqlite"))
    monkeypatch.setenv("AI_PROVIDER", "remote_http")
    monkeypatch.setenv("AI_BASE_URL", "http://127.0.0.1:9/v1/misa/suggest-mapping")
    monkeypatch.setenv("AI_TOKEN", "secret")
    monkeypatch.setenv("AI_MAPPING_TIMEOUT_SECONDS", "0.01")
    monkeypatch.setenv("AI_REQUIRED", "false")

    raw_path = tmp_path / "unknown_schema.xlsx"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["Unknown A", "Unknown B"])
    sheet.append(["foo", "bar"])
    workbook.save(raw_path)

    with raw_path.open("rb") as handle:
        response = client.post(
            "/api/v1/uploads/analyze",
            data={"target_template_id": "bsn_sales"},
            files={
                "file": (
                    raw_path.name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

    assert response.status_code == 200
    suggestion = response.json()["mapping_suggestion"]
    assert suggestion["source"] == "heuristic"
    assert any("AI" in warning for warning in suggestion["warnings"])


def test_ai_gateway_requires_bearer_token(monkeypatch):
    monkeypatch.setenv("AI_GATEWAY_TOKEN", "secret")
    from app.ai_gateway import app as gateway_app

    gateway_client = TestClient(gateway_app)
    response = gateway_client.post(
        "/v1/misa/suggest-mapping",
        json={
            "target_template": {"id": "bsn_sales", "headers": []},
            "source": {"sheet_name": "Sheet1", "headers": [], "sample_rows": []},
            "nearby_profiles": [],
        },
    )

    assert response.status_code == 401


def test_converter_ai_mapping_timeout_accepts_legacy_long_timeout(monkeypatch):
    from app.ai_mapping_client import mapping_timeout_seconds

    monkeypatch.delenv("AI_MAPPING_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setenv("AI_TIMEOUT_SECONDS", "120")
    monkeypatch.delenv("AI_MAPPING_TIMEOUT_CAP_SECONDS", raising=False)

    assert mapping_timeout_seconds() == 120.0


def test_ai_gateway_normalizes_reversed_mapping_and_percent_confidence():
    from app.ai_gateway import _normalize_gateway_response

    normalized = _normalize_gateway_response(
        {
            "target_template_id": "bsn_sales",
            "mapping": {
                "Số chứng từ (*)": "Mã hóa đơn",
                "Ngày hạch toán (*)": "Thời gian",
                "Ngày chứng từ (*)": "Thời gian",
            },
            "confidence": 75,
        },
        {
            "target_template": {
                "headers": ["Số chứng từ (*)", "Ngày hạch toán (*)", "Ngày chứng từ (*)"]
            },
            "source": {"headers": ["Mã hóa đơn", "Thời gian"]},
        },
    )

    assert normalized["mapping"] == {
        "Mã hóa đơn": "Số chứng từ (*)",
        "Thời gian": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
    }
    assert normalized["confidence"] == 0.75


def test_ai_gateway_rejects_non_mapping_report_shape():
    from app.ai_gateway import _normalize_gateway_response

    normalized = _normalize_gateway_response(
        {
            "report_type": "Sales Report",
            "confidence": 90,
            "summary": "Not a mapping response",
        },
        {
            "target_template": {"id": "bsn_sales", "headers": ["Số chứng từ (*)"]},
            "source": {"headers": ["Mã hóa đơn"]},
        },
    )

    assert normalized == {
        "target_template_id": "bsn_sales",
        "mapping": {},
        "defaults": {},
        "formulas": {},
        "confidence": 0.0,
        "notes": [],
    }


def test_ai_suggestion_merges_with_heuristic_fallback():
    from app.misa_mapping import MappingSuggestion, normalize_ai_suggestion

    fallback = MappingSuggestion(
        source="heuristic",
        confidence=0.8,
        mapping={
            "Mã hóa đơn": "Số chứng từ (*)",
            "Thời gian": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
            "Mã hàng": "Mã hàng (*)",
            "Column1": "Tiền chiết khấu",
        },
        defaults={"TK Doanh thu/Có (*)": "5111"},
        formulas={},
        warnings=[],
    )
    suggestion = normalize_ai_suggestion(
        {
            "mapping": {
                "Thời gian": "Ngày hạch toán (*)",
                "Tên khách hàng": "Tên khách hàng",
            },
            "confidence": 0.6,
        },
        fallback,
        target_template_id="bsn_sales",
        target_headers=[
            "Số chứng từ (*)",
            "Ngày hạch toán (*)",
            "Ngày chứng từ (*)",
            "Tên khách hàng",
            "Mã hàng (*)",
            "Tiền chiết khấu",
            "TK Doanh thu/Có (*)",
        ],
    )

    assert suggestion.source == "mixed"
    assert suggestion.mapping == {
        "Mã hóa đơn": "Số chứng từ (*)",
        "Thời gian": ["Ngày hạch toán (*)", "Ngày chứng từ (*)"],
        "Tên khách hàng": "Tên khách hàng",
        "Mã hàng": "Mã hàng (*)",
        "Column1": "Tiền chiết khấu",
    }
    assert suggestion.confidence == 0.8
