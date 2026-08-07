const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const {
  createConversionRun,
  updateConversionRunStatus,
  getUserConversionRuns,
} = require("../controllers/conversionRunController");

router.use(requireDb, protect);

router.get("/me", getUserConversionRuns);
router.post("/", createConversionRun);
router.patch("/:id/status", updateConversionRunStatus);

module.exports = router;
