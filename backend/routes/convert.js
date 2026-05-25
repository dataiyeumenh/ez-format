/**
 * convert.js (route)
 * Defines the POST /api/convert endpoint.
 * Uses multer for in-memory file upload (no disk writes).
 */

const express = require("express");
const multer = require("multer");
const {
  convertExcel,
  exportExcel,
} = require("../controllers/convertController");

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
 * Accepts edited JSON rows → MISA Excel download
 */
router.post("/export", exportExcel);

module.exports = router;
