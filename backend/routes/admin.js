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

router.use(protect, adminOnly);

router.route("/users").get(getUsers).post(createUser);
router.route("/users/:id").put(updateUser).delete(deleteUser);
router.get("/revenue", getRevenue);

module.exports = router;
