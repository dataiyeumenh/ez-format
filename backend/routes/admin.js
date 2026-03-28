const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/auth");
const {
  getUsers,
  updateUser,
  deleteUser,
  createUser,
} = require("../controllers/adminController");

router.use(protect, adminOnly);

router.route("/users").get(getUsers).post(createUser);
router.route("/users/:id").put(updateUser).delete(deleteUser);

module.exports = router;
