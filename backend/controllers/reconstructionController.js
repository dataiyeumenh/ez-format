const crypto = require("crypto");
const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const ConversionRun = require("../models/ConversionRun");
const MasterDataSnapshot = require("../models/MasterDataSnapshot");
const ReconstructionDecision = require("../models/ReconstructionDecision");
const ReconstructionProfile = require("../models/ReconstructionProfile");
const VoucherReconstructionRun = require("../models/VoucherReconstructionRun");
const {
  createReconstructionContextToken,
  verifyReconstructionContextToken,
} = require("../services/conversionContextService");
const {
  deductCreditForCompletedRun,
  hasConversionCredit,
} = require("../services/conversionCreditService");
const {
  buildSnapshotSetHash,
  userCanAccessWorkspace,
  userCanEditWorkspace,
} = require("../services/masterDataService");
const {
  cleanReconstructionProfilePayload,
  serializeReconstructionProfile,
} = require("../services/reconstructionProfileService");
const {
  cleanReconstructionRunPayload,
  nextRunStatus,
  serializeReconstructionRun,
} = require("../services/reconstructionRunService");

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendError(res, error) {
  const status = Number(error.statusCode) || 500;
  if (status >= 500) console.error("[reconstruction] Request failed:", error);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? "Không thể xử lý tái tạo chứng từ" : error.message,
    requestId: res.req?.requestId || "",
  });
}

function secureTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function authenticateInternalReconstruction(req, requiredScope = null) {
  const expected = String(process.env.CONVERTER_SERVICE_TOKEN || "").trim();
  if (!expected) throw httpError(503, "CONVERTER_SERVICE_TOKEN chưa được cấu hình");
  if (!secureTokenEquals(req.headers["x-converter-service-token"], expected)) {
    throw httpError(401, "Service token không hợp lệ");
  }
  const token = req.headers["x-reconstruction-context"];
  if (!token) throw httpError(401, "Thiếu reconstruction context");
  try {
    return verifyReconstructionContextToken(token, requiredScope);
  } catch (error) {
    throw httpError(401, error.message);
  }
}

function canReviewWorkspace(workspace, userId) {
  const candidate = String(userId);
  if (String(workspace.owner) === candidate) return true;
  return (workspace.members || []).some(
    (member) =>
      String(member.user) === candidate &&
      ["owner", "editor", "reviewer"].includes(member.role),
  );
}

async function workspaceContext(workspaceId, userId) {
  if (!workspaceId) {
    return {
      workspace: null,
      snapshots: [],
      snapshotSetHash: "",
      workspaceRevision: 0,
    };
  }
  if (!mongoose.isValidObjectId(workspaceId)) {
    throw httpError(400, "Hồ sơ doanh nghiệp không hợp lệ");
  }
  const workspace = await AccountingWorkspace.findOne({
    _id: workspaceId,
    isActive: true,
  });
  if (!workspace || !userCanAccessWorkspace(workspace, userId)) {
    throw httpError(403, "Không có quyền sử dụng hồ sơ doanh nghiệp này");
  }
  const activeSnapshotIds = (workspace.activeSnapshots || []).map(
    (item) => item.snapshot,
  );
  const snapshots = await MasterDataSnapshot.find({
    _id: { $in: activeSnapshotIds },
    workspace: workspace._id,
    status: "active",
  });
  return {
    workspace,
    snapshots,
    snapshotSetHash: buildSnapshotSetHash(snapshots),
    workspaceRevision: Number(workspace.masterDataRevision || 0),
  };
}

