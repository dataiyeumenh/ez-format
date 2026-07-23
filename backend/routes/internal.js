const express = require("express");
const {
  findInternalMappingProfile,
  getInternalMappingProfile,
  getInternalMasterDataContext,
  markInternalMappingProfileUsed,
  saveInternalMappingProfile,
  validateInternalMasterDataContext,
} = require("../controllers/accountingWorkspaceController");

const router = express.Router();
const {
  checkInternalReconstructionProfile,
  findInternalReconstructionProfile,
  recordInternalReconstructionEvent,
} = require("../controllers/reconstructionController");
const {
  checkStudentSessionActive,
  getInternalStudentActivities,
  recordStudentAttempt,
  recordStudentActivity,
  recordStudentAnalysisCompleted,
  recordStudentHint,
  recordStudentQuestionEvent,
} = require("../controllers/studentSessionController");
router.get("/master-data/context/:snapshotSetHash", (req, res, next) => {
  Promise.resolve(getInternalMasterDataContext(req, res, next)).catch(next);
});
router.get("/master-data/context-status/:snapshotSetHash", (req, res, next) => {
  Promise.resolve(validateInternalMasterDataContext(req, res, next)).catch(
    next,
  );
});
router.get("/mapping-profiles/by-signature", (req, res, next) => {
  Promise.resolve(findInternalMappingProfile(req, res, next)).catch(next);
});
router.get("/mapping-profiles/:profileId", (req, res, next) => {
  Promise.resolve(getInternalMappingProfile(req, res, next)).catch(next);
});
router.post("/mapping-profiles", (req, res, next) => {
  Promise.resolve(saveInternalMappingProfile(req, res, next)).catch(next);
});
router.post("/mapping-profiles/:profileId/used", (req, res, next) => {
  Promise.resolve(markInternalMappingProfileUsed(req, res, next)).catch(next);
});
router.get("/reconstruction-profiles/by-signature", (req, res, next) => {
  Promise.resolve(findInternalReconstructionProfile(req, res, next)).catch(
    next,
  );
});
router.get("/reconstruction-profiles/:profileId/current", (req, res, next) => {
  Promise.resolve(checkInternalReconstructionProfile(req, res, next)).catch(next);
});
router.post("/reconstructions/:id/events", (req, res, next) => {
  Promise.resolve(recordInternalReconstructionEvent(req, res, next)).catch(
    next,
  );
});
router.post("/student/sessions/:id/events", (req, res, next) => {
  Promise.resolve(recordStudentAnalysisCompleted(req, res, next)).catch(next);
});
router.post("/student/sessions/:id/questions", (req, res, next) => {
  Promise.resolve(recordStudentQuestionEvent(req, res, next)).catch(next);
});
router.post("/student/sessions/:id/attempts", (req, res, next) => {
  Promise.resolve(recordStudentAttempt(req, res, next)).catch(next);
});
router.post("/student/sessions/:id/attempts/:attemptId/hints", (req, res, next) => {
  Promise.resolve(recordStudentHint(req, res, next)).catch(next);
});
router.post("/student/sessions/:id/activities", (req, res, next) => {
  Promise.resolve(recordStudentActivity(req, res, next)).catch(next);
});
router.get("/student/sessions/:id/activities", (req, res, next) => {
  Promise.resolve(getInternalStudentActivities(req, res, next)).catch(next);
});
router.get("/student/sessions/:id/active", (req, res, next) => {
  Promise.resolve(checkStudentSessionActive(req, res, next)).catch(next);
});

module.exports = router;
