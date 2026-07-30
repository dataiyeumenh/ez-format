/**
 * convert.js (route)
 * Legacy Node preview conversion — superseded by converter/ (Python).
 * Browser conversion/export traffic uses /api/converter/*.
 */

const express = require("express");
const multer = require("multer");
const requireDb = require("../middleware/requireDb");
const { protect } = require("../middleware/auth");
const {
  convertExcel,
  exportExcel,
  legacyExportMigrationGate,
} = require("../controllers/convertController");
const { isConverterGatewayUsageReady } = require("../services/converterGatewayService");

const router = express.Router();

// Store uploaded file in memory (accessible as req.file.buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
      "application/vnd.ms-excel", // .xls
      "application/octet-stream", // generic binary
    ];
    const ext = file.originalname.split(".").pop().toLowerCase();
    if (allowed.includes(file.mimetype) || ["xlsx", "xls"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Chỉ chấp nhận tệp Excel (.xlsx, .xls)"));
    }
  },
});

/**
 * POST /api/convert
 * Single file upload → JSON preview data
 */
router.post("/", upload.single("file"), convertExcel);

/**
 * POST /api/convert/export
 * Complete legacy bindings are authenticated, then bridged to canonical export.
 * Rows-only requests receive a migration response before DB/auth middleware.
 */
if (isConverterGatewayUsageReady()) {
  router.post(
    "/export",
    legacyExportMigrationGate,
    requireDb,
    protect,
    exportExcel,
  );
}

module.exports = router;
