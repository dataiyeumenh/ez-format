"""
Synthetic Excel fixtures covering ~99.9% of real-world header/layout variants.
Used by test_stress_999.py — not imported in production.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import openpyxl

from app.conversion_types import CONVERSION_TYPES


@dataclass(frozen=True)
class HeaderProfile:
    id: str
    kind: str  # sales | purchase
    headers: tuple[str, ...]
    row_builder: Callable[[int, random.Random], dict[str, Any]]


def _sales_formal_row(i: int, rng: random.Random) -> dict[str, Any]:
    return {
        "Mã hóa đơn": f"HD{i:05d}",
        "Thời gian": f"{(i % 28) + 1:02d}/12/2025",
        "Tên khách hàng": f"Khách {i}",
        "Mã hàng": f"SP{i:04d}",
        "Số lượng": (i % 5) + 1,
        "Đơn giá": 10000 + i * 100,
        "Thành tiền": ((i % 5) + 1) * (10000 + i * 100),
    }


def _sales_retail_row(i: int, rng: random.Random) -> dict[str, Any]:
    return {
        "Số HĐ bán lẻ": f"HDX{i:05d}",
        "Ngày bán": datetime(2025, 12, (i % 28) + 1),
        "Người mua hàng": f"Khách lẻ {i}",
        "Mã SKU bán": f"SKU-B{i:05d}",
        "SL bán": (i % 7) + 1,
        "Giá bán": f"{10000 + i * 50:,}",
    }


def _sales_minimal_row(i: int, rng: random.Random) -> dict[str, Any]:
    return {
        "Số chứng từ": f"CT{i:05d}",
        "Ngày chứng từ": f"2025-12-{(i % 28) + 1:02d}",
        "Tên khách hàng": f"K{i}",
        "Mã hàng": f"M{i:04d}",
        "Số lượng": 1,
        "Đơn giá": 50000,
    }


def _purchase_formal_row(i: int, rng: random.Random) -> dict[str, Any]:
    return {
        "Số phiếu nhập": f"PN{i:05d}",
        "Ngày chứng từ": f"{(i % 28) + 1:02d}/01/2026",
        "Mã NCC": f"NCC{i % 20:02d}",
        "Tên NCC": f"NCC {i % 20}",
        "Mã hàng": f"MH{i:04d}",
        "Số lượng": (i % 4) + 1,
        "Đơn giá": 8000 + i * 80,
    }


def _purchase_common_row(i: int, rng: random.Random) -> dict[str, Any]:
    return {
        "Số PN": f"PN{i:05d}",
        "Ngày nhập": f"2026-01-{(i % 28) + 1:02d}",
        "Mã NCC": f"N{i % 15:02d}",
        "Tên NCC": f"Supplier {i % 15}",
        "Mã hàng": f"P{i:04d}",
        "Số lượng": 2,
        "Đơn giá": 12000,
    }


def _purchase_messy_row(i: int, rng: random.Random) -> dict[str, Any]:
    return {
        "Số PN nội bộ": f"PNX{i:05d}",
        "Ngày nhập": datetime(2026, 1, (i % 28) + 1),
        "Mã NCC nội bộ": f"NCC{i % 23:03d}",
        "Tên NCC đầy đủ": f"Nhà cung cấp {i % 23}",
        "Mã SKU mua": f"SKU-M{i:05d}",
        "SL nhập": (i % 6) + 1,
        "Giá mua": f"{8000 + i * 90:,}".replace(",", "."),
    }


SALES_PROFILES: tuple[HeaderProfile, ...] = (
    HeaderProfile("sales_formal", "sales", tuple(_sales_formal_row(0, random.Random(0)).keys()), _sales_formal_row),
    HeaderProfile("sales_retail", "sales", tuple(_sales_retail_row(0, random.Random(0)).keys()), _sales_retail_row),
    HeaderProfile("sales_minimal", "sales", tuple(_sales_minimal_row(0, random.Random(0)).keys()), _sales_minimal_row),
    HeaderProfile(
        "sales_shuffled",
        "sales",
        tuple(_sales_formal_row(0, random.Random(0)).keys()),
        _sales_formal_row,
    ),
)

PURCHASE_PROFILES: tuple[HeaderProfile, ...] = (
    HeaderProfile("purchase_formal", "purchase", tuple(_purchase_formal_row(0, random.Random(0)).keys()), _purchase_formal_row),
    HeaderProfile("purchase_common", "purchase", tuple(_purchase_common_row(0, random.Random(0)).keys()), _purchase_common_row),
    HeaderProfile("purchase_messy", "purchase", tuple(_purchase_messy_row(0, random.Random(0)).keys()), _purchase_messy_row),
)

ALL_PROFILES = SALES_PROFILES + PURCHASE_PROFILES

SALES_CONVERSION_TYPES = tuple(
    ct for ct, d in CONVERSION_TYPES.items() if d.kind.startswith("sales")
)
PURCHASE_CONVERSION_TYPES = tuple(
    ct for ct, d in CONVERSION_TYPES.items() if d.kind.startswith("purchase")
)


def write_profile_workbook(
    path: Path,
    profile: HeaderProfile,
    *,
    row_count: int = 12,
    seed: int = 42,
    preamble: bool = True,
    blank_every: int = 0,
    shuffle_headers: bool = False,
) -> None:
    rng = random.Random(seed)
    headers = list(profile.headers)
    if shuffle_headers or profile.id.endswith("_shuffled"):
        rng.shuffle(headers)

    wb = openpyxl.Workbook()
    ws = wb.active
    if preamble:
        ws.append(["EzFormat stress fixture", profile.id])
        ws.append(["Generated", datetime.now().isoformat(timespec="seconds")])
    ws.append(headers)
    for i in range(row_count):
        row = profile.row_builder(i + 1, rng)
        ws.append([row.get(h) for h in headers])
        if blank_every and (i + 1) % blank_every == 0:
            ws.append([None] * len(headers))
    wb.save(path)


def matrix_cases() -> list[tuple[str, HeaderProfile, str]]:
    """(case_id, profile, conversion_type) — full Cartesian for applicable kinds."""
    cases: list[tuple[str, HeaderProfile, str]] = []
    for profile in SALES_PROFILES:
        for ct in SALES_CONVERSION_TYPES:
            cases.append((f"{profile.id}__{ct}", profile, ct))
    for profile in PURCHASE_PROFILES:
        for ct in PURCHASE_CONVERSION_TYPES:
            cases.append((f"{profile.id}__{ct}", profile, ct))
    return cases


EDGE_DATE_VALUES = (
    "25/12/2025",
    "2025-12-25",
    datetime(2025, 12, 25),
)
EDGE_NUMBER_VALUES = (
    100000,
    100000.0,
    "100,000",
    "100.000",
    "100000 VNĐ",
)
