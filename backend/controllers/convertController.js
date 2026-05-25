/**
 * convertController.js
 * Orchestrates the full Excel → MISA conversion pipeline.
 *
 * Two endpoints:
 *  POST /api/convert         – Upload Excel, returns JSON preview data
 *  POST /api/convert/export  – Accepts edited JSON rows, returns Excel download
 */

const { readExcelBuffer } = require("../utils/excelReader");
const { detectColumns } = require("../utils/columnDetector");
const { mapToMisa } = require("../utils/misaMapper");
const { buildMisaExcel, MISA_HEADERS } = require("../utils/misaWriter");

/**
 * POST /api/convert
 * Expects: multipart/form-data with a single field "file" (Excel .xlsx/.xls)
 * Returns: JSON { headers: string[], rows: Object[] } for preview
 */
async function convertExcel(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "Không tìm thấy tệp. Vui lòng tải lên tệp Excel." });
    }

    /* --- Step 1: Read source Excel --- */
    const { headers, rows } = readExcelBuffer(req.file.buffer);
    if (!headers.length || !rows.length) {
      return res
        .status(422)
        .json({ error: "Tệp Excel không có dữ liệu hoặc thiếu hàng tiêu đề." });
    }

    /* --- Step 2: Detect columns --- */
    const columnMap = detectColumns(headers);
    console.log("[convert] Detected column mapping:", columnMap);

    /* --- Step 3: Map rows to MISA format --- */
    const misaRows = mapToMisa(rows, columnMap);
    if (!misaRows.length) {
      return res
        .status(422)
        .json({ error: "Không có hàng dữ liệu nào để chuyển đổi." });
    }

    /* --- Step 4: Return JSON for frontend preview --- */
    return res.json({ headers: MISA_HEADERS, rows: misaRows });
  } catch (err) {
    console.error("[convert] Conversion error:", err);
    return res.status(500).json({
      error: "Lỗi trong quá trình chuyển đổi. Vui lòng kiểm tra định dạng tệp.",
      detail: err.message,
    });
  }
}

/**
 * POST /api/convert/export
 * Expects: JSON body { rows: Object[] } – the (possibly edited) MISA rows
 * Returns: Excel file download
 */
async function exportExcel(req, res) {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "Không có dữ liệu để xuất." });
    }

    const outputBuffer = buildMisaExcel(rows);

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const filename = `MISA_Import_${timestamp}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", outputBuffer.length);
    return res.send(outputBuffer);
  } catch (err) {
    console.error("[export] Export error:", err);
    return res
      .status(500)
      .json({ error: "Lỗi khi xuất file.", detail: err.message });
  }
}

module.exports = { convertExcel, exportExcel };
