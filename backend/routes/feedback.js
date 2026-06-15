const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const { createFeedback } = require("../controllers/feedbackController");

router.use(requireDb, protect);

router.post("/", createFeedback);

module.exports = router;
