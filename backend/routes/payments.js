const express = require("express");
const {
  createPayment,
  getPayment,
  handlePayOSWebhook,
} = require("../controllers/paymentController");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");

const router = express.Router();

router.use(requireDb);

router.post("/payos-webhook", handlePayOSWebhook);

router.post("/create", protect, createPayment);
router.get("/:orderCode", protect, getPayment);

module.exports = router;
