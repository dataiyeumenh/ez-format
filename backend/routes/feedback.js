const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const {
  createFeedback,
  getMyFeedback,
  rateFeedback,
} = require("../controllers/feedbackController");

router.use(protect, requireDb);

router.get("/mine", getMyFeedback);
router.post("/", createFeedback);
router.patch("/:id/rating", rateFeedback);

module.exports = router;
