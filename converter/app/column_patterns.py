"""Keyword-based column detection fallback when exact aliases miss."""

from __future__ import annotations

from app.normalization import normalize_header

FIELD_PATTERNS: dict[str, tuple[tuple[str, ...], ...]] = {
    "invoice": (("hoa_don",), ("so_hd",), ("ma_hd",), ("hd",), ("invoice",)),
    "purchase_receipt": (("phieu_nhap",), ("so_pn",), ("pn",), ("receipt",)),
    "date": (("ngay",), ("thoi_gian",), ("date",)),
    "customer_code": (("ma", "khach"), ("customer", "code")),
    "customer_name": (("ten", "khach"), ("nguoi_mua",), ("khach_hang",), ("customer",)),
    "customer_address": (("dia_chi",), ("address",)),
    "supplier_code": (("ma", "ncc"), ("ma", "nha_cung_cap"), ("supplier", "code")),
    "supplier_name": (("ten", "ncc"), ("ten", "nha_cung_cap"), ("supplier",)),
    "item_code": (("ma", "sku"), ("ma", "hang"), ("item", "code"), ("sku",)),
    "item_name": (("ten", "sku"), ("ten", "hang"), ("mat_hang",), ("item", "name")),
    "unit": (("dvt",), ("don_vi",), ("unit",)),
    "quantity": (("so_luong",), ("sl",), ("qty",), ("quantity",)),
    "unit_price": (("don_gia",), ("gia_ban",), ("gia_mua",), ("unit_price",), ("price",)),
    "line_amount": (("thanh_tien",), ("tong_dong",), ("line_total",), ("amount",)),
    "discount_percent": (("ck", "percent"), ("giam_gia", "percent"), ("discount", "percent")),
    "discount_amount": (("tien", "ck"), ("giam_gia",), ("discount",)),
    "discount_total": (("tong", "ck"), ("tong", "chiet_khau"), ("discount",)),
    "invoice_subtotal": (("tong_tien_hang",), ("tong_truoc_thue",), ("subtotal",)),
    "invoice_discount": (("chiet_khau_hoa_don",), ("giam_gia_hoa_don",)),
    "vat_rate": (("vat", "percent"), ("thue_suat",), ("gtgt", "percent")),
    "vat_amount": (("tien", "vat"), ("tien", "thue"), ("thue_gtgt",)),
    "other_charges": (("thu_khac",), ("phi_khac",)),
    "payable": (("can_tra",), ("phai_tra",), ("tong_thanh_toan",), ("payable",)),
    "payment_method": (("pt", "thanh_toan"), ("phuong_thuc", "thanh_toan"), ("payment",)),
    "debit_account": (("tk", "no"), ("tai_khoan", "no"), ("tk", "cong_no"), ("tk", "tien")),
    "revenue_account": (("tk", "doanh_thu"), ("tk", "dt"), ("revenue", "account")),
    "vat_account": (("tk", "thue", "ban"), ("tk", "thue_gtgt"), ("vat", "account")),
    "input_vat_account": (("tk", "thue", "mua"), ("vat", "dau_vao"), ("tk", "vat")),
    "inventory_account": (("tk", "kho"), ("tk", "chi_phi"), ("inventory", "account")),
    "cogs_account": (("tk", "gia_von"), ("cogs",), ("gia_von",)),
    "payable_account": (("tk", "cong_no"), ("tk", "phai_tra"), ("tk", "thanh_toan")),
    "discount_account": (("tk", "chiet_khau"), ("tk", "ck"), ("tk", "giam_tru")),
    "item_type": (("loai", "hang"), ("loai", "hhdv"), ("item", "type")),
}


def best_header_for_field(
    headers: list[str],
    field: str,
    used_headers: set[str],
) -> str | None:
    patterns = FIELD_PATTERNS.get(field, ())
    normalized_headers = [(header, normalize_header(header)) for header in headers if header]
    for pattern in patterns:
        target = "_".join(pattern)
        for header, normalized in normalized_headers:
            if header in used_headers or _header_rejected_for_field(field, normalized):
                continue
            if normalized == target:
                return header
    for pattern in patterns:
        for header, normalized in normalized_headers:
            if header in used_headers:
                continue
            if _header_rejected_for_field(field, normalized):
                continue
            if all(token in normalized for token in pattern):
                return header
    return None


def _header_rejected_for_field(field: str, normalized_header: str) -> bool:
    if field == "unit_price":
        return any(token in normalized_header for token in ("giam", "chiet_khau", "ck"))
    return False
