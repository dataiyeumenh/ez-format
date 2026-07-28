const express = require("express");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const {
  activateReconstructionProfile,
  createReconstructionRun,
  getReconstructionRun,
  listReconstructionRuns,
  saveReconstructionProfile,
} = require("../controllers/reconstructionController");

const router = express.Router();
router.use(requireDb, protect);

const createBuckets = new Map();
function limitRunCreation(req, res, next) {
  const windowMs = 15 * 60 * 1000;
  const limit = Math.max(
    1,
    Number(process.env.RECONSTRUCTION_CREATE_LIMIT_PER_15_MINUTES || 20),
  );
  const key = String(req.user?._id || req.ip || "anonymous");
  const now = Date.now();
  const bucket = createBuckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    createBuckets.set(key, { count: 1, expiresAt: now + windowMs });
    return next();
  }
  if (bucket.count >= limit) {
    return res.status(429).json({
      success: false,
      message: "Bạn đã tạo quá nhiều phiên tái tạo. Vui lòng thử lại sau.",
    });
  }
  bucket.count += 1;
  return next();
}

router.get("/", listReconstructionRuns);
router.post("/", limitRunCreation, createReconstructionRun);
router.get("/:id", getReconstructionRun);
router.post("/:id/profiles", saveReconstructionProfile);
router.post("/profiles/:profileId/activate", activateReconstructionProfile);

module.exports = router;
