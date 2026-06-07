const path = require("path");

const TEMPLATE_DIR = path.join(__dirname, "..", "fixtures", "templates");

const SALES_REQUIRED_SOURCE_FIELDS = [
  "invoice",
  "date",
  "customer_name",
  "item_code",
  "quantity",
  "unit_price",
];

const PURCHASE_REQUIRED_SOURCE_FIELDS = [
  "purchase_receipt",
  "date",
  "supplier_code",
  "supplier_name",
  "item_code",
  "quantity",
  "unit_price",
];

const SALES_GOODS_REQUIRED_HEADERS = [
  "Hình thức bán hàng",
  "Phương thức thanh toán",
  "Ngày hạch toán (*)",
  "Ngày chứng từ (*)",
  "Số chứng từ (*)",
  "Mã hàng (*)",
  "TK Tiền/Chi phí/Nợ (*)",
  "TK Doanh thu/Có (*)",
];

const SALES_SERVICE_REQUIRED_HEADERS = [
  "Phương thức thanh toán",
  "Ngày hạch toán (*)",
  "Ngày chứng từ (*)",
  "Số chứng từ (*)",
  "Mã dịch vụ (*)",
  "TK Tiền/Chi phí/Nợ (*)",
  "TK Doanh thu/Có (*)",
];

const PURCHASE_GOODS_REQUIRED_HEADERS = [
  "Hình thức mua hàng",
  "Phương thức thanh toán",
  "Ngày hạch toán (*)",
  "Ngày chứng từ (*)",
  "Mã hàng (*)",
  "TK kho/TK chi phí (*)",
  "TK công nợ/TK tiền (*)",
];

const PURCHASE_SERVICE_REQUIRED_HEADERS = [
  "Phương thức thanh toán",
  "Ngày hạch toán (*)",
  "Ngày chứng từ (*)",
  "Số chứng từ (*)",
  "Mã dịch vụ (*)",
  "TK kho/TK chi phí (*)",
  "TK công nợ/TK tiền (*)",
];

const SALES_DEFAULTS = {
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
};

const PURCHASE_DEFAULTS = {
  "Hình thức mua hàng": "Mua hàng trong nước nhập kho",
  "Phương thức thanh toán": "Chưa thanh toán",
  "Nhận kèm hóa đơn": "Nhận kèm hóa đơn",
  "TK kho/TK chi phí (*)": "1561",
  "TK công nợ/TK tiền (*)": "331",
  "ĐVT": "Cái",
};

const CONVERSION_TYPES = {
  bsn_sales: {
    id: "bsn_sales",
    label: "BSN - Form import bán hàng",
    templatePath: path.join(TEMPLATE_DIR, "bsn_sales.xls"),
    kind: "sales_goods",
    requiredSourceFields: SALES_REQUIRED_SOURCE_FIELDS,
    requiredOutputHeaders: SALES_GOODS_REQUIRED_HEADERS,
    defaults: SALES_DEFAULTS,
  },
  bsn_purchase: {
    id: "bsn_purchase",
    label: "BSN - Form import mua hàng",
    templatePath: path.join(TEMPLATE_DIR, "bsn_purchase.xls"),
    kind: "purchase_goods",
    requiredSourceFields: PURCHASE_REQUIRED_SOURCE_FIELDS,
    requiredOutputHeaders: PURCHASE_GOODS_REQUIRED_HEADERS,
    defaults: PURCHASE_DEFAULTS,
  },
  sales_goods: {
    id: "sales_goods",
    label: "Form bán hàng hóa",
    templatePath: path.join(TEMPLATE_DIR, "sales_goods.xls"),
    kind: "sales_goods",
    requiredSourceFields: SALES_REQUIRED_SOURCE_FIELDS,
    requiredOutputHeaders: SALES_GOODS_REQUIRED_HEADERS,
    defaults: SALES_DEFAULTS,
  },
  sales_service: {
    id: "sales_service",
    label: "Form bán hàng dịch vụ",
    templatePath: path.join(TEMPLATE_DIR, "sales_service.xls"),
    kind: "sales_service",
    requiredSourceFields: SALES_REQUIRED_SOURCE_FIELDS,
    requiredOutputHeaders: SALES_SERVICE_REQUIRED_HEADERS,
    defaults: SALES_DEFAULTS,
  },
  purchase_goods: {
    id: "purchase_goods",
    label: "Form mua hàng hóa",
    templatePath: path.join(TEMPLATE_DIR, "purchase_goods.xls"),
    kind: "purchase_goods",
    requiredSourceFields: PURCHASE_REQUIRED_SOURCE_FIELDS,
    requiredOutputHeaders: PURCHASE_GOODS_REQUIRED_HEADERS,
    defaults: PURCHASE_DEFAULTS,
  },
  purchase_service: {
    id: "purchase_service",
    label: "Form mua dịch vụ",
    templatePath: path.join(TEMPLATE_DIR, "purchase_service.xls"),
    kind: "purchase_service",
    requiredSourceFields: PURCHASE_REQUIRED_SOURCE_FIELDS,
    requiredOutputHeaders: PURCHASE_SERVICE_REQUIRED_HEADERS,
    defaults: PURCHASE_DEFAULTS,
  },
};

function getConversionType(conversionType) {
  const definition = CONVERSION_TYPES[conversionType];
  if (!definition) {
    throw new Error(`Unsupported conversion_type: ${conversionType}`);
  }
  return definition;
}

module.exports = {
  CONVERSION_TYPES,
  getConversionType,
};
