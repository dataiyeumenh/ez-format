const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");

router.use(requireDb);
const {
  getUsers,
  updateUser,
  deleteUser,
  createUser,
  getRevenue,
} = require("../controllers/adminController");
const { getAdminConversionRuns } = require("../controllers/conversionRunController");
const { getAdminFeedback } = require("../controllers/feedbackController");
const { getDashboard } = require("../controllers/dashboardController");
const {
  getAdminPlans,
  createPlan,
  updatePlan,
} = require("../controllers/planController");
const {
  createCoupon,
  listCoupons,
  updateCoupon,
  updateCouponStatus,
} = require("../controllers/couponController");

router.use(protect, adminOnly);

router.route("/users").get(getUsers).post(createUser);
router.route("/users/:id").put(updateUser).delete(deleteUser);
router.route("/plans").get(getAdminPlans).post(createPlan);
router.route("/plans/:id").put(updatePlan);
router.route("/coupons").get(listCoupons).post(createCoupon);
router.route("/coupons/:id").put(updateCoupon);
router.patch("/coupons/:id/status", updateCouponStatus);
router.get("/revenue", getRevenue);
router.get("/conversion-runs", getAdminConversionRuns);
router.get("/feedback", getAdminFeedback);
router.get("/dashboard", getDashboard);

module.exports = router;
