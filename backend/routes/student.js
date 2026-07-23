const express = require("express");
const requireDb = require("../middleware/requireDb");
const { protect } = require("../middleware/auth");
const {
  createStudentSession,
  deleteStudentActivities,
  deleteStudentSession,
  getStudentActivities,
  getStudentAttempts,
  getStudentProgress,
  getStudentSession,
  refreshStudentContext,
} = require("../controllers/studentSessionController");

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

router.use(requireDb, protect);
router.post("/sessions", asyncRoute(createStudentSession));
router.get("/sessions/:id", asyncRoute(getStudentSession));
router.get("/sessions/:id/attempts", asyncRoute(getStudentAttempts));
router.get("/sessions/:id/activity", asyncRoute(getStudentActivities));
router.get("/progress", asyncRoute(getStudentProgress));
router.delete("/sessions/:id/activity", asyncRoute(deleteStudentActivities));
router.delete("/sessions/:id", asyncRoute(deleteStudentSession));
router.post("/sessions/:id/context", asyncRoute(refreshStudentContext));

module.exports = router;
