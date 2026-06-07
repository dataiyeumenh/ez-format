"""PDF / OCR import paths (optional engines) → InputTable."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.excel_io import InputReadError, InputTable, read_input_table


@dataclass(frozen=True)
class DocumentImportResult:
    ok: bool
    code: str
    message: str
    format: str
    table: InputTable | None = None
    engine: str | None = None


def import_document(path: Path, options: dict[str, Any] | None = None) -> DocumentImportResult:
    options = options or {}
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        try:
            table = read_input_table(path)
            return DocumentImportResult(
                ok=True,
                code="ok",
                message="Excel loaded.",
                format=suffix.lstrip("."),
                table=table,
                engine="excel_io",
            )
        except InputReadError as exc:
            return DocumentImportResult(
                ok=False,
                code=exc.code,
                message=exc.message,
                format=suffix.lstrip("."),
                engine="excel_io",
            )
    if suffix == ".pdf":
        return _import_pdf(path, options)
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}:
        return _import_ocr(path, options)
    return DocumentImportResult(
        ok=False,
        code="unsupported_format",
        message=f"Unsupported file type: {suffix}",
        format=suffix.lstrip(".") or "unknown",
    )


def classify_pdf_bytes(payload: bytes) -> str:
    """Fast classifier for synthetic stress (no disk)."""
    if not payload.startswith(b"%PDF"):
        return "corrupt_pdf"
    if len(payload) < 128:
        return "truncated_pdf"
    if b"%%EOF" not in payload[-64:] and len(payload) < 512:
        return "truncated_pdf"
    try:
        import pdfplumber  # noqa: F401
    except ImportError:
        return "pdf_engine_unavailable"
    return "pdf_ok"


def _import_pdf(path: Path, options: dict[str, Any]) -> DocumentImportResult:
    payload = path.read_bytes()
    kind = classify_pdf_bytes(payload)
    if kind == "corrupt_pdf":
        return DocumentImportResult(
            ok=False,
            code="corrupt_pdf",
            message="File is not a valid PDF document.",
            format="pdf",
        )
    if kind == "truncated_pdf":
        return DocumentImportResult(
            ok=False,
            code="truncated_pdf",
            message="PDF file is truncated or incomplete.",
            format="pdf",
        )
    if kind == "pdf_engine_unavailable":
        return DocumentImportResult(
            ok=False,
            code="pdf_engine_unavailable",
            message="Install pdfplumber to enable PDF import.",
            format="pdf",
            engine=None,
        )

    try:
        import pdfplumber
    except ImportError:
        return DocumentImportResult(
            ok=False,
            code="pdf_engine_unavailable",
            message="Install pdfplumber to enable PDF import.",
            format="pdf",
        )

    try:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                for grid in page.extract_tables() or []:
                    table = _table_from_grid(grid)
                    if table.headers and table.rows:
                        return DocumentImportResult(
                            ok=True,
                            code="ok",
                            message="PDF table extracted (grid).",
                            format="pdf",
                            table=table,
                            engine="pdfplumber",
                        )
            text = "\n".join((page.extract_text() or "") for page in pdf.pages)
    except Exception as exc:
        return DocumentImportResult(
            ok=False,
            code="corrupt_pdf",
            message=f"Cannot read PDF: {exc}",
            format="pdf",
            engine="pdfplumber",
        )

    table = _table_from_delimited_text(text)
    if not table.headers or not table.rows:
        return DocumentImportResult(
            ok=False,
            code="pdf_no_table",
            message="No tabular data detected in PDF text.",
            format="pdf",
            engine="pdfplumber",
        )
    return DocumentImportResult(
        ok=True,
        code="ok",
        message="PDF table extracted.",
        format="pdf",
        table=table,
        engine="pdfplumber",
    )


def _import_ocr(path: Path, options: dict[str, Any]) -> DocumentImportResult:
    mode = str(options.get("ocr_mode") or os.getenv("OCR_MODE", "mock")).strip().lower()
    sidecar = path.with_name(path.name + ".ocr.txt")
    if mode == "mock" or sidecar.exists():
        if not sidecar.exists():
            return DocumentImportResult(
                ok=False,
                code="ocr_sidecar_missing",
                message=f"Mock OCR expects sidecar file: {sidecar.name}",
                format=path.suffix.lstrip("."),
                engine="mock",
            )
        text = sidecar.read_text(encoding="utf-8")
        table = _table_from_delimited_text(text)
        if not table.headers:
            return DocumentImportResult(
                ok=False,
                code="ocr_no_table",
                message="OCR sidecar has no parseable table.",
                format=path.suffix.lstrip("."),
                engine="mock",
            )
        return DocumentImportResult(
            ok=True,
            code="ok",
            message="OCR text loaded from sidecar.",
            format=path.suffix.lstrip("."),
            table=table,
            engine="mock",
        )

    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return DocumentImportResult(
            ok=False,
            code="ocr_engine_unavailable",
            message="Install pillow and pytesseract for live OCR.",
            format=path.suffix.lstrip("."),
        )

    try:
        text = pytesseract.image_to_string(Image.open(path), lang=options.get("ocr_lang", "vie+eng"))
    except Exception as exc:
        return DocumentImportResult(
            ok=False,
            code="ocr_failed",
            message=str(exc),
            format=path.suffix.lstrip("."),
            engine="tesseract",
        )

    table = _table_from_delimited_text(text)
    if not table.headers:
        return DocumentImportResult(
            ok=False,
            code="ocr_no_table",
            message="OCR produced no tabular lines.",
            format=path.suffix.lstrip("."),
            engine="tesseract",
        )
    return DocumentImportResult(
        ok=True,
        code="ok",
        message="OCR table extracted.",
        format=path.suffix.lstrip("."),
        table=table,
        engine="tesseract",
    )


def _table_from_grid(grid: list[list[Any]]) -> InputTable:
    if not grid or len(grid) < 2:
        return InputTable(headers=[], rows=[])
    headers = [str(cell or "").strip() for cell in grid[0]]
    if not any(headers):
        return InputTable(headers=[], rows=[])
    rows: list[dict[str, Any]] = []
    for raw in grid[1:]:
        if not raw or all(is_blank_cell(cell) for cell in raw):
            continue
        record = {
            headers[i]: raw[i] if i < len(raw) else None
            for i in range(len(headers))
            if headers[i]
        }
        if record:
            rows.append(record)
    return InputTable(headers=[h for h in headers if h], rows=rows)


def is_blank_cell(value: Any) -> bool:
    return value is None or str(value).strip() == ""


def _table_from_delimited_text(text: str) -> InputTable:
    text = text.replace("(cid:9)", "\t").replace("\u0009", "\t")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 2:
        return InputTable(headers=[], rows=[])

    delimiter = "\t" if any("\t" in line for line in lines[:5]) else None
    if delimiter is None:
        if all("|" in line for line in lines[:3]):
            delimiter = "|"
        elif len(re.split(r"\s{2,}", lines[0])) >= 4:
            delimiter = "multi_space"
        else:
            delimiter = ","

    headers = _split_line(lines[0], delimiter)
    rows: list[dict[str, Any]] = []
    for line in lines[1:]:
        values = _split_line(line, delimiter)
        if len(values) < len(headers):
            values.extend([""] * (len(headers) - len(values)))
        rows.append(dict(zip(headers, values[: len(headers)])))
    return InputTable(headers=headers, rows=rows)


def _split_line(line: str, delimiter: str) -> list[str]:
    if delimiter == "\t":
        return [part.strip() for part in line.split("\t")]
    if delimiter == "|":
        return [part.strip() for part in line.split("|")]
    if delimiter == "multi_space":
        return [part.strip() for part in re.split(r"\s{2,}", line) if part.strip()]
    return [part.strip() for part in line.split(",")]
