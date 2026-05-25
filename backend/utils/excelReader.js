/**
 * excelReader.js
 * Reads an Excel file buffer and returns rows from the first sheet as JSON.
 * Each row is an object keyed by header value.
 */

const XLSX = require("xlsx");

/**
 * Parse an Excel buffer into an array of row objects.
 * @param {Buffer} buffer - The Excel file buffer
 * @returns {{ headers: string[], rows: Object[] }}
 */
function readExcelBuffer(buffer) {
  // Parse workbook from buffer
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

  // Use the first sheet
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  // Convert to JSON (header: 1 → array of arrays for flexible mapping)
  const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1, // Return as array of arrays
    defval: "", // Default empty cells to empty string
    blankrows: false, // Skip fully blank rows
  });

  if (!rawRows || rawRows.length < 2) {
    return { headers: [], rows: [] };
  }

  // First row is headers
  const headers = rawRows[0].map((h) => String(h).trim());

  // Remaining rows become objects keyed by header
  const rows = rawRows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = row[idx] !== undefined ? row[idx] : "";
    });
    return obj;
  });

  return { headers, rows };
}

module.exports = { readExcelBuffer };
