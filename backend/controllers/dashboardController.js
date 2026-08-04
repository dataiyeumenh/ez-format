const User = require("../models/User");
const Payment = require("../models/Payment");
const ConversionRun = require("../models/ConversionRun");
const Plan = require("../models/Plan");
const WebsiteVisit = require("../models/WebsiteVisit");
const { serializeConversionRun } = require("../services/conversionRunService");
const {
  WEBSITE_LAUNCH_DATE,
  summarizeWebsiteVisits,
  toVietnamDateKey,
} = require("../services/websiteVisitService");
const {
  vnStartOfDay,
  vnStartOfMonth,
  vnStartOfPrevMonth,
  addDaysUtc,
  changePct,
  WEEKDAY_LABELS,
  vnParts,
} = require("../services/dashboardService");

// Palette màu cho biểu đồ phân bổ gói — gán theo thứ tự plan (deterministic).
const PLAN_COLORS = [
  "#3B82F6",
  "#8B5CF6",
  "#6366F1",
  "#1E40AF",
  "#0EA5E9",
  "#14B8A6",
  "#F59E0B",
  "#EC4899",
  "#10B981",
  "#64748B",
];

async function sumPaid(match) {
  const agg = await Payment.aggregate([
    { $match: { status: "paid", ...match } },
    { $group: { _id: null, sum: { $sum: "$amount" } } },
  ]);
  return agg[0]?.sum || 0;
}

