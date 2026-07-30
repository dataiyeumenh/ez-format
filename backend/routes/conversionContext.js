const express = require("express");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const {
  issueConversionContextForRun,
} = require("../services/conversionContextBindingService");

const router = express.Router();

router.post("/", requireDb, protect, async (req, res, next) => {
  const userId = String(req.user?._id || "").trim();
  const runId = String(req.body?.conversion_run_id || "").trim();
  if (!userId || !runId) {
    return res.status(400).json({ message: "Conversion run binding is required" });
  }
  try {
    const context = await issueConversionContextForRun({
      conversionRunId: runId,
      userId,
    });
    if (!context) {
      return res.status(404).json({ message: "Conversion run not found" });
    }
    return res.json({
      contextToken: context.contextToken,
      conversionRunId: context.conversionRunId,
      operationSessionId: context.operationSessionId,
      uploadId: context.uploadId,
      targetTemplateId: context.targetTemplateId,
      snapshotSetHash: context.snapshotSetHash,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    return next(error);
  }
});

module.exports = router;
