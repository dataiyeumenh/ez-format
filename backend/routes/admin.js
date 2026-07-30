const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/auth");
const requireDb = require("../middleware/requireDb");
const {
  renderMisaImportRepairPrometheusMetrics,
} = require("../services/misaImportRepairService");

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
  deletePlan,
} = require("../controllers/planController");
const {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  listCouponPlanOptions,
} = require("../controllers/couponController");

router.use(protect, adminOnly);

router.route("/users").get(getUsers).post(createUser);
router.route("/users/:id").put(updateUser).delete(deleteUser);
router.route("/plans").get(getAdminPlans).post(createPlan);
router.route("/plans/:id").put(updatePlan).delete(deletePlan);
router.get("/coupon-plan-options", listCouponPlanOptions);
router.route("/coupons").get(listCoupons).post(createCoupon);
router.route("/coupons/:id").get(getCoupon).put(updateCoupon).delete(deleteCoupon);
router.get("/revenue", getRevenue);
router.get("/conversion-runs", getAdminConversionRuns);
router.get("/feedback", getAdminFeedback);
router.get("/dashboard", getDashboard);
router.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8");
  return res.send(renderMisaImportRepairPrometheusMetrics());
});

module.exports = router;
