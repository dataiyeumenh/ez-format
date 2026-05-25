/**
 * misaWriter.js
 * Writes MISA-formatted rows into an Excel workbook.
 * Loads the pre-built MISA template from /templates/misa.xlsx to preserve
 * official header styling. Falls back to programmatic headers if template
 * is unavailable.
 */

const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");

/** Path to the bundled MISA import template */
const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "misa.xlsx");

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

/**
 * Ensure the templates directory and misa.xlsx template exist.
 * Creates the template programmatically on first run.
 */
function ensureTemplate() {
  const dir = path.dirname(TEMPLATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    // Build a minimal template with just the header row
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([MISA_HEADERS]);

    // Style header row (bold) — basic column widths
    ws["!cols"] = MISA_HEADERS.map(() => ({ wch: 20 }));

    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, TEMPLATE_PATH);
    console.log("[misaWriter] Created MISA template at", TEMPLATE_PATH);
  }
}

/**
 * Build a new Excel workbook containing the MISA headers (from template) and
 * the mapped data rows.
 *
 * @param {Object[]} misaRows - Array of MISA row objects from misaMapper
 * @returns {Buffer} Excel file as a Buffer ready to send as HTTP response
 */
function buildMisaExcel(misaRows) {
  ensureTemplate();

  // Use MISA_HEADERS as the authoritative key list for row lookups.
  // Reading them back from the template XLSX risks Unicode normalization
  // differences that cause row[header] to return undefined.
  // The template file is used only to preserve its display header row.
  let displayHeaders = MISA_HEADERS;
  try {
    const templateWb = XLSX.readFile(TEMPLATE_PATH);
    const templateWs = templateWb.Sheets[templateWb.SheetNames[0]];
    const templateRows = XLSX.utils.sheet_to_json(templateWs, {
      header: 1,
      defval: "",
    });
    if (templateRows.length > 0 && templateRows[0].length > 0) {
      displayHeaders = templateRows[0].map(String);
    }
  } catch (err) {
    console.warn(
      "[misaWriter] Could not read template, using default headers:",
      err.message,
    );
  }

  // Build array-of-arrays: first row = display headers, then data rows.
  // Data lookup always uses MISA_HEADERS[i] (same JS strings as misaMapper
  // keys) to avoid Unicode roundtrip mismatches from the template file.
  const aoa = [displayHeaders];

  for (const row of misaRows) {
    const dataRow = MISA_HEADERS.map((key) => {
      const val = row[key];
      return val !== undefined && val !== null ? val : "";
    });
    aoa.push(dataRow);
  }

  // Create workbook
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Auto column widths
  ws["!cols"] = MISA_HEADERS.map(() => ({ wch: 22 }));

  XLSX.utils.book_append_sheet(wb, ws, "MISA Import");

  // Return as Buffer
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return buffer;
}

module.exports = { buildMisaExcel, ensureTemplate, MISA_HEADERS };
