/**
 * convertController.js
 * Orchestrates the full Excel → MISA conversion pipeline.
 *
 * Legacy endpoints:
 *  POST /api/convert         – Upload Excel, returns JSON preview data
 *  POST /api/convert/export  – Bridges complete bindings to canonical export
 *
 * v1 endpoints for the external backend flow:
 *  GET  /api/v1/conversion-types
 *  POST /api/v1/conversions/validate
 *  POST /api/v1/conversions
 */

const { readExcelBuffer } = require("../utils/excelReader");
const { detectColumns } = require("../utils/columnDetector");
const { mapToMisa } = require("../utils/misaMapper");
const { MISA_HEADERS } = require("../utils/misaWriter");
const { forwardBinary } = require("../services/converterGatewayService");
const { getConversionTypes, getConversionType, buildValidationReport } = require("../services/conversionService");

const CANONICAL_EXPORT_PATH = "/api/v1/conversions/export";
const MIGRATION_ENDPOINT = "/api/converter/conversions/export";
const REQUIRED_EXPORT_FIELDS = ["upload_id", "profile_id", "conversion_run_id"];

function text(value) {
  return String(value || "").trim();
}

function legacyExportContract(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const contextToken = text(
    req.headers?.["x-conversion-context"] || body.conversion_context_token,
  );
  const missingFields = REQUIRED_EXPORT_FIELDS.filter((field) => !text(body[field]));
  if (!contextToken) missingFields.push("conversion_context_token");

  if (missingFields.length === 0) {
    return { ok: true, body, contextToken };
  }

  const hasCanonicalBinding = REQUIRED_EXPORT_FIELDS.some((field) => text(body[field]));
  return {
    ok: false,
    status: hasCanonicalBinding || contextToken ? 422 : 410,
    code:
      hasCanonicalBinding || contextToken
        ? "MISA_TEMPLATE_EXPORT_CONTEXT_REQUIRED"
        : "LEGACY_MISA_EXPORT_RETIRED",
    error:
      hasCanonicalBinding || contextToken
        ? "MISA template export requires the complete canonical conversion binding."
        : "Legacy client-row MISA export is retired. Use the authenticated template export flow.",
    missingFields,
  };
}

function sendMigrationResponse(contract, res) {
  return res.status(contract.status).json({
    error: contract.error,
    code: contract.code,
    migration_endpoint: MIGRATION_ENDPOINT,
    required_fields: [...REQUIRED_EXPORT_FIELDS, "conversion_context_token"],
    missing_fields: contract.missingFields,
  });
}

function legacyExportMigrationGate(req, res, next) {
  const contract = legacyExportContract(req);
  if (!contract.ok) return sendMigrationResponse(contract, res);
  req.legacyMisaExportContract = contract;
  return next();
}

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
 * Compatibility bridge for clients carrying a complete canonical export binding.
 * Rows-only export is retired because it bypasses the real MISA template pipeline.
 */
async function exportExcel(req, res) {
  const contract = req.legacyMisaExportContract || legacyExportContract(req);
  if (!contract.ok) return sendMigrationResponse(contract, res);

  try {
    const response = await forwardBinary({
      path: CANONICAL_EXPORT_PATH,
      body: contract.body,
      contextToken: contract.contextToken,
      requestId: req.requestId,
    });
    for (const [name, value] of Object.entries(response.headers || {})) {
      res.setHeader(name, value);
    }
    if (Buffer.isBuffer(response.data)) {
      return res.status(response.status).send(response.data);
    }
    return res.status(response.status).json(response.data == null ? {} : response.data);
  } catch (err) {
    console.error("[export] Export error:", err);
    const status = Number(err.statusCode);
    return res.status(status >= 400 && status <= 599 ? status : 502).json({
      error: "Canonical MISA template export failed.",
      code: err.code || "MISA_TEMPLATE_EXPORT_FAILED",
      detail: err.message,
    });
  }
}

module.exports = { convertExcel, exportExcel, legacyExportMigrationGate };