// @desc    Số liệu tổng quan cho admin dashboard
// @route   GET /api/admin/dashboard
// @access  Private/Admin
async function getDashboard(req, res) {
  try {
    const now = new Date();
    const todayStart = vnStartOfDay(now);
    const tomorrowStart = addDaysUtc(todayStart, 1);
    const yesterdayStart = addDaysUtc(todayStart, -1);
    const monthStart = vnStartOfMonth(now);
    const prevMonthStart = vnStartOfPrevMonth(now);
    const sevenDaysAgoStart = addDaysUtc(todayStart, -6); // 7 ngày gồm hôm nay
    const fourWeeksAgoStart = addDaysUtc(todayStart, -27); // 28 ngày = 4 tuần
    const todayDateKey = toVietnamDateKey(now);

    const [
      totalUsers,
      activeUsers,
      newUsersThisMonth,
      newUsersPrevMonth,
      activeNewThisMonth,
      activeNewPrevMonth,
      filesToday,
      filesYesterday,
      monthlyRevenue,
      prevMonthlyRevenue,
      websiteVisitRows,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ isActive: true }),
      User.countDocuments({ createdAt: { $gte: monthStart } }),
      User.countDocuments({ createdAt: { $gte: prevMonthStart, $lt: monthStart } }),
      User.countDocuments({ isActive: true, createdAt: { $gte: monthStart } }),
      User.countDocuments({
        isActive: true,
        createdAt: { $gte: prevMonthStart, $lt: monthStart },
      }),
      ConversionRun.countDocuments({ createdAt: { $gte: todayStart, $lt: tomorrowStart } }),
      ConversionRun.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: todayStart } }),
      sumPaid({ paidAt: { $gte: monthStart } }),
      sumPaid({ paidAt: { $gte: prevMonthStart, $lt: monthStart } }),
      WebsiteVisit.find({
        dateKey: { $gte: WEBSITE_LAUNCH_DATE, $lte: todayDateKey },
      })
        .select("dateKey count -_id")
        .sort({ dateKey: 1 })
        .lean(),
    ]);

    const websiteVisits = summarizeWebsiteVisits({
      todayDateKey,
      rows: websiteVisitRows,
    });

    // Chuyển đổi theo ngày (7 ngày gần nhất)
    const dayRuns = await ConversionRun.find({
      createdAt: { $gte: sevenDaysAgoStart, $lt: tomorrowStart },
    }).select("createdAt");
    const conversionsByDay = [];
    for (let i = 6; i >= 0; i--) {
      const start = addDaysUtc(todayStart, -i);
      const end = addDaysUtc(start, 1);
      const value = dayRuns.filter((r) => r.createdAt >= start && r.createdAt < end).length;
      conversionsByDay.push({ day: WEEKDAY_LABELS[vnParts(start).weekday], value });
    }

    // Doanh thu theo tuần (4 tuần gần nhất)
    const weekPayments = await Payment.find({
      status: "paid",
      paidAt: { $gte: fourWeeksAgoStart, $lt: tomorrowStart },
    }).select("amount paidAt");
    const revenueByWeek = [];
    for (let w = 0; w < 4; w++) {
      const start = addDaysUtc(fourWeeksAgoStart, w * 7);
      const end = addDaysUtc(start, 7);
      const value = weekPayments
        .filter((p) => p.paidAt >= start && p.paidAt < end)
        .reduce((sum, p) => sum + (p.amount || 0), 0);
      revenueByWeek.push({ week: `Tuần ${w + 1}`, value });
    }

    // Phân bổ gói (user đang hoạt động) — data-driven theo mọi plan trong DB.
    const plans = await Plan.find({}).sort({ sortOrder: 1, name: 1 });
    const planAgg = await User.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$plan", count: { $sum: 1 } } },
    ]);
    const countById = new Map();
    let nullPlanCount = 0; // user plan = null -> gói miễn phí
    let totalActiveGrouped = 0;
    planAgg.forEach(({ _id, count }) => {
      totalActiveGrouped += count;
      if (_id) countById.set(String(_id), count);
      else nullPlanCount += count;
    });

    // Gộp user plan=null vào plan free (nếu tồn tại).
    const freePlan = plans.find((p) => p.code === "free");
    if (freePlan) {
      const id = String(freePlan._id);
      countById.set(id, (countById.get(id) || 0) + nullPlanCount);
      nullPlanCount = 0;
    }

    const planDistribution = plans.map((p, index) => ({
      code: p.code,
      name: p.name,
      color: PLAN_COLORS[index % PLAN_COLORS.length],
      value: countById.get(String(p._id)) || 0,
      isActive: p.isActive,
    }));

    // User chưa gắn plan (không có gói free) hoặc gắn plan đã bị xóa -> bucket riêng.
    const attributed = planDistribution.reduce((sum, item) => sum + item.value, 0);
    const leftover = totalActiveGrouped - attributed + nullPlanCount;
    if (leftover > 0) {
      planDistribution.push({
        code: "__other__",
        name: "Khác",
        color: PLAN_COLORS[planDistribution.length % PLAN_COLORS.length],
        value: leftover,
        isActive: true,
      });
    }

    // Chuyển đổi gần đây
    const recent = await ConversionRun.find({})
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .limit(5);
    const recentConversions = recent.map(serializeConversionRun);

    // User mới hôm nay
    const newUsersTodayDocs = await User.find({
      createdAt: { $gte: todayStart, $lt: tomorrowStart },
    })
      .populate("plan", "code name")
      .sort({ createdAt: -1 })
      .limit(5);
    const newUsersTodayCount = await User.countDocuments({
      createdAt: { $gte: todayStart, $lt: tomorrowStart },
    });
    const newUsersToday = newUsersTodayDocs.map((u) => ({
      name: u.name,
      email: u.email,
      planCode: u.plan?.code || "free",
      planName: u.plan?.name || "Miễn phí",
    }));

    res.json({
      success: true,
      stats: {
        totalUsers: {
          value: totalUsers,
          changePct: changePct(newUsersThisMonth, newUsersPrevMonth),
        },
        activeUsers: {
          value: activeUsers,
          changePct: changePct(activeNewThisMonth, activeNewPrevMonth),
        },
        filesToday: {
          value: filesToday,
          changePct: changePct(filesToday, filesYesterday),
        },
        monthlyRevenue: {
          value: monthlyRevenue,
          changePct: changePct(monthlyRevenue, prevMonthlyRevenue),
        },
        visitsToday: {
          value: websiteVisits.visitsToday,
          changePct: changePct(
            websiteVisits.visitsToday,
            websiteVisits.visitsYesterday,
          ),
        },
      },
      activeTotal: activeUsers,
      conversionsByDay,
      revenueByWeek,
      planDistribution,
      recentConversions,
      newUsersToday,
      newUsersTodayCount,
      totalVisits: websiteVisits.totalVisits,
      visitsByDay: websiteVisits.visitsByDay,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
}

module.exports = { getDashboard };
