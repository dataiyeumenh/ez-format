from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = BACKEND_ROOT / "fixtures" / "templates"


@dataclass(frozen=True)
class ConversionTypeDefinition:
    id: str
    label: str
    template_path: Path
    kind: str
    required_source_fields: tuple[str, ...]
    required_output_headers: tuple[str, ...]
    defaults: dict[str, object] = field(default_factory=dict)


SALES_REQUIRED_SOURCE_FIELDS = (
    "invoice",
    "date",
    "customer_name",
    "item_code",
    "quantity",
    "unit_price",
)

PURCHASE_REQUIRED_SOURCE_FIELDS = (
    "purchase_receipt",
    "date",
    "supplier_code",
    "supplier_name",
    "item_code",
    "quantity",
    "unit_price",
)

SALES_GOODS_REQUIRED_HEADERS = (
    "Hình thức bán hàng",
    "Phương thức thanh toán",
    "Ngày hạch toán (*)",
    "Ngày chứng từ (*)",
    "Số chứng từ (*)",
    "Mã hàng (*)",
    "TK Tiền/Chi phí/Nợ (*)",
    "TK Doanh thu/Có (*)",
)

SALES_SERVICE_REQUIRED_HEADERS = (
    "Phương thức thanh toán",
    "Ngày hạch toán (*)",
    "Ngày chứng từ (*)",
    "Số chứng từ (*)",
    "Mã dịch vụ (*)",
    "TK Tiền/Chi phí/Nợ (*)",
    "TK Doanh thu/Có (*)",
)

PURCHASE_GOODS_REQUIRED_HEADERS = (
    "Hình thức mua hàng",
    "Phương thức thanh toán",
    "Ngày hạch toán (*)",
    "Ngày chứng từ (*)",
    "Mã hàng (*)",
    "TK kho/TK chi phí (*)",
    "TK công nợ/TK tiền (*)",
)

MISA_PURCHASE_DOMESTIC_REQUIRED_HEADERS = (
    "Hình thức mua hàng",
    "Phương thức thanh toán",
    "Ngày hạch toán (*)",
    "Ngày chứng từ (*)",
    "Số phiếu nhập (*)",
    "Mã hàng (*)",
    "TK kho/TK chi phí (*)",
    "TK công nợ/TK tiền (*)",
)

PURCHASE_SERVICE_REQUIRED_HEADERS = (
    "Phương thức thanh toán",
    "Ngày hạch toán (*)",
    "Ngày chứng từ (*)",
    "Số chứng từ (*)",
    "Mã dịch vụ (*)",
    "TK kho/TK chi phí (*)",
    "TK công nợ/TK tiền (*)",
)

SALES_DEFAULTS: dict[str, object] = {
    "Hình thức bán hàng": "Bán hàng hóa trong nước",
    "Phương thức thanh toán": "Chưa thu tiền",
    "Kiêm phiếu xuất kho": "Có",
    "Lập kèm hóa đơn": "Không",
    "Đã lập hóa đơn": "Đã lập",
    "Là dòng ghi chú": "không",
    "Hàng khuyến mại": "Không",
    "TK Tiền/Chi phí/Nợ (*)": "131",
    "TK Doanh thu/Có (*)": "5111",
    "ĐVT": "Hộp",
    "TK chiết khấu": "5111",
    "TK thuế GTGT": "33311",
    "Mã kho": "KHO_BSN",
    "TK giá vốn": "632",
    "TK Kho": "1561",
}

PURCHASE_DEFAULTS: dict[str, object] = {
    "Hình thức mua hàng": "Mua hàng trong nước nhập kho",
    "Phương thức thanh toán": "Chưa thanh toán",
    "Nhận kèm hóa đơn": "Nhận kèm hóa đơn",
    "TK kho/TK chi phí (*)": "1561",
    "TK công nợ/TK tiền (*)": "331",
    "ĐVT": "Cái",
}

