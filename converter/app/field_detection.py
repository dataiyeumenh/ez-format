from __future__ import annotations

from typing import Any

from app.column_patterns import best_header_for_field
from app.normalization import normalize_header, normalize_record_keys


FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "invoice": ("ma_hoa_don", "so_chung_tu", "so_chung_tu_ban_hang", "so_hd"),
    "invoice_symbol": ("ky_hieu_hd", "sr_hd"),
    "invoice_date": ("ngay_hoa_don", "ngay_hd"),
    "date": (
        "ngayct",
        "thoi_gian",
        "ngay_hach_toan",
        "ngay_chung_tu",
        "thoi_gian_tao",
        "ngay_nhap",
        "ngay_ct",
        "ngay_hd",
    ),
    "customer_code": ("ma_khach_hang",),
    "customer_name": ("ten_khach_hang",),
    "customer_address": ("dia_chi_khach_hang", "dia_chi"),
    "purchase_receipt": (
        "so_phieu_nhap",
        "so_pn",
        "so_pn_noi_bo",
        "soct",
        "pn",
        "phieu_nhap",
    ),
    "supplier_code": ("ma_nha_cung_cap", "ma_ncc", "nha_cung_cap", "ma_ncc_noi_bo", "makh", "ms_dn"),
    "supplier_name": ("ten_nha_cung_cap", "ten_ncc", "ten_ncc_day_du", "tenkh", "khachhang"),
    "supplier_address": ("dia_chi_nha_cung_cap", "dia_chi_ncc", "diachi", "diachi_ngd"),
    "item_code": ("ma_hang", "ma_dich_vu", "ma_sku_ban", "ma_sku_mua", "mathang"),
    "item_name": ("ten_hang", "ten_dich_vu", "tendm"),
    "unit": ("dvt", "don_vi_tinh", "donvi"),
    "quantity": ("so_luong", "sl_ban", "sl_nhap", "luong"),
    "unit_price": ("don_gia", "gia_ban", "gia_mua", "dgvnd"),
    "line_amount": ("thanh_tien", "ttvnd"),
    "discount_percent": ("giam_gia_percent", "ty_le_ck_percent", "pt_ck"),
    "discount_amount": ("giam_gia", "tien_chiet_khau", "column1", "chietkhau"),
    "discount_total": ("tien_chiet_khau", "column1", "tong_tien_chiet_khau"),
    "invoice_subtotal": ("tong_tien_hang", "tong_tien_truoc_thue"),
    "invoice_discount": ("giam_gia_hoa_don", "chiet_khau_hoa_don"),
    "vat": ("vat", "percent_thue_gtgt"),
    "vat_rate": ("percent_vat", "vat_percent", "thue_suat", "thue_suat_gtgt", "percent_thue_gtgt", "ts_gtgt"),
    "vat_amount": ("tien_thue", "tien_thue_gtgt", "vat", "thuevnd"),
    "other_charges": ("thu_khac",),
    "payable": ("khach_can_tra", "tong_thanh_toan", "tong_tien_thanh_toan"),
    "lot": ("lo", "so_lo"),
    "expiry_date": ("han_su_dung",),
    "payment_method": ("phuong_thuc_thanh_toan", "pt_thanh_toan", "hinh_thuc_thanh_toan", "httt"),
    "debit_account": (
        "tk_tien_chi_phi_no",
        "tk_no",
        "tai_khoan_no",
        "tk_no_ban",
        "tk_cong_no",
    ),
    "credit_account": ("tk_doanh_thu_co", "tk_co", "tai_khoan_co"),
    "revenue_account": ("tk_doanh_thu_co", "tk_doanh_thu", "tai_khoan_doanh_thu", "tk_dt_ban"),
    "vat_account": ("tk_thue_gtgt", "tk_thue", "tai_khoan_thue_gtgt", "tk_thue_ban"),
    "input_vat_account": ("tk_thue_mua", "tk_thue_gtgt_dau_vao", "tk_vat_dau_vao", "tkthue"),
    "inventory_account": (
        "tk_kho_tk_chi_phi",
        "tk_kho_chi_phi",
        "tk_kho",
        "tk_chi_phi",
        "tk_kho_ban",
        "tkno",
    ),
    "cogs_account": ("tk_gia_von", "tai_khoan_gia_von", "tk_gia_von_ban"),
    "payable_account": (
        "tk_cong_no_tk_tien",
        "tk_cong_no_tk_tien_mua",
        "tk_cong_no_tien",
        "tk_cong_no_tien_mua",
        "tk_phai_tra",
        "tk_thanh_toan",
        "tkco",
    ),
    "discount_account": ("tk_chiet_khau", "tk_ck_ban", "tk_giam_tru"),
    "item_type": ("loai_hang", "loai_hhdv", "hang_hoa_dich_vu", "phan_loai"),
}


ALLOWED_SEMANTIC_FIELDS = frozenset(FIELD_ALIASES)


def detect_columns(headers: list[str]) -> dict[str, str]:
    normalized_to_original = {normalize_header(header): header for header in headers if header}
    detected: dict[str, str] = {}
    for field, aliases in FIELD_ALIASES.items():
        for alias in aliases:
            if alias in normalized_to_original:
                detected[field] = normalized_to_original[alias]
                break

    used = set(detected.values())
    for field in ALLOWED_SEMANTIC_FIELDS:
        if field in detected:
            continue
        header = best_header_for_field(headers, field, used)
        if header:
            detected[field] = header
            used.add(header)
    return detected


def apply_column_mapping(
    detected_columns: dict[str, str],
    headers: list[str],
    column_mapping: object,
) -> tuple[dict[str, str], list[dict[str, str]]]:
    output = dict(detected_columns)
    if column_mapping is None:
        return output, []

    if not isinstance(column_mapping, dict):
        return output, [
            {
                "field": "column_mapping",
                "code": "invalid_column_mapping",
                "message": "options.column_mapping must be a JSON object.",
            }
        ]

    header_set = {str(header).strip() for header in headers if str(header).strip()}
    normalized_to_original = {normalize_header(header): header for header in header_set}
    errors: list[dict[str, str]] = []

    for raw_field, raw_header in column_mapping.items():
        field = str(raw_field).strip()
        if field not in ALLOWED_SEMANTIC_FIELDS:
            errors.append(
                {
                    "field": field or "column_mapping",
                    "code": "invalid_column_mapping_field",
                    "message": f"Unsupported semantic field '{field}' in options.column_mapping.",
                }
            )
            continue

        if not isinstance(raw_header, str) or not raw_header.strip():
            errors.append(
                {
                    "field": field,
                    "code": "invalid_column_mapping_header",
                    "message": f"Column mapping for '{field}' must be a non-empty header name.",
                }
            )
            continue

        requested_header = raw_header.strip()
        resolved_header = requested_header
        if resolved_header not in header_set:
            resolved_header = normalized_to_original.get(normalize_header(requested_header), "")
        if not resolved_header:
            errors.append(
                {
                    "field": field,
                    "code": "missing_column_mapping_header",
                    "message": (
                        f"Column mapping for '{field}' points to missing source header "
                        f"'{requested_header}'."
                    ),
                }
            )
            continue

        output[field] = resolved_header

    return output, errors


def semantic_value(record: dict[str, Any], detected_columns: dict[str, str], field: str) -> Any:
    source_header = detected_columns.get(field)
    if not source_header:
        return None
    normalized_record = normalize_record_keys(record)
    return normalized_record.get(normalize_header(source_header))
