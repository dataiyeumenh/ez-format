const express = require("express");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const { createConversionContextToken } = require("../services/conversionContextService");

const router = express.Router();

router.post("/", requireDb, protect, (req, res) => {
  const userId = String(req.user?._id || "").trim();
  const runId = String(req.body?.conversion_run_id || "").trim();
  const uploadId = String(req.body?.upload_id || "").trim();
  const targetTemplateId = String(req.body?.target_template_id || "").trim();
  if (!userId || !runId || !uploadId || !targetTemplateId) return res.status(400).json({ message: "Conversion binding is required" });
  return res.json({ context_token: createConversionContextToken({ userId, workspaceId: null, conversionRunId: runId, uploadId, targetTemplateId, scopes: ["analyze", "preview", "readiness", "confirm", "export"] }) });
});

module.exports = router;
