const User = require("../models/User");

// @desc    Get all users (admin only)
// @route   GET /api/admin/users
// @access  Private/Admin
const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.plan) filter.plan = req.query.plan;
    if (req.query.status === "Active") filter.isActive = true;
    if (req.query.status === "Banned") filter.isActive = false;

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      users,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Update user (plan, isActive)
// @route   PUT /api/admin/users/:id
// @access  Private/Admin
const updateUser = async (req, res) => {
  try {
    const { plan, isActive, name, email } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        ...(plan !== undefined && { plan }),
        ...(isActive !== undefined && { isActive }),
        ...(name && { name }),
        ...(email && { email }),
      },
      { new: true, runValidators: true },
    ).select("-password");

    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy người dùng" });

    res.json({ success: true, user });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Delete user
// @route   DELETE /api/admin/users/:id
// @access  Private/Admin
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy người dùng" });
    res.json({ success: true, message: "Đã xóa người dùng" });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

// @desc    Create user (admin)
// @route   POST /api/admin/users
// @access  Private/Admin
const createUser = async (req, res) => {
  try {
    const { name, email, password, plan, role } = req.body;
    const existing = await User.findOne({ email });
    if (existing)
      return res
        .status(400)
        .json({ success: false, message: "Email đã được sử dụng" });

    const user = await User.create({
      name,
      email,
      password: password || "123456",
      plan: plan || "Free",
      role: role || "user",
    });
    res
      .status(201)
      .json({
        success: true,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          plan: user.plan,
          role: user.role,
        },
      });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

module.exports = { getUsers, updateUser, deleteUser, createUser };