MISA_PURCHASE_DOMESTIC_DEFAULTS: dict[str, object] = {
    "Phương thức thanh toán": "Chưa thanh toán",
    "Nhận kèm hóa đơn": "Nhận kèm hóa đơn",
    "TK công nợ/TK tiền (*)": "331",
    "Là dòng ghi chú": "Không",
}

CONVERSION_TYPES: dict[str, ConversionTypeDefinition] = {
    "bsn_sales": ConversionTypeDefinition(
        id="bsn_sales",
        label="BSN - Form import bán hàng",
        template_path=TEMPLATE_DIR / "bsn_sales.xls",
        kind="sales_goods",
        required_source_fields=SALES_REQUIRED_SOURCE_FIELDS,
        required_output_headers=SALES_GOODS_REQUIRED_HEADERS,
        defaults=SALES_DEFAULTS,
    ),
    "bsn_purchase": ConversionTypeDefinition(
        id="bsn_purchase",
        label="BSN - Form import mua hàng",
        template_path=TEMPLATE_DIR / "bsn_purchase.xls",
        kind="purchase_goods",
        required_source_fields=PURCHASE_REQUIRED_SOURCE_FIELDS,
        required_output_headers=PURCHASE_GOODS_REQUIRED_HEADERS,
        defaults=PURCHASE_DEFAULTS,
    ),
    "misa_purchase_domestic": ConversionTypeDefinition(
        id="misa_purchase_domestic",
        label="Mua hàng trong nước - MISA",
        template_path=TEMPLATE_DIR / "mua_hang_trong_nuoc_full.xls",
        kind="purchase_goods",
        required_source_fields=PURCHASE_REQUIRED_SOURCE_FIELDS,
        required_output_headers=MISA_PURCHASE_DOMESTIC_REQUIRED_HEADERS,
        defaults=MISA_PURCHASE_DOMESTIC_DEFAULTS,
    ),
    "sales_goods": ConversionTypeDefinition(
        id="sales_goods",
        label="Form bán hàng hóa",
        template_path=TEMPLATE_DIR / "sales_goods.xls",
        kind="sales_goods",
        required_source_fields=SALES_REQUIRED_SOURCE_FIELDS,
        required_output_headers=SALES_GOODS_REQUIRED_HEADERS,
        defaults=SALES_DEFAULTS,
    ),
    "sales_service": ConversionTypeDefinition(
        id="sales_service",
        label="Form bán hàng dịch vụ",
        template_path=TEMPLATE_DIR / "sales_service.xls",
        kind="sales_service",
        required_source_fields=SALES_REQUIRED_SOURCE_FIELDS,
        required_output_headers=SALES_SERVICE_REQUIRED_HEADERS,
        defaults=SALES_DEFAULTS,
    ),
    "purchase_goods": ConversionTypeDefinition(
        id="purchase_goods",
        label="Form mua hàng hóa",
        template_path=TEMPLATE_DIR / "purchase_goods.xls",
        kind="purchase_goods",
        required_source_fields=PURCHASE_REQUIRED_SOURCE_FIELDS,
        required_output_headers=PURCHASE_GOODS_REQUIRED_HEADERS,
        defaults=PURCHASE_DEFAULTS,
    ),
    "purchase_service": ConversionTypeDefinition(
        id="purchase_service",
        label="Form mua dịch vụ",
        template_path=TEMPLATE_DIR / "purchase_service.xls",
        kind="purchase_service",
        required_source_fields=PURCHASE_REQUIRED_SOURCE_FIELDS,
        required_output_headers=PURCHASE_SERVICE_REQUIRED_HEADERS,
        defaults=PURCHASE_DEFAULTS,
    ),
}


def get_conversion_type(conversion_type: str) -> ConversionTypeDefinition:
    try:
        return CONVERSION_TYPES[conversion_type]
    except KeyError as exc:
        raise ValueError(f"Unsupported conversion_type: {conversion_type}") from exc
