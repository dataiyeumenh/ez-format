from __future__ import annotations

import time

import pytest

import app.import_result_parser as import_result_parser
from app.import_result_models import ImportResultSchemaError
from app.import_result_parser import inspect_import_result
from tests.helpers.import_result_workbooks import (
    add_xlsx_zip_payload,
    build_import_result_xls,
    build_import_result_xlsx,
    set_xlsx_sheet_dimension,
)


def test_xls_budget_preflight_rejects_before_xlrd_materialization(monkeypatch):
    content = build_import_result_xls(
        headers=["Message"],
        rows=[["Rejected"]],
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_ROWS", "1")
    opened = False

    def fail_if_opened(*_args, **_kwargs):
        nonlocal opened
        opened = True
        raise AssertionError("xlrd materialized oversized workbook")

    monkeypatch.setattr(import_result_parser.xlrd, "open_workbook", fail_if_opened)

    with pytest.raises(ImportResultSchemaError, match="gioi han 1 dong"):
        inspect_import_result(content, "result.xls")

    assert opened is False


def test_xlsx_dimension_preflight_rejects_before_openpyxl_materialization(monkeypatch):
    content = set_xlsx_sheet_dimension(
        build_import_result_xlsx(headers=["Message"], rows=[["Rejected"]]),
        "A1:XFD1048576",
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_CELLS", "100")
    monkeypatch.setenv("IMPORT_RESULT_MAX_ROWS", "2000000")
    opened = False

    def fail_if_opened(*_args, **_kwargs):
        nonlocal opened
        opened = True
        raise AssertionError("openpyxl materialized oversized workbook")

    monkeypatch.setattr(import_result_parser.openpyxl, "load_workbook", fail_if_opened)

    with pytest.raises(ImportResultSchemaError, match="gioi han 100 o"):
        inspect_import_result(content, "result.xlsx")

    assert opened is False


def test_xlsx_wide_sheet_rejects_before_openpyxl_materialization(monkeypatch):
    content = build_import_result_xlsx(
        headers=["Message", "Document", "Extra"],
        rows=[["Rejected", "BH0001", "ignored"]],
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_COLUMNS", "2")
    opened = False

    def fail_if_opened(*_args, **_kwargs):
        nonlocal opened
        opened = True
        raise AssertionError("openpyxl materialized a too-wide workbook")

    monkeypatch.setattr(import_result_parser.openpyxl, "load_workbook", fail_if_opened)

    with pytest.raises(ImportResultSchemaError, match="gioi han 2 cot"):
        inspect_import_result(content, "result.xlsx")

    assert opened is False


def test_xlsx_shared_strings_budget_rejects_before_openpyxl_materialization(monkeypatch):
    shared_strings = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        b'<si><t>' + (b"x" * 256) + b'</t></si></sst>'
    )
    content = add_xlsx_zip_payload(
        build_import_result_xlsx(headers=["Message"], rows=[["Rejected"]]),
        name="xl/sharedStrings.xml",
        payload=shared_strings,
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_DECODED_TEXT_BYTES", "64")
    opened = False

    def fail_if_opened(*_args, **_kwargs):
        nonlocal opened
        opened = True
        raise AssertionError("openpyxl materialized oversized shared strings")

    monkeypatch.setattr(import_result_parser.openpyxl, "load_workbook", fail_if_opened)

    with pytest.raises(ImportResultSchemaError, match="decoded text 64 bytes"):
        inspect_import_result(content, "result.xlsx")

    assert opened is False


def test_xlsx_inline_text_budget_rejects_before_openpyxl_materialization(monkeypatch):
    content = build_import_result_xlsx(
        headers=["Message"],
        rows=[["x" * 256]],
    )
    monkeypatch.setenv("IMPORT_RESULT_MAX_DECODED_TEXT_BYTES", "64")
    opened = False

    def fail_if_opened(*_args, **_kwargs):
        nonlocal opened
        opened = True
        raise AssertionError("openpyxl materialized oversized inline text")

    monkeypatch.setattr(import_result_parser.openpyxl, "load_workbook", fail_if_opened)

    with pytest.raises(ImportResultSchemaError, match="decoded text 64 bytes"):
        inspect_import_result(content, "result.xlsx")

    assert opened is False


def test_import_result_default_work_budget_is_memory_bounded(monkeypatch):
    monkeypatch.delenv("IMPORT_RESULT_MAX_ROWS", raising=False)
    monkeypatch.delenv("IMPORT_RESULT_MAX_CELLS", raising=False)

    with pytest.raises(ImportResultSchemaError, match="gioi han 10000 dong"):
        import_result_parser._enforce_stream_budget(10001, 1)
    with pytest.raises(ImportResultSchemaError, match="gioi han 250000 o"):
        import_result_parser._enforce_stream_budget(1, 250001)


def test_import_result_stream_budget_enforces_parse_deadline():
    with pytest.raises(ImportResultSchemaError, match="qua thoi gian"):
        import_result_parser._enforce_stream_budget(
            1,
            1,
            deadline=time.monotonic() - 1,
        )
