const User = require("../models/User");
const Payment = require("../models/Payment");
const Plan = require("../models/Plan");
const { syncPaymentStatusFromPayOS } = require("../services/paymentStatusSync");
const {
  applyAdminPlanToUser,
  normalizeSubscriptionState,
} = require("../services/subscriptionService");
const { findActivePlanByCodeOrId, getDefaultFreePlan } = require("../services/planService");

// @desc    Get all users (admin only)
// @route   GET /api/admin/users
// @access  Private/Admin
const getUsers = async (req, res) => {
  try {
    await User.updateMany(
      {
        planExpiresAt: { $ne: null, $lte: new Date() },
      },
      { $set: { plan: null, planStartedAt: null, planExpiresAt: null } },
    );

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.plan) {
      const planQuery = req.query.plan.match(/^[0-9a-fA-F]{24}$/)
        ? { _id: req.query.plan }
        : { code: req.query.plan };
      const plan = await Plan.findOne(planQuery);
      if (plan) filter.plan = plan._id;
    }
    if (req.query.status === "Active") filter.isActive = true;
    if (req.query.status === "Banned") filter.isActive = false;

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("-password")
      .populate("plan")
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
    const { plan, isActive, name, email, fileCredits } = req.body;
    const user = await User.findById(req.params.id);

    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy người dùng" });

    if (String(user._id) === String(req.user._id) || user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin không thể chỉnh sửa tài khoản admin hoặc chính mình",
      });
    }

    if (plan !== undefined) {
      const nextPlan = await findActivePlanByCodeOrId(plan);
      if (!nextPlan) {
        return res.status(400).json({ success: false, message: "Gói dịch vụ không hợp lệ" });
      }
      applyAdminPlanToUser(user, nextPlan);
    }
    if (fileCredits !== undefined) {
      const nextCredits = Number(fileCredits);
      if (!Number.isInteger(nextCredits) || nextCredits < 0) {
        return res.status(400).json({
          success: false,
          message: "Số lượt chuyển đổi phải là số nguyên không âm",
        });
      }
      user.fileCredits = nextCredits;
    }
    if (isActive !== undefined) user.isActive = isActive;
    if (name) user.name = name;
    if (email) user.email = email;
    normalizeSubscriptionState(user);
    if (!user.plan) user.plan = (await getDefaultFreePlan())._id;
    await user.save();
    await user.populate("plan");

    res.json({ success: true, user });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy người dùng" });

    if (String(user._id) === String(req.user._id) || user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin không thể khoá tài khoản admin hoặc chính mình",
      });
    }

    user.isActive = false;
    await user.save();

    res.json({ success: true, message: "Đã khoá người dùng", user });
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

    const user = new User({
      name,
      email,
      password: password || "123456",
      role: role || "user",
    });
    const nextPlan = plan ? await findActivePlanByCodeOrId(plan) : await getDefaultFreePlan();
    applyAdminPlanToUser(user, nextPlan || (await getDefaultFreePlan()));
    normalizeSubscriptionState(user);
    if (!user.plan) user.plan = (await getDefaultFreePlan())._id;
    await user.save();
    await user.populate("plan");
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

const RANGE_DAYS = {
  today: 1,
  "7d": 7,
  "30d": 30,
};

const PLAN_LABELS = {
  monthly: "Gói tháng",
  yearly: "Gói năm",
  perfile: "Theo lượt",
};

function startOfDay(date) {
  const output = new Date(date);
  output.setHours(0, 0, 0, 0);
  return output;
}

function addDays(date, days) {
  const output = new Date(date);
  output.setDate(output.getDate() + days);
  return output;
}

