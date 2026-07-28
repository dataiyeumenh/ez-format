const express = require("express");
const requireDb = require("../middleware/requireDb");
const { protect } = require("../middleware/auth");
const {
  createStudentSession,
  deleteStudentActivities,
  deleteStudentSession,
  getStudentActivities,
  getStudentSession,
  refreshStudentContext,
} = require("../controllers/studentSessionController");
const {
  analyzeStudentSession,
  proxyStudentOperation,
} = require("../controllers/converterGatewayController");
const { converterRateLimit } = require("../middleware/converterRateLimit");
const {
  boundedExcelUpload,
  isConverterGatewayUsageReady,
} = require("./converterGateway");

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

router.use(requireDb, protect);
router.post("/sessions", asyncRoute(createStudentSession));
router.get("/sessions/:id", asyncRoute(getStudentSession));
router.get("/sessions/:id/activity", asyncRoute(getStudentActivities));
router.delete("/sessions/:id/activity", asyncRoute(deleteStudentActivities));
router.delete("/sessions/:id", asyncRoute(deleteStudentSession));
router.post("/sessions/:id/context", asyncRoute(refreshStudentContext));
if (isConverterGatewayUsageReady()) {
  router.post(
    "/sessions/:id/analyze",
    converterRateLimit("analyze"),
    boundedExcelUpload,
    asyncRoute(analyzeStudentSession),
  );
  router.post(
    "/sessions/:id/operations/anonymization/export",
    converterRateLimit("export"),
    asyncRoute(proxyStudentOperation),
  );
  router.post(
    "/sessions/:id/operations/internship-report",
    converterRateLimit("export"),
    asyncRoute(proxyStudentOperation),
  );
  router.post(
    "/sessions/:id/operations/*",
    converterRateLimit("json"),
    asyncRoute(proxyStudentOperation),
  );
}

module.exports = router;
