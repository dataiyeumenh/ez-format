const Plan = require("../models/Plan");
const User = require("../models/User");
const {
  normalizePlanPayload,
  serializePlan,
  seedDefaultPlans,
} = require("../services/planService");

async function getPublicPlans(req, res) {
  try {
    await seedDefaultPlans();
    const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
    res.json({ success: true, plans: plans.map(serializePlan) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Không thể tải gói dịch vụ", error: error.message });
  }
}

async function getAdminPlans(req, res) {
  try {
    await seedDefaultPlans();
    const plans = await Plan.find({}).sort({ sortOrder: 1, createdAt: 1 });
    const usersByPlan = await User.aggregate([
      { $match: { plan: { $ne: null } } },
      { $group: { _id: "$plan", count: { $sum: 1 } } },
    ]);
    const countByPlan = new Map(usersByPlan.map((row) => [String(row._id), row.count]));

    res.json({
      success: true,
      plans: plans.map((plan) => ({
        ...serializePlan(plan),
        activeUsers: countByPlan.get(String(plan._id)) || 0,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Không thể tải gói dịch vụ", error: error.message });
  }
}

async function createPlan(req, res) {
  try {
    const payload = normalizePlanPayload(req.body);
    const plan = await Plan.create(payload);
    if (plan.isPopular) {
      await Plan.updateMany({ _id: { $ne: plan._id } }, { $set: { isPopular: false } });
    }
    res.status(201).json({ success: true, plan: serializePlan(plan) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || "Không thể tạo gói" });
  }
}

async function updatePlan(req, res) {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) {
      return res.status(404).json({ success: false, message: "Không tìm thấy gói" });
    }

    const payload = normalizePlanPayload(req.body, { partial: true });
    delete payload.code;
    Object.assign(plan, payload);
    await plan.save();
    if (plan.isPopular) {
      await Plan.updateMany({ _id: { $ne: plan._id } }, { $set: { isPopular: false } });
    }

    return res.json({ success: true, plan: serializePlan(plan) });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || "Không thể cập nhật gói" });
  }
}


async function deletePlan(req, res) {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) {
      return res.status(404).json({ success: false, message: "Không tìm thấy gói" });
    }

    if (String(plan.code || "").toLowerCase() === "free") {
      return res.status(400).json({
        success: false,
        message: "Không thể xoá gói miễn phí mặc định của hệ thống.",
      });
    }

    const activeUsers = await User.countDocuments({ plan: plan._id });
    if (activeUsers > 0) {
      return res.status(400).json({
        success: false,
        message: `Không thể xoá gói đang có ${activeUsers} người dùng. Hãy chuyển họ sang gói khác hoặc đặt gói về Inactive.`,
      });
    }

    await plan.deleteOne();
    return res.json({ success: true, message: "Đã xoá gói dịch vụ." });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Không thể xoá gói",
    });
  }
}

module.exports = {
  getPublicPlans,
  getAdminPlans,
  createPlan,
  updatePlan,
  deletePlan,
};
