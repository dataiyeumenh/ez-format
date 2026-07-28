from __future__ import annotations

from enum import StrEnum
from dataclasses import dataclass

from app.normalization import normalize_header


class FieldKind(StrEnum):
    ACCOUNT = "account"
    CODE = "code"
    CUSTOMER_CODE = "customer_code"
    DATE = "date"
    ENUM = "enum"
    ITEM_CODE = "item_code"
    LOCATION = "location"
    MONEY = "money"
    NUMBER = "number"
    SUPPLIER_CODE = "supplier_code"
    TAX_RATE = "tax_rate"
    TEXT = "text"


@dataclass(frozen=True)
class TemplateFieldMetadata:
    template_id: str
    header: str
    kind: FieldKind
    required: bool


def template_field_registry(
    target_template_id: str,
    template_headers: list[str],
) -> dict[str, TemplateFieldMetadata]:
    template_id = str(target_template_id or "").strip()
    if not template_id:
        raise ValueError("target_template_id is required for semantic validation")
    registry: dict[str, TemplateFieldMetadata] = {}
    for header in template_headers:
        name = str(header or "").strip()
        if not name:
            raise ValueError(f"Template {template_id} contains an empty header")
        if name in registry:
            raise ValueError(f"Template {template_id} contains duplicate header: {name}")
        registry[name] = TemplateFieldMetadata(
            template_id=template_id,
            header=name,
            kind=target_field_kind(name),
            required="(*)" in name,
        )
    return registry


def target_field_kind(header: str) -> FieldKind:
    value = normalize_header(header)
    if value.startswith("tk_") or value.startswith("tai_khoan_") or value.startswith("tk "):
        return FieldKind.ACCOUNT
    if "ma_nha_cung_cap" in value or value in {"ma_ncc", "madtpnco"}:
        return FieldKind.SUPPLIER_CODE
    if "ma_khach_hang" in value or value in {"ma_kh", "madtpnco"}:
        return FieldKind.CUSTOMER_CODE
    if "ma_hang" in value or "ma_vthh" in value or "ma_vat_tu" in value:
        return FieldKind.ITEM_CODE
    if any(token in value for token in ("ngay", "date", "han_su_dung")):
        return FieldKind.DATE
    if any(token in value for token in ("thue_suat", "percent_thue", "ts_gtgt", "vat_rate")):
        return FieldKind.TAX_RATE
    if any(token in value for token in ("hinh_thuc", "phuong_thuc", "loai_mua", "loai_ban", "phan_loai")):
        return FieldKind.ENUM
    if any(token in value for token in ("so_luong", "ty_le", "ty_gia", "quantity")):
        return FieldKind.NUMBER
    if any(token in value for token in ("tien", "thanh_tien", "don_gia", "gia_von", "tong_tien")):
        return FieldKind.MONEY
    if value.startswith(("so_chung_tu", "so_phieu", "so_hoa_don", "ky_hieu")):
        return FieldKind.CODE
    return FieldKind.TEXT


def source_field_kind(header: str) -> FieldKind:
    value = normalize_header(header)
    if any(token in value for token in ("phuong_xa", "khu_vuc", "dia_chi", "address", "quan_huyen")):
        return FieldKind.LOCATION
    if value.startswith(("tk_", "tai_khoan", "tk ")):
        return FieldKind.ACCOUNT
    if value in {"ma_hang", "mathang", "ma_vthh", "ma_sp", "ma_sku"} or "ma_hang" in value:
        return FieldKind.ITEM_CODE
    if "ma_khach_hang" in value or value in {"ma_kh", "makh"}:
        return FieldKind.CUSTOMER_CODE
    if "ma_nha_cung_cap" in value or value in {"ma_ncc", "mancc"}:
        return FieldKind.SUPPLIER_CODE
    if any(token in value for token in ("ngay", "thoi_gian", "date", "han_su_dung")):
        return FieldKind.DATE
    if any(token in value for token in ("thue_suat", "ts_gtgt", "vat", "percent")):
        return FieldKind.TAX_RATE
    if any(token in value for token in ("hinh_thuc", "phuong_thuc", "loai_mua", "loai_ban", "phan_loai", "httt")):
        return FieldKind.ENUM
    if any(token in value for token in ("so_luong", "luong", "quantity", "sl_")):
        return FieldKind.NUMBER
    if any(token in value for token in ("tien", "thanh_tien", "don_gia", "gia_ban", "gia_von", "tong_tien")):
        return FieldKind.MONEY
    if value.startswith(("so_chung_tu", "so_phieu", "so_hoa_don", "ma_hoa_don", "so_hd", "ky_hieu")):
        return FieldKind.CODE
    return FieldKind.TEXT


def is_strong_domain_mismatch(source: FieldKind, target: FieldKind) -> bool:
    if source == FieldKind.LOCATION:
        return target in {
            FieldKind.ACCOUNT,
            FieldKind.CODE,
            FieldKind.CUSTOMER_CODE,
            FieldKind.DATE,
            FieldKind.ENUM,
            FieldKind.ITEM_CODE,
            FieldKind.MONEY,
            FieldKind.NUMBER,
            FieldKind.SUPPLIER_CODE,
            FieldKind.TAX_RATE,
        }
    if target == FieldKind.ENUM:
        return source in {
            FieldKind.ACCOUNT,
            FieldKind.CODE,
            FieldKind.CUSTOMER_CODE,
            FieldKind.DATE,
            FieldKind.ITEM_CODE,
            FieldKind.MONEY,
            FieldKind.NUMBER,
            FieldKind.SUPPLIER_CODE,
            FieldKind.TAX_RATE,
        }
    if target == FieldKind.ACCOUNT:
        return source in {FieldKind.DATE, FieldKind.LOCATION, FieldKind.MONEY, FieldKind.NUMBER, FieldKind.TAX_RATE}
    if target in {FieldKind.DATE, FieldKind.MONEY, FieldKind.NUMBER, FieldKind.TAX_RATE}:
        return source in {FieldKind.ACCOUNT, FieldKind.LOCATION, FieldKind.ENUM}
    return False
