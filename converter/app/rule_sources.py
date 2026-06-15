from __future__ import annotations

from app.models import RuleSource


VERIFIED_AT = "2026-06-14"

LEGAL_DISCLAIMER = (
    "EzFormat chỉ kiểm tra template MISA, công thức toán học và các rule đã cấu hình. "
    "Kết quả là cảnh báo hỗ trợ rà soát, không phải chứng nhận tuân thủ pháp luật 100%."
)

ACCOUNTING_LAW = RuleSource(
    title="Luật Kế toán 88/2015/QH13",
    url="https://vanban.chinhphu.vn/default.aspx?docid=183198&pageid=27160",
    effective_from="2017-01-01",
    verified_at=VERIFIED_AT,
)

TT99 = RuleSource(
    title="Thông tư 99/2025/TT-BTC",
    url="https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529.htm",
    effective_from="2026-01-01",
    verified_at=VERIFIED_AT,
)

TT99_FISCAL_YEAR = RuleSource(
    title="Bộ Tài chính Q&A về thời điểm áp dụng Thông tư 99/2025/TT-BTC",
    url="https://portal.mof.gov.vn/hoidapcstc/home/cthoidap/159102",
    effective_from="2026-01-01",
    verified_at=VERIFIED_AT,
)

VAT_LAW = RuleSource(
    title="Luật Thuế GTGT 48/2024/QH15",
    url="https://vanban.chinhphu.vn/?classid=1&docid=212476&orggroupid=1&pageid=27160",
    effective_from="2025-07-01",
    verified_at=VERIFIED_AT,
)

VAT_DECREE_181 = RuleSource(
    title="Nghị định 181/2025/NĐ-CP hướng dẫn Luật Thuế GTGT",
    url="https://vanban.chinhphu.vn/?docid=214336&pageid=27160",
    effective_from="2025-07-01",
    verified_at=VERIFIED_AT,
)

VAT_8_DECREE = RuleSource(
    title="Nghị định 174/2025/NĐ-CP về giảm thuế GTGT",
    url="https://vanban.chinhphu.vn/?docid=214310&pageid=27160",
    effective_from="2025-07-01",
    effective_to="2026-12-31",
    verified_at=VERIFIED_AT,
)

VAT_8_WINDOW = RuleSource(
    title="Thông tin Chính phủ về giảm thuế GTGT từ 01/07/2025 đến 31/12/2026",
    url="https://baochinhphu.vn/giam-thue-gia-tri-gia-tang-tu-01-7-2025-den-het-31-12-2026-10225070118590677.htm",
    effective_from="2025-07-01",
    effective_to="2026-12-31",
    verified_at=VERIFIED_AT,
)

MISA_IMPORT_REQUIRED = RuleSource(
    title="MISA AMIS: Nhập khẩu dữ liệu, cột có (*) là bắt buộc",
    url="https://helpamis.misa.vn/kb/nhap-khau/",
    verified_at=VERIFIED_AT,
)

RULE_SOURCES = {
    "accounting_law": ACCOUNTING_LAW,
    "tt99": TT99,
    "tt99_fiscal_year": TT99_FISCAL_YEAR,
    "vat_law": VAT_LAW,
    "vat_decree_181": VAT_DECREE_181,
    "vat_8_decree": VAT_8_DECREE,
    "vat_8_window": VAT_8_WINDOW,
    "misa_import_required": MISA_IMPORT_REQUIRED,
}

