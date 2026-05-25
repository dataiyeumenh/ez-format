/**
 * columnDetector.js
 * Smart column detection using keyword matching (case-insensitive, Vietnamese + English).
 * Maps source column names to standardised MISA field keys.
 */

/**
 * Keyword map: MISA field key → list of possible source column name keywords.
 * Matching is case-insensitive and checks if the source header CONTAINS the keyword.
 */
const KEYWORD_MAP = {
  soChungTu: [
    "mã hóa đơn",
    "ma hoa don",
    "số hóa đơn",
    "so hoa don",
    "số lô",
    "so lo",
    "invoice no",
    "invoice number",
    "invoice#",
    "inv no",
    "inv#",
    "số chứng từ",
    "so chung tu",
    "số ct",
    "so ct",
    "order no",
    "order number",
    "batch no",
  ],
  ngayChungTu: [
    "ngày hóa đơn",
    "ngay hoa don",
    "ngày ct",
    "ngay ct",
    "ngày chứng từ",
    "ngay chung tu",
    "invoice date",
    "date",
    "ngày",
    "ngay",
    "transaction date",
  ],
  ngayHachToan: [
    "ngày hạch toán",
    "ngay hach toan",
    "posting date",
    "accounting date",
    "hạch toán",
  ],
  maKhachHang: [
    "mã khách",
    "ma khach",
    "mã kh",
    "ma kh",
    "customer code",
    "customer id",
    "client code",
  ],
  tenKhachHang: [
    "tên khách",
    "ten khach",
    "tên kh",
    "ten kh",
    "customer name",
    "client name",
    "buyer",
    "sold to",
  ],
  maHang: [
    "mã hàng",
    "ma hang",
    "mã sp",
    "ma sp",
    "item code",
    "product code",
    "sku",
    "article",
    "item no",
  ],
  dienGiai: [
    "tên hàng",
    "ten hang",
    "product name",
    "item name",
    "description",
    "mô tả",
    "mo ta",
    "hàng hóa",
    "hang hoa",
    "diễn giải",
    "dien giai",
    "nội dung",
    "noi dung",
  ],
  donViTinh: [
    "đơn vị tính",
    "don vi tinh",
    "đvt",
    "dvt",
    "unit",
    "uom",
    "unit of measure",
  ],
  soLuong: ["số lượng", "so luong", "sl", "qty", "quantity", "số lg", "so lg"],
  donGia: [
    "giá bán",
    "gia ban",
    "đơn giá",
    "don gia",
    "unit price",
    "price",
    "giá",
    "gia",
    "sale price",
    "selling price",
  ],
  thanhTien: [
    "thành tiền",
    "thanh tien",
    "tổng tiền",
    "tong tien",
    "total",
    "total amount",
    "amount",
    "line total",
    "sub total",
    "subtotal",
    "tiền hàng",
    "tien hang",
  ],
  thueVat: [
    "thuế gtgt",
    "thue gtgt",
    "thuế vat",
    "thue vat",
    "vat %",
    "tax %",
    "tax rate",
    "% thuế",
  ],
  tienThue: [
    "tiền thuế",
    "tien thue",
    "vat amount",
    "tax amount",
    "tiền vat",
    "tien vat",
  ],
  tkDoanhThu: [
    "tk doanh thu",
    "tài khoản doanh thu",
    "revenue account",
    "sales account",
  ],
  tkCongNo: [
    "tk công nợ",
    "tài khoản công nợ",
    "receivable account",
    "ar account",
  ],
};

/**
 * Normalise a string for comparison: lowercase + remove diacritics.
 * @param {string} str
 * @returns {string}
 */
function normalise(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/đ/g, "d")
    .trim();
}

/**
 * Detect which source column maps to each MISA field.
 * @param {string[]} headers - Array of source column header strings
 * @returns {Object} mapping: { misaField: sourceColumnName | null }
 */
function detectColumns(headers) {
  const mapping = {};
  const normHeaders = headers.map(normalise);

  for (const [field, keywords] of Object.entries(KEYWORD_MAP)) {
    let matched = null;

    for (const keyword of keywords) {
      const normKeyword = normalise(keyword);
      // Find a header that contains this keyword
      const idx = normHeaders.findIndex((h) => h.includes(normKeyword));
      if (idx !== -1) {
        matched = headers[idx];
        break;
      }
    }

    mapping[field] = matched; // null if not found
  }

  return mapping;
}

module.exports = { detectColumns };
