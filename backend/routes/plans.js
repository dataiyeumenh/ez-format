const express = require("express");
const requireDb = require("../middleware/requireDb");
const { getPublicPlans } = require("../controllers/planController");

const router = express.Router();

router.use(requireDb);
router.get("/", getPublicPlans);

module.exports = router;
