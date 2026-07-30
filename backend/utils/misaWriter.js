/**
 * misaWriter.js
 * Legacy preview header contract.
 * Workbook generation belongs exclusively to the canonical converter export.
 */

/**
 * Official MISA import column headers (in order).
 * These match the fields produced by misaMapper.mapToMisa().
 */
const MISA_HEADERS = [
  "Ngày hạch toán",
  "Ngày chứng từ",
  "Số chứng từ",
  "Diễn giải",
  "Mã khách hàng",
  "Tên khách hàng",
  "Mã hàng",
  "Tên hàng",
  "Đơn vị tính",
  "Số lượng",
  "Đơn giá",
  "Thành tiền",
  "% thuế GTGT",
  "Tiền thuế GTGT",
  "TK doanh thu",
  "TK công nợ",
];

module.exports = { MISA_HEADERS };
