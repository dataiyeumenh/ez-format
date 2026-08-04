const express = require("express");
const { createWebsiteVisit } = require("../controllers/analyticsController");
const requireDb = require("../middleware/requireDb");

const router = express.Router();

router.post("/visit", requireDb, createWebsiteVisit);

module.exports = router;
