const { recordWebsiteVisit } = require("../services/websiteVisitService");

async function createWebsiteVisit(req, res) {
  try {
    const visit = await recordWebsiteVisit();
    return res.status(201).json({ success: true, visit });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể ghi nhận lượt truy cập",
    });
  }
}

module.exports = { createWebsiteVisit };
