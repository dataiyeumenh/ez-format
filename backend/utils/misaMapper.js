/**
 * misaMapper.js
 * Maps source rows (using detected column mapping) to MISA-formatted row objects.
 * Handles value normalisation: dates, numbers, whitespace.
 */

/**
 * Format a date value to dd/MM/yyyy string (date only, no time).
 * Accepts JS Date objects, Excel serial numbers, or existing string dates.
 * @param {*} value
 * @returns {string}
 */
function formatDate(value) {
  if (!value && value !== 0) return "";

  // Already a JS Date (when cellDates: true in xlsx)
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return "";
    // Use local date parts to avoid UTC offset shifting the day
    const dd = String(value.getDate()).padStart(2, "0");
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const yyyy = value.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  // Numeric serial (Excel date serial)
  if (typeof value === "number") {
    // Excel epoch: Dec 30, 1899
    const excelEpoch = new Date(1899, 11, 30);
    const date = new Date(excelEpoch.getTime() + value * 86400000);
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  // String: strip time component then detect and reformat
  const str = String(value).trim();
  if (!str) return "";

  // Already dd/MM/yyyy (with optional time – strip it)
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmyMatch) {
    const [, dd, mm, yyyy] = dmyMatch;
    return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
  }

  // ISO format: yyyy-MM-ddT... or yyyy-MM-dd
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, yyyy, mm, dd] = isoMatch;
    return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
  }

  // dd-MM-yyyy or dd.MM.yyyy
  const altMatch = str.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})/);
  if (altMatch) {
    const [, dd, mm, yyyy] = altMatch;
    return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
  }

  return str; // Return as-is if unrecognised
}

/**
 * Normalise a numeric string: remove commas, trim whitespace, parse to number.
 * @param {*} value
 * @returns {number|string}
 */
function normaliseNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/,/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? "" : num;
}

/**
 * Safely get a string value from a row object by column name.
 * @param {Object} row
 * @param {string|null} colName
 * @returns {string}
 */
function getStr(row, colName) {
  if (!colName) return "";
  const val = row[colName];
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

/**
 * Map an array of source rows to MISA-formatted row objects.
 * @param {Object[]} sourceRows - Array of raw row objects from excelReader
 * @param {Object} columnMap - Mapping from detectColumns() { misaField: sourceColName }
 * @returns {Object[]} Array of MISA row objects
 */
function mapToMisa(sourceRows, columnMap) {
  return sourceRows.map((row) => {
    // Determine date: prefer ngayHachToan, fallback to ngayChungTu, fallback to today
    const dateRaw =
      (columnMap.ngayHachToan && row[columnMap.ngayHachToan]) ||
      (columnMap.ngayChungTu && row[columnMap.ngayChungTu]) ||
      "";
    const dateFormatted = formatDate(dateRaw) || formatDate(new Date());

    return {
      "Ngày hạch toán": dateFormatted,
      "Ngày chứng từ":
        formatDate(
          (columnMap.ngayChungTu && row[columnMap.ngayChungTu]) || dateRaw,
        ) || dateFormatted,
      "Số chứng từ": getStr(row, columnMap.soChungTu),
      "Diễn giải": getStr(row, columnMap.dienGiai),
      "Mã khách hàng": getStr(row, columnMap.maKhachHang),
      "Tên khách hàng": getStr(row, columnMap.tenKhachHang),
      "Mã hàng": getStr(row, columnMap.maHang),
      "Tên hàng": getStr(row, columnMap.dienGiai),
      "Đơn vị tính": getStr(row, columnMap.donViTinh),
      "Số lượng": normaliseNumber(
        columnMap.soLuong ? row[columnMap.soLuong] : "",
      ),
      "Đơn giá": normaliseNumber(columnMap.donGia ? row[columnMap.donGia] : ""),
      "Thành tiền": normaliseNumber(
        columnMap.thanhTien ? row[columnMap.thanhTien] : "",
      ),
      "% thuế GTGT": getStr(row, columnMap.thueVat),
      "Tiền thuế GTGT": normaliseNumber(
        columnMap.tienThue ? row[columnMap.tienThue] : "",
      ),
      "TK doanh thu": getStr(row, columnMap.tkDoanhThu),
      "TK công nợ": getStr(row, columnMap.tkCongNo),
    };
  });
}

module.exports = { mapToMisa };
