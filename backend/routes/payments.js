const express = require("express");
const {
  createPayment,
  previewCoupon,
  getPayment,
  handlePayOSWebhook,
  syncPayment,
} = require("../controllers/paymentController");
const { protect } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");

const router = express.Router();

router.use(requireDb);

router.post("/payos-webhook", handlePayOSWebhook);

router.post("/preview-coupon", protect, previewCoupon);
router.post("/create", protect, createPayment);
router.post("/:orderCode/sync", syncPayment);
router.get("/:orderCode", protect, getPayment);

module.exports = router;
