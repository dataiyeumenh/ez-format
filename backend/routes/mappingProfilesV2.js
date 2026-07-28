const express = require("express");
const requireDb = require("../middleware/requireDb");
const { protect } = require("../middleware/auth");
const {
  activateMappingProfile,
  confirmInternalMappingProfile,
  createMappingProfile,
  createMappingProfileVersion,
  getInternalMappingProfileV2,
  getMappingProfileHistory,
  listMappingProfiles,
  matchInternalMappingProfile,
  matchMappingProfile,
  recordInternalConfirmedExport,
  quarantineInternalMappingProfileV2,
  suspendMappingProfile,
} = require("../controllers/mappingProfileV2Controller");

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const router = express.Router();
router.use(requireDb, protect);
router.post("/match", asyncRoute(matchMappingProfile));
router.post("/", asyncRoute(createMappingProfile));
router.post("/:id/versions", asyncRoute(createMappingProfileVersion));
router.post("/:id/activate", asyncRoute(activateMappingProfile));
router.post("/:id/suspend", asyncRoute(suspendMappingProfile));
router.get("/", asyncRoute(listMappingProfiles));
router.get("/:id/history", asyncRoute(getMappingProfileHistory));

const internalRouter = express.Router();
internalRouter.post("/match", asyncRoute(matchInternalMappingProfile));
internalRouter.post("/confirm", asyncRoute(confirmInternalMappingProfile));
internalRouter.get("/:id", asyncRoute(getInternalMappingProfileV2));
internalRouter.post(
  "/:id/quarantine",
  asyncRoute(quarantineInternalMappingProfileV2),
);
internalRouter.post(
  "/:id/confirmed-export",
  asyncRoute(recordInternalConfirmedExport),
);

module.exports = router;
module.exports.internalRouter = internalRouter;
