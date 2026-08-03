const express = require("express");
const {
  listNotices,
  markNoticesRead,
} = require("../controllers/noticeController");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");

const router = express.Router();

router.get("/", protect, requireDb, listNotices);
router.post("/read", protect, requireDb, markNoticesRead);

module.exports = router;
