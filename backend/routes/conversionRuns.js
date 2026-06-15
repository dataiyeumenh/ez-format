const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const {
  createConversionRun,
  updateConversionRunStatus,
} = require("../controllers/conversionRunController");

router.use(requireDb, protect);

router.post("/", createConversionRun);
router.patch("/:id/status", updateConversionRunStatus);

module.exports = router;
