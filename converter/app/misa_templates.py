from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.conversion_types import BACKEND_ROOT, CONVERSION_TYPES
from app.excel_io import TemplateWorkbook, read_template


DISPLAY_FILENAMES = {
    "bsn_sales": "BSN - Form import bán hàng.xls",
    "bsn_purchase": "BSN - Form import mua hàng.xls",
    "misa_purchase_domestic": "mua_hang_trong_nuoc_full.xls",
    "sales_service": "Form bán hàng dịch vụ.xls",
    "sales_goods": "Form bán hàng hóa.xls",
    "purchase_service": "Form mua dịch vụ.xls",
    "purchase_goods": "Form mua hàng hóa.xls",
}


@dataclass(frozen=True)
class MisaTemplate:
    id: str
    label: str
    filename: str
    path: Path
    workbook: TemplateWorkbook

    @property
    def sheet_name(self) -> str:
        return self.workbook.sheet_name

    @property
    def header_row(self) -> int:
        return self.workbook.header_row_index + 1

    @property
    def data_start_row(self) -> int:
        return self.workbook.header_row_index + 2

    @property
    def headers(self) -> list[str]:
        return self.workbook.headers


def configured_template_dir() -> Path:
    configured = os.getenv("MISA_TEMPLATE_DIR")
    if configured:
        return Path(configured)
    return BACKEND_ROOT / "fixtures" / "templates"


def template_path_for(template_id: str) -> Path:
    return _template_path_for(template_id, str(configured_template_dir()))


@lru_cache(maxsize=16)
def _template_path_for(template_id: str, configured_dir_value: str) -> Path:
    definition = CONVERSION_TYPES[template_id]
    configured_dir = Path(configured_dir_value)
    display_name = DISPLAY_FILENAMES.get(template_id)
    if configured_dir.exists() and display_name:
        candidate = configured_dir / display_name
        if candidate.exists():
            if template_id == "bsn_sales" and not _has_bsn_sales_lot_expiry_columns(candidate):
                return definition.template_path
            return candidate
    return definition.template_path


def get_misa_template(template_id: str) -> MisaTemplate:
    return _get_misa_template(template_id, str(configured_template_dir()))


@lru_cache(maxsize=16)
def _get_misa_template(template_id: str, configured_dir_value: str) -> MisaTemplate:
    if template_id not in CONVERSION_TYPES:
        raise ValueError(f"Unsupported target_template_id: {template_id}")
    definition = CONVERSION_TYPES[template_id]
    path = _template_path_for(template_id, configured_dir_value)
    workbook = read_template(path)
    return MisaTemplate(
        id=template_id,
        label=definition.label,
        filename=DISPLAY_FILENAMES.get(template_id, path.name),
        path=path,
        workbook=workbook,
    )


def list_misa_templates() -> list[MisaTemplate]:
    return [get_misa_template(template_id) for template_id in CONVERSION_TYPES]


def _has_bsn_sales_lot_expiry_columns(path: Path) -> bool:
    try:
        headers = read_template(path).headers
    except Exception:
        return False
    return "Số lô" in headers and "Hạn sử dụng" in headers