function formatDateKey(date) {
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function formatPayment(payment) {
  const user = payment.user || {};
  return {
    id: payment._id,
    orderCode: payment.orderCode,
    paymentLinkId: payment.paymentLinkId,
    planCode: payment.planCode,
    planName: payment.planName || PLAN_LABELS[payment.planCode] || payment.planCode,
    planType: payment.planCode,
    amount: payment.amount,
    originalAmount:
      payment.originalAmount !== null && payment.originalAmount !== undefined
        ? payment.originalAmount
        : payment.amount,
    discountAmount: Number(payment.discountAmount || 0),
    couponCode: payment.couponCode || "",
    couponApplied: Boolean(payment.couponApplied),
    status: payment.status,
    checkoutUrl: payment.checkoutUrl,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    user: {
      id: user._id,
      name: user.name || "Không rõ",
      email: user.email || "",
      plan: user.plan || "",
    },
  };
}

async function syncPendingPayments(payments, limit = 25) {
  const uniquePendingPayments = Array.from(
    new Map(
      payments
        .filter((payment) => payment.status === "pending")
        .map((payment) => [String(payment._id), payment]),
    ).values(),
  )
    .slice(0, limit);

  const syncedPayments = await Promise.all(
    uniquePendingPayments.map((payment) =>
      syncPaymentStatusFromPayOS(payment).catch(() => payment),
    ),
  );
  const syncedById = new Map(
    syncedPayments.map((payment) => [
      String(payment._id),
      {
        status: payment.status,
        paidAt: payment.paidAt,
        payosData: payment.payosData,
        updatedAt: payment.updatedAt,
      },
    ]),
  );

  for (const payment of payments) {
    const synced = syncedById.get(String(payment._id));
    if (synced) {
      payment.status = synced.status;
      payment.paidAt = synced.paidAt;
      payment.payosData = synced.payosData;
      payment.updatedAt = synced.updatedAt;
    }
  }
}

// @desc    Revenue analytics from Payment collection
// @route   GET /api/admin/revenue
// @access  Private/Admin
const getRevenue = async (req, res) => {
  try {
    const range = req.query.range || "30d";
    const days = RANGE_DAYS[range] || RANGE_DAYS["30d"];
    const now = new Date();
    const currentStart = startOfDay(addDays(now, -(days - 1)));
    const previousStart = startOfDay(addDays(currentStart, -days));
    const currentEnd = addDays(startOfDay(now), 1);

    const [currentPayments, previousPayments, recentPayments] = await Promise.all([
      Payment.find({
        createdAt: { $gte: currentStart, $lt: currentEnd },
      })
        .populate("user", "name email plan")
        .sort({ createdAt: -1 }),
      Payment.find({
        createdAt: { $gte: previousStart, $lt: currentStart },
      }),
      Payment.find({})
        .populate("user", "name email plan")
        .sort({ createdAt: -1 })
        .limit(100),
    ]);

    await syncPendingPayments([...recentPayments, ...currentPayments]);

    const paidCurrent = currentPayments.filter((payment) => payment.status === "paid");
    const paidPrevious = previousPayments.filter((payment) => payment.status === "paid");
    const totalRevenue = paidCurrent.reduce((sum, payment) => sum + payment.amount, 0);
    const previousRevenue = paidPrevious.reduce((sum, payment) => sum + payment.amount, 0);
    const paidCount = paidCurrent.length;
    const arpu = paidCount ? Math.round(totalRevenue / paidCount) : 0;
    const monthlyRevenue = paidCurrent
      .filter((payment) => payment.planCode === "monthly")
      .reduce((sum, payment) => sum + payment.amount, 0);

    const chart = Array.from({ length: days }, (_, index) => {
      const day = addDays(currentStart, index);
      const previousDay = addDays(previousStart, index);
      const nextDay = addDays(day, 1);
      const previousNextDay = addDays(previousDay, 1);

      const current = paidCurrent
        .filter((payment) => payment.createdAt >= day && payment.createdAt < nextDay)
        .reduce((sum, payment) => sum + payment.amount, 0);
      const previous = paidPrevious
        .filter(
          (payment) =>
            payment.createdAt >= previousDay && payment.createdAt < previousNextDay,
        )
        .reduce((sum, payment) => sum + payment.amount, 0);

      return {
        date: formatDateKey(day),
        current,
        previous,
      };
    });

    const planRevenue = Object.entries(PLAN_LABELS).map(([planType, label]) => {
      const amount = paidCurrent
        .filter((payment) => payment.planCode === planType)
        .reduce((sum, payment) => sum + payment.amount, 0);
      return {
        planType,
        name: label,
        amount,
        pct: totalRevenue ? Math.round((amount / totalRevenue) * 100) : 0,
      };
    });

    res.json({
      success: true,
      range,
      stats: {
        totalRevenue,
        previousRevenue,
        revenueChangePct:
          previousRevenue > 0
            ? Math.round(((totalRevenue - previousRevenue) / previousRevenue) * 100)
            : totalRevenue > 0
              ? 100
              : 0,
        monthlyRevenue,
        arpu,
        paidCount,
        pendingCount: currentPayments.filter((payment) => payment.status === "pending")
          .length,
      },
      chart,
      planRevenue,
      transactions: recentPayments.map(formatPayment),
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Lỗi server", error: error.message });
  }
};

module.exports = {
  getUsers,
  updateUser,
  deleteUser,
  createUser,
  getRevenue,
};