async function createReconstructionRun(req, res) {
  try {
    const payload = cleanReconstructionRunPayload(req.body);
    if (!payload.fileName) throw httpError(400, "Tên file là bắt buộc");
    if (!Number.isFinite(payload.fileSizeBytes) || payload.fileSizeBytes < 0) {
      throw httpError(400, "Kích thước file không hợp lệ");
    }
    if (!hasConversionCredit(req.user)) {
      throw httpError(
        402,
        "Bạn đã hết lượt chuyển đổi. Vui lòng mua thêm lượt hoặc nâng cấp gói.",
      );
    }
    const context = await workspaceContext(payload.workspaceId, req.user._id);
    const betaWorkspaceIds = String(
      process.env.RECONSTRUCTION_BETA_WORKSPACE_IDS || "",
    )
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (
      betaWorkspaceIds.length &&
      !betaWorkspaceIds.includes(String(context.workspace?._id || ""))
    ) {
      throw httpError(403, "Workspace này chưa được bật thử nghiệm tái tạo chứng từ");
    }
    const conversionRun = await ConversionRun.create({
      user: req.user._id,
      userNameSnapshot: req.user.name || "",
      userEmailSnapshot: req.user.email || "",
      fileName: payload.fileName,
      fileSizeBytes: payload.fileSizeBytes,
      outputFormat: "MISA",
      status: "processing",
      mode: "reconstruction",
      targetTemplateId: payload.targetTemplateId,
      workspace: context.workspace?._id || null,
      workspaceNameSnapshot: context.workspace?.name || "",
      snapshotSetHash: context.snapshotSetHash,
      shadowMode:
        String(process.env.RECONSTRUCTION_SHADOW_MODE || "false").toLowerCase() ===
        "true",
      startedAt: new Date(),
    });
    const ttlHours = Math.max(
      1,
      Number(process.env.RECONSTRUCTION_STORE_TTL_HOURS || 24) || 24,
    );
    const run = await VoucherReconstructionRun.create({
      user: req.user._id,
      workspace: context.workspace?._id || null,
      conversionRun: conversionRun._id,
      fileName: payload.fileName,
      fileSizeBytes: payload.fileSizeBytes,
      mode: payload.mode,
      targetTemplateId: payload.targetTemplateId,
      workspaceRevision: context.workspaceRevision,
      snapshotSetHash: context.snapshotSetHash,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
    });
    conversionRun.reconstructionRun = run._id;
    await conversionRun.save();
    const contextToken = createReconstructionContextToken({
      userId: req.user._id,
      runId: run._id,
      workspaceId: context.workspace?._id || "",
      snapshotSetHash: context.snapshotSetHash,
      snapshotIds: context.snapshots.map((item) => item._id),
      masterDataRevision: context.workspaceRevision,
      expiresIn: `${ttlHours}h`,
    });
    return res.status(201).json({
      success: true,
      run: serializeReconstructionRun(run),
      contextToken,
      expiresAt: run.expiresAt,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function listReconstructionRuns(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const filter = req.user.role === "admin" && req.query.all === "true"
      ? {}
      : { user: req.user._id };
    if (req.query.workspaceId) filter.workspace = req.query.workspaceId;
    const [total, runs] = await Promise.all([
      VoucherReconstructionRun.countDocuments(filter),
      VoucherReconstructionRun.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    return res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      runs: runs.map(serializeReconstructionRun),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getReconstructionRun(req, res) {
  try {
    const run = mongoose.isValidObjectId(req.params.id)
      ? await VoucherReconstructionRun.findById(req.params.id)
      : null;
    if (!run) throw httpError(404, "Không tìm thấy phiên tái tạo chứng từ");
    if (String(run.user) !== String(req.user._id) && req.user.role !== "admin") {
      throw httpError(403, "Không có quyền xem phiên tái tạo này");
    }
    return res.json({ success: true, run: serializeReconstructionRun(run) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function saveReconstructionProfile(req, res) {
  try {
    const run = mongoose.isValidObjectId(req.params.id)
      ? await VoucherReconstructionRun.findById(req.params.id)
      : null;
    if (!run) throw httpError(404, "Không tìm thấy phiên tái tạo chứng từ");
    if (!run.workspace) throw httpError(400, "Cần chọn hồ sơ doanh nghiệp để lưu profile");
    const workspace = await AccountingWorkspace.findById(run.workspace);
    if (!workspace || !userCanEditWorkspace(workspace, req.user._id)) {
      throw httpError(403, "Không có quyền lưu thiết lập cho doanh nghiệp này");
    }
    const payload = cleanReconstructionProfilePayload(req.body);
    payload.sourceSignatureHash =
      payload.sourceSignatureHash || run.sourceSignatureHash;
    if (!payload.sourceSignatureHash) {
      throw httpError(400, "Thiếu source signature của profile");
    }
    const latest = await ReconstructionProfile.findOne({
      workspace: workspace._id,
      sourceSignatureHash: payload.sourceSignatureHash,
    }).sort({ version: -1 });
    const profile = await ReconstructionProfile.create({
      ...payload,
      workspace: workspace._id,
      version: Number(latest?.version || 0) + 1,
      status: "draft",
      createdBy: req.user._id,
    });
    return res.status(201).json({
      success: true,
      profile: serializeReconstructionProfile(profile),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function activateReconstructionProfile(req, res) {
  try {
    const profile = mongoose.isValidObjectId(req.params.profileId)
      ? await ReconstructionProfile.findById(req.params.profileId)
      : null;
    if (!profile) throw httpError(404, "Không tìm thấy reconstruction profile");
    const workspace = await AccountingWorkspace.findById(profile.workspace);
    if (!workspace || !canReviewWorkspace(workspace, req.user._id)) {
      throw httpError(403, "Không có quyền phê duyệt profile này");
    }
    await ReconstructionProfile.updateMany(
      {
        workspace: workspace._id,
        sourceSignatureHash: profile.sourceSignatureHash,
        status: "active",
        _id: { $ne: profile._id },
      },
      { $set: { status: "deprecated" } },
    );
    profile.status = "active";
    profile.approvedBy = req.user._id;
    profile.approvedAt = new Date();
    profile.activatedAt = new Date();
    await profile.save();
    return res.json({
      success: true,
      profile: serializeReconstructionProfile(profile),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function recordInternalReconstructionEvent(req, res) {
  try {
    const scope = req.body.event === "exported" ? "export" : null;
    const claims = authenticateInternalReconstruction(req, scope);
    if (String(claims.run_id) !== String(req.params.id)) {
      throw httpError(409, "Run context không khớp");
    }
    const run = await VoucherReconstructionRun.findById(req.params.id);
    if (!run) throw httpError(404, "Không tìm thấy phiên tái tạo chứng từ");
    if (String(run.user) !== String(claims.user_id)) {
      throw httpError(403, "User context không khớp");
    }

    const event = String(req.body.event || "");
    const previousStatus = run.status;
    const eventStatus = {
      analyzing: "analyzing",
      analysis_completed: "review_required",
      review_updated: "review_required",
      approved: "approved",
      exported: "exported",
      failed: "failed",
      expired: "expired",
    }[event];
    if (!eventStatus) throw httpError(400, "Reconstruction event không hợp lệ");

    if (event === "exported" && run.status === "exported") {
      return res.json({
        success: true,
        idempotent: true,
        run: serializeReconstructionRun(run),
      });
    }
    if (event === "exported" && !run.creditChargedAt) {
      const credit = await deductCreditForCompletedRun(run.user, run._id);
      run.creditChargedAt = credit.creditChargedAt;
    }
    run.status = nextRunStatus(run.status, eventStatus);
    const summary = req.body.summary || {};
    run.sourceFileHash = String(req.body.sourceFileHash || run.sourceFileHash || "");
    run.sourceSignatureHash = String(
      req.body.sourceSignatureHash || run.sourceSignatureHash || "",
    );
    run.inputSheetCount = Number(summary.inputSheets || run.inputSheetCount || 0);
    run.inputRowCount = Number(summary.inputRows || run.inputRowCount || 0);
    run.draftCount = Number(summary.draftCount || run.draftCount || 0);
    run.readyCount = Number(summary.ready || 0);
    run.reviewCount = Number(summary.review || 0);
    run.blockedCount = Number(summary.blocked || 0);
    run.classificationSummary = summary.classification || run.classificationSummary || {};
    run.reconciliationSummary = summary.reconciliation || run.reconciliationSummary || {};
    run.latestDraftRevision = Number(
      req.body.latestDraftRevision || run.latestDraftRevision || 0,
    );
    run.errorCode = String(req.body.errorCode || "").slice(0, 120);
    run.errorMessage = String(req.body.errorMessage || "").slice(0, 1000);
    if (event === "analysis_completed" && req.body.profileId) {
      const profile = mongoose.isValidObjectId(req.body.profileId)
        ? await ReconstructionProfile.findOne({
            _id: req.body.profileId,
            workspace: run.workspace,
            sourceSignatureHash: run.sourceSignatureHash,
            status: "active",
          })
        : null;
      if (!profile) {
        throw httpError(
          409,
          "Reconstruction profile đã thay đổi; vui lòng phân tích lại file",
        );
      }
      const firstUse = !run.profile;
      run.profile = profile._id;
      run.profileVersion = Number(profile.version || req.body.profileVersion || 0);
      if (firstUse) {
        profile.usageCount = Number(profile.usageCount || 0) + 1;
        if (Number(summary.review || 0) > 0) {
          profile.reviewCount = Number(profile.reviewCount || 0) + 1;
        }
        await profile.save();
      }
    }
    if (req.body.metrics && typeof req.body.metrics === "object") {
      run.metrics = { ...(run.metrics || {}), ...req.body.metrics };
    }
    if (event === "approved") {
      run.approvedBy = claims.user_id;
      run.approvedAt = new Date();
    }
    if (event === "exported") {
      run.exportedAt = new Date();
      run.exportIdempotencyKey = String(req.body.idempotencyKey || "").slice(0, 160);
    }
    await run.save();

    if (Array.isArray(req.body.decisions) && req.body.decisions.length) {
      const decisions = req.body.decisions.slice(0, 500).map((item) => ({
        run: run._id,
        draftStableId: String(item.draftStableId || "").slice(0, 128),
        draftRevision: Math.max(1, Number(item.draftRevision || 1)),
        operationType: item.operationType,
        fieldPath: String(item.fieldPath || "").slice(0, 240),
        beforeHash: String(item.beforeHash || "").slice(0, 128),
        afterHash: String(item.afterHash || "").slice(0, 128),
        structuralRule:
          item.structuralRule && typeof item.structuralRule === "object"
            ? item.structuralRule
            : {},
        sourceRows: Array.isArray(item.sourceRows)
          ? item.sourceRows.map(Number).filter(Number.isFinite)
          : [],
        actor: claims.user_id,
      }));
      await ReconstructionDecision.insertMany(decisions, { ordered: false });
    }

    const conversionUpdate = {
      documentCount: run.draftCount,
      reviewCount: run.reviewCount,
      targetTemplateId: run.targetTemplateId || "",
    };
    if (event === "failed") {
      conversionUpdate.status = "failed";
      conversionUpdate.completedAt = new Date();
      conversionUpdate.errorMessage = run.errorMessage;
    } else if (event === "exported") {
      conversionUpdate.status = "completed";
      conversionUpdate.completedAt = new Date();
    }
    const conversionRun = await ConversionRun.findByIdAndUpdate(
      run.conversionRun,
      { $set: conversionUpdate },
      { new: true },
    );
    if (event === "exported" && run.creditChargedAt && conversionRun) {
      conversionRun.creditChargedAt = run.creditChargedAt;
      await conversionRun.save();
    }
    if (event === "exported" && previousStatus !== "exported" && run.profile) {
      await ReconstructionProfile.updateOne(
        { _id: run.profile },
        { $inc: { successCount: 1 } },
      );
    }
    return res.json({ success: true, run: serializeReconstructionRun(run) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function findInternalReconstructionProfile(req, res) {
  try {
    const claims = authenticateInternalReconstruction(req, "analyze");
    if (!claims.workspace_id) return res.json({ success: true, profile: null });
    const sourceSignatureHash = String(
      req.query.sourceSignatureHash || "",
    ).trim();
    if (!sourceSignatureHash) throw httpError(400, "Thiếu sourceSignatureHash");
    const profile = await ReconstructionProfile.findOne({
      workspace: claims.workspace_id,
      sourceSignatureHash,
      status: "active",
    }).sort({ version: -1 });
    return res.json({
      success: true,
      profile: profile ? serializeReconstructionProfile(profile) : null,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function checkInternalReconstructionProfile(req, res) {
  try {
    const claims = authenticateInternalReconstruction(req, "review");
    if (!claims.workspace_id) {
      throw httpError(409, "Run không có workspace để xác minh profile");
    }
    const profile = mongoose.isValidObjectId(req.params.profileId)
      ? await ReconstructionProfile.findOne({
          _id: req.params.profileId,
          workspace: claims.workspace_id,
          status: "active",
        })
      : null;
    const expectedVersion = Number(req.query.version || 0);
    if (!profile || Number(profile.version || 0) !== expectedVersion) {
      throw httpError(
        409,
        "Reconstruction profile đã thay đổi; vui lòng phân tích lại file",
      );
    }
    return res.json({
      success: true,
      current: true,
      profile: serializeReconstructionProfile(profile),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  activateReconstructionProfile,
  authenticateInternalReconstruction,
  checkInternalReconstructionProfile,
  createReconstructionRun,
  findInternalReconstructionProfile,
  getReconstructionRun,
  listReconstructionRuns,
  recordInternalReconstructionEvent,
  saveReconstructionProfile,
};
