const ConversionRun = require("../models/ConversionRun");
const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const MasterDataSnapshot = require("../models/MasterDataSnapshot");
const {
  buildSnapshotSetHash,
  userCanAccessWorkspace,
} = require("../services/masterDataService");
const {
  VALID_STATUSES,
  STALE_PROCESSING_MS,
  buildConversionRunFilter,
  serializeConversionRun,
} = require("../services/conversionRunService");
const {
  deductCreditForCompletedRun,
  hasConversionCredit,
} = require("../services/conversionCreditService");

// Quét các run "processing" quá 5 giờ -> chuyển sang "cancelled"
// (user upload nhưng không tải xuống nên không bao giờ completed).
async function cancelStaleProcessingRuns() {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  await ConversionRun.updateMany(
    { status: "processing", startedAt: { $lt: cutoff } },
    {
      $set: {
        status: "cancelled",
        completedAt: new Date(),
        errorMessage: "Tự động hủy: quá 5 giờ chưa tải file MISA.",
      },
    },
  );
}

function cleanFileName(fileName) {
  return String(fileName || "")
    .replace(/[\\/]/g, "")
    .trim()
    .slice(0, 255);
}

async function createConversionRun(req, res) {
  try {
    const fileName = cleanFileName(req.body.fileName);
    const fileSizeBytes = Number(req.body.fileSizeBytes || 0);

    if (!fileName) {
      return res.status(400).json({ success: false, message: "Tên file là bắt buộc" });
    }
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 0) {
      return res.status(400).json({ success: false, message: "Kích thước file không hợp lệ" });
    }
    if (!hasConversionCredit(req.user)) {
      return res.status(402).json({
        success: false,
        message: "Bạn đã hết lượt chuyển đổi. Vui lòng mua thêm lượt hoặc nâng cấp gói.",
      });
    }

    let workspace = null;
    let snapshotSetHash = "";
    if (req.body.workspaceId) {
      if (!mongoose.isValidObjectId(req.body.workspaceId)) {
        return res.status(400).json({
          success: false,
          message: "Hồ sơ doanh nghiệp không hợp lệ",
        });
      }
      workspace = await AccountingWorkspace.findOne({
        _id: req.body.workspaceId,
        isActive: true,
      });
      if (!workspace || !userCanAccessWorkspace(workspace, req.user._id)) {
        return res.status(403).json({
          success: false,
          message: "Không có quyền sử dụng hồ sơ doanh nghiệp này",
        });
      }
      const activeSnapshotIds = (workspace.activeSnapshots || []).map(
        (item) => item.snapshot,
      );
      const activeSnapshots = await MasterDataSnapshot.find({
        _id: { $in: activeSnapshotIds },
        workspace: workspace._id,
        status: "active",
      });
      snapshotSetHash = buildSnapshotSetHash(activeSnapshots);
    }

    const run = await ConversionRun.create({
      user: req.user._id,
      userNameSnapshot: req.user.name || "",
      userEmailSnapshot: req.user.email || "",
      fileName,
      fileSizeBytes,
      outputFormat: "MISA",
      status: "processing",
      targetTemplateId: req.body.targetTemplateId || "",
      workspace: workspace?._id || null,
      workspaceNameSnapshot: workspace?.name || "",
      snapshotSetHash,
      startedAt: new Date(),
    });

    res.status(201).json({ success: true, run: serializeConversionRun(run) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
}

async function updateConversionRunStatus(req, res) {
  try {
    const { status, errorMessage, converterUploadId, targetTemplateId } = req.body;
    if (!VALID_STATUSES.has(String(status))) {
      return res.status(400).json({ success: false, message: "Trạng thái không hợp lệ" });
    }

    const run = await ConversionRun.findById(req.params.id);
    if (!run) {
      return res.status(404).json({ success: false, message: "Không tìm thấy lịch sử chuyển đổi" });
    }
    const isOwner = String(run.user) === String(req.user._id);
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "Không có quyền cập nhật lịch sử này" });
    }

    const wasCompleted = run.status === "completed";
    run.status = String(status);
    if (converterUploadId !== undefined) run.converterUploadId = String(converterUploadId || "");
    if (targetTemplateId !== undefined) run.targetTemplateId = String(targetTemplateId || "");
    if (errorMessage !== undefined) run.errorMessage = String(errorMessage || "").slice(0, 1000);
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      run.completedAt = new Date();
    }

    await run.save();

    // Chỉ trừ lượt khi run chuyển sang "completed" lần đầu (tránh trừ lặp).
    if (run.status === "completed" && !wasCompleted) {
      await deductCreditForCompletedRun(run.user);
    }

    await run.populate("user", "name email");

    res.json({ success: true, run: serializeConversionRun(run) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
}

async function getAdminConversionRuns(req, res) {
  try {
    await cancelStaleProcessingRuns();

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = buildConversionRunFilter(req.query);
    const statsFilter = buildConversionRunFilter({
      from: req.query.from,
      to: req.query.to,
    });

    const [total, runs, totalAll, completed, failed, processing, cancelled] =
      await Promise.all([
        ConversionRun.countDocuments(filter),
        ConversionRun.find(filter)
          .populate("user", "name email")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        ConversionRun.countDocuments(statsFilter),
        ConversionRun.countDocuments({ ...statsFilter, status: "completed" }),
        ConversionRun.countDocuments({ ...statsFilter, status: "failed" }),
        ConversionRun.countDocuments({ ...statsFilter, status: "processing" }),
        ConversionRun.countDocuments({ ...statsFilter, status: "cancelled" }),
      ]);

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      stats: {
        total: totalAll,
        completed,
        failed,
        processing,
        cancelled,
      },
      runs: runs.map(serializeConversionRun),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi server", error: error.message });
  }
}

module.exports = {
  createConversionRun,
  updateConversionRunStatus,
  getAdminConversionRuns,
};
