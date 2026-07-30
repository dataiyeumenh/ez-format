const crypto = require("crypto");
const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const MasterDataSnapshot = require("../models/MasterDataSnapshot");
const MasterDataEntry = require("../models/MasterDataEntry");
const MasterDataAlias = require("../models/MasterDataAlias");
const MappingProfile = require("../models/MappingProfile");
const {
  SUPPORTED_MASTER_DATA_TYPES,
  buildMasterDataContext,
  buildSnapshotSetHash,
  normalizeCode,
  normalizeName,
  normalizeTaxCode,
  prepareMasterDataEntries,
  userCanAccessWorkspace,
  userCanEditWorkspace,
} = require("../services/masterDataService");
const {
  verifyConversionContextToken,
  verifyStudentContextToken,
} = require("../services/conversionContextService");
const {
  issueConversionContextForRun,
} = require("../services/conversionContextBindingService");
const { parseMasterDataFile } = require("../services/converterClient");
const {
  cleanMappingProfilePayload,
  mappingProfileOwnerFromClaims,
  serializeMappingProfile,
} = require("../services/mappingProfileService");

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function secureTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function authenticateInternalContext(req, requiredStudentScope = "analyze") {
  const expectedServiceToken = String(
    process.env.CONVERTER_SERVICE_TOKEN || "",
  ).trim();
  if (!expectedServiceToken) {
    throw httpError(503, "CONVERTER_SERVICE_TOKEN chưa được cấu hình");
  }
  if (
    !secureTokenEquals(
      req.headers["x-converter-service-token"],
      expectedServiceToken,
    )
  ) {
    throw httpError(401, "Service token không hợp lệ");
  }
  const contextToken = req.headers["x-conversion-context"];
  if (!contextToken) throw httpError(401, "Thiếu conversion context");
  try {
    return verifyConversionContextToken(contextToken);
  } catch (conversionError) {
    try {
      return verifyStudentContextToken(contextToken, requiredStudentScope);
    } catch (studentError) {
      throw httpError(401, studentError.message || conversionError.message);
    }
  }
}

async function internalWorkspaceFromClaims(claims) {
  const workspace = await AccountingWorkspace.findOne({
    _id: claims.workspace_id,
    isActive: true,
  });
  if (!workspace) throw httpError(404, "Không tìm thấy doanh nghiệp");
  return workspace;
}

async function mappingProfileAccessFromClaims(claims, { requireEdit = false } = {}) {
  const owner = mappingProfileOwnerFromClaims(claims);
  if (!owner.workspaceId) return { ...owner, workspace: null };

  const workspace = await internalWorkspaceFromClaims(claims);
  if (requireEdit && !userCanEditWorkspace(workspace, owner.userId)) {
    throw httpError(403, "Bạn không có quyền lưu mapping profile");
  }
  return { ...owner, workspace };
}

async function assertCurrentMasterDataContext(claims, requestedHash) {
  if (claims.snapshot_set_hash !== requestedHash) {
    throw httpError(409, "Snapshot context không khớp");
  }
  const workspace = await internalWorkspaceFromClaims(claims);
  if (
    Number(claims.master_data_revision || 0) !==
    Number(workspace.masterDataRevision || 0)
  ) {
    throw httpError(
      409,
      "Danh mục hoặc alias MISA đã thay đổi; vui lòng tạo context mới",
    );
  }
  const snapshots = await MasterDataSnapshot.find({
    _id: { $in: claims.snapshot_ids || [] },
    workspace: workspace._id,
    status: "active",
  });
  if (buildSnapshotSetHash(snapshots) !== claims.snapshot_set_hash) {
    throw httpError(409, "Danh mục MISA đã thay đổi");
  }
  return { workspace, snapshots };
}

function sendInternalError(res, error) {
  const status = Number(error.statusCode) || 500;
  if (status >= 500) console.error("[internal] Request failed:", error);
  return res.status(status).json({
    success: false,
    message: status === 500 ? "Không thể xử lý yêu cầu nội bộ" : error.message,
  });
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanWorkspacePayload(body = {}) {
  const payload = {};
  if (body.name != null) payload.name = String(body.name).trim();
  if (body.taxCode != null) payload.taxCode = String(body.taxCode).trim();
  if (body.misaProduct != null)
    payload.misaProduct = String(body.misaProduct).toUpperCase();
  if (body.accountingRegime != null) {
    payload.accountingRegime = String(body.accountingRegime).toUpperCase();
  }
  if (body.fiscalYearStartMonth != null) {
    payload.fiscalYearStartMonth = Number(body.fiscalYearStartMonth);
  }
  if (body.lockedThroughDate !== undefined) {
    payload.lockedThroughDate = body.lockedThroughDate || null;
  }
  return payload;
}

function serializeWorkspace(workspace) {
  return {
    id: String(workspace._id || workspace.id),
    name: workspace.name,
    taxCode: workspace.taxCode || "",
    misaProduct: workspace.misaProduct || "AMIS",
    accountingRegime: workspace.accountingRegime || "AUTO",
    fiscalYearStartMonth: workspace.fiscalYearStartMonth || 1,
    lockedThroughDate: workspace.lockedThroughDate || null,
    owner: String(workspace.owner?._id || workspace.owner),
    members: (workspace.members || []).map((member) => ({
      user: String(member.user?._id || member.user),
      role: member.role,
    })),
    activeSnapshots: (workspace.activeSnapshots || []).map((item) => ({
      type: item.type,
      snapshot: String(item.snapshot?._id || item.snapshot),
    })),
    isActive: workspace.isActive !== false,
    masterDataRevision: workspace.masterDataRevision || 0,
    createdAt: workspace.createdAt || null,
    updatedAt: workspace.updatedAt || null,
  };
}

function serializeSnapshot(snapshot) {
  return {
    id: String(snapshot._id || snapshot.id),
    type: snapshot.type,
    sourceFileName: snapshot.sourceFileName,
    sourceFileHash: snapshot.sourceFileHash,
    rowCount: snapshot.rowCount || 0,
    status: snapshot.status,
    warnings: snapshot.warnings || [],
    errorMessage: snapshot.errorMessage || "",
    createdAt: snapshot.createdAt || null,
    updatedAt: snapshot.updatedAt || null,
    activatedAt: snapshot.activatedAt || null,
  };
}

async function findWorkspaceForUser(workspaceId, userId) {
  if (!mongoose.isValidObjectId(workspaceId)) return null;
  const workspace = await AccountingWorkspace.findOne({
    _id: workspaceId,
    isActive: true,
  });
  if (!workspace || !userCanAccessWorkspace(workspace, userId)) return null;
  return workspace;
}

async function listWorkspaces(req, res) {
  try {
    const workspaces = await AccountingWorkspace.find({
      isActive: true,
      $or: [{ owner: req.user._id }, { "members.user": req.user._id }],
    }).sort({ updatedAt: -1 });
    res.json({ success: true, items: workspaces.map(serializeWorkspace) });
  } catch (error) {
    res
      .status(500)
      .json({
        success: false,
        message: "Không thể tải hồ sơ doanh nghiệp",
        error: error.message,
      });
  }
}

async function createWorkspace(req, res) {
  try {
    const workspace = await AccountingWorkspace.create({
      ...cleanWorkspacePayload(req.body),
      owner: req.user._id,
      members: [],
    });
    res
      .status(201)
      .json({ success: true, workspace: serializeWorkspace(workspace) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
}

async function getWorkspace(req, res) {
  try {
    const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
    if (!workspace)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
    res.json({ success: true, workspace: serializeWorkspace(workspace) });
  } catch (error) {
    res
      .status(400)
      .json({ success: false, message: "Hồ sơ doanh nghiệp không hợp lệ" });
  }
}

async function updateWorkspace(req, res) {
  try {
    const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
    if (!workspace)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
    if (String(workspace.owner) !== String(req.user._id)) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Chỉ chủ doanh nghiệp được chỉnh sửa hồ sơ",
        });
    }
    Object.assign(workspace, cleanWorkspacePayload(req.body));
    await workspace.save();
    res.json({ success: true, workspace: serializeWorkspace(workspace) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
}

async function deleteWorkspace(req, res) {
  const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
  if (!workspace)
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
  if (String(workspace.owner) !== String(req.user._id)) {
    return res
      .status(403)
      .json({ success: false, message: "Chỉ chủ doanh nghiệp được xóa hồ sơ" });
  }
  workspace.isActive = false;
  await workspace.save();
  res.json({ success: true, deleted: true });
}

async function listMasterData(req, res) {
  const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
  if (!workspace)
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
  const snapshots = await MasterDataSnapshot.find({
    workspace: workspace._id,
  }).sort({ createdAt: -1 });
  res.json({
    success: true,
    supportedTypes: SUPPORTED_MASTER_DATA_TYPES,
    snapshots: snapshots.map(serializeSnapshot),
  });
}

async function searchMasterData(req, res) {
  const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
  if (!workspace) {
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
  }
  const type = String(req.query.type || "").trim();
  if (!SUPPORTED_MASTER_DATA_TYPES.includes(type)) {
    return res
      .status(400)
      .json({ success: false, message: "Loại danh mục không được hỗ trợ" });
  }
  const activeRef = (workspace.activeSnapshots || []).find(
    (item) => item.type === type,
  );
  if (!activeRef) {
    return res
      .status(409)
      .json({ success: false, message: "Chưa có danh mục đang hoạt động" });
  }

  const queryText = String(req.query.q || "").trim();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const filter = { snapshot: activeRef.snapshot, type, active: true };
  if (queryText) {
    const code = escapeRegex(normalizeCode(queryText));
    const name = escapeRegex(normalizeName(queryText));
    const taxCode = escapeRegex(normalizeTaxCode(queryText));
    filter.$or = [
      { normalizedCode: { $regex: code, $options: "i" } },
      { normalizedName: { $regex: name, $options: "i" } },
      { normalizedTaxCode: { $regex: taxCode, $options: "i" } },
    ];
  }

  const entries = await MasterDataEntry.find(filter)
    .select("code name taxCode attributes")
    .sort({ code: 1, name: 1 })
    .limit(limit)
    .lean();
  return res.json({
    success: true,
    items: entries.map((entry) => ({
      code: entry.code || "",
      name: entry.name || "",
      taxCode: entry.taxCode || "",
      attributes: entry.attributes || {},
    })),
  });
}

async function importMasterData(req, res) {
  const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
  if (!workspace)
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
  if (!userCanEditWorkspace(workspace, req.user._id)) {
    return res
      .status(403)
      .json({
        success: false,
        message: "Bạn không có quyền cập nhật danh mục",
      });
  }
  const type = String(req.body.type || "").trim();
  if (!SUPPORTED_MASTER_DATA_TYPES.includes(type)) {
    return res
      .status(400)
      .json({ success: false, message: "Loại danh mục không được hỗ trợ" });
  }
  if (!req.file)
    return res
      .status(400)
      .json({ success: false, message: "Vui lòng chọn file Excel" });

  const sourceFileHash = crypto
    .createHash("sha256")
    .update(req.file.buffer)
    .digest("hex");
  const existing = await MasterDataSnapshot.findOne({
    workspace: workspace._id,
    type,
    sourceFileHash,
  });
  if (existing && existing.status !== "failed") {
    return res.json({
      success: true,
      reused: true,
      snapshot: serializeSnapshot(existing),
    });
  }
  if (existing) {
    await MasterDataEntry.deleteMany({ snapshot: existing._id });
    await existing.deleteOne();
  }

  let snapshot;
  try {
    snapshot = await MasterDataSnapshot.create({
      workspace: workspace._id,
      type,
      sourceFileName: String(req.file.originalname || "catalog.xlsx").replace(
        /[\\/]/g,
        "",
      ),
      sourceFileHash,
      importedBy: req.user._id,
      status: "processing",
    });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await MasterDataSnapshot.findOne({
        workspace: workspace._id,
        type,
        sourceFileHash,
      });
      if (duplicate) {
        return res.json({
          success: true,
          reused: true,
          snapshot: serializeSnapshot(duplicate),
        });
      }
    }
    throw error;
  }

  try {
    const parsed = await parseMasterDataFile({
      file: req.file,
      catalogType: type,
    });
    const prepared = prepareMasterDataEntries(type, parsed.entries || []);
    if (!prepared.entries.length)
      throw new Error("Không tìm thấy dòng danh mục hợp lệ trong file");
    await MasterDataEntry.insertMany(
      prepared.entries.map((entry) => ({
        ...entry,
        workspace: workspace._id,
        snapshot: snapshot._id,
      })),
      { ordered: true },
    );
    snapshot.rowCount = prepared.entries.length;
    snapshot.warnings = [...(parsed.warnings || []), ...prepared.warnings];
    snapshot.status = "ready";
    await snapshot.save();
    return res
      .status(201)
      .json({ success: true, snapshot: serializeSnapshot(snapshot) });
  } catch (error) {
    await MasterDataEntry.deleteMany({ snapshot: snapshot._id }).catch(
      () => {},
    );
    snapshot.status = "failed";
    snapshot.errorMessage = error.message;
    await snapshot.save();
    return res
      .status(422)
      .json({
        success: false,
        message: error.message,
        snapshot: serializeSnapshot(snapshot),
      });
  }
}

async function activateSnapshot(req, res) {
  const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
  if (!workspace)
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
  if (!userCanEditWorkspace(workspace, req.user._id)) {
    return res
      .status(403)
      .json({
        success: false,
        message: "Bạn không có quyền kích hoạt danh mục",
      });
  }
  const snapshot = mongoose.isValidObjectId(req.params.snapshotId)
    ? await MasterDataSnapshot.findOne({
        _id: req.params.snapshotId,
        workspace: workspace._id,
        status: { $in: ["ready", "active"] },
      })
    : null;
  if (!snapshot)
    return res
      .status(404)
      .json({ success: false, message: "Snapshot chưa sẵn sàng" });

  await MasterDataSnapshot.updateMany(
    {
      workspace: workspace._id,
      type: snapshot.type,
      status: "active",
      _id: { $ne: snapshot._id },
    },
    { $set: { status: "archived" } },
  );
  snapshot.status = "active";
  snapshot.activatedAt = new Date();
  try {
    await snapshot.save();
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message:
          "Một phiên bản danh mục khác vừa được kích hoạt; vui lòng tải lại",
      });
    }
    throw error;
  }
  workspace.activeSnapshots = (workspace.activeSnapshots || []).filter(
    (item) => item.type !== snapshot.type,
  );
  workspace.activeSnapshots.push({
    type: snapshot.type,
    snapshot: snapshot._id,
  });
  workspace.masterDataRevision = Number(workspace.masterDataRevision || 0) + 1;
  await workspace.save();
  res.json({
    success: true,
    snapshot: serializeSnapshot(snapshot),
    workspace: serializeWorkspace(workspace),
  });
}

async function deleteSnapshot(req, res) {
  const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
  if (!workspace)
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
  if (!userCanEditWorkspace(workspace, req.user._id)) {
    return res
      .status(403)
      .json({ success: false, message: "Bạn không có quyền xóa danh mục" });
  }
  const snapshot = mongoose.isValidObjectId(req.params.snapshotId)
    ? await MasterDataSnapshot.findOne({
        _id: req.params.snapshotId,
        workspace: workspace._id,
      })
    : null;
  if (!snapshot)
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy snapshot" });
  if (snapshot.status === "active") {
    return res
      .status(409)
      .json({
        success: false,
        message: "Không thể xóa snapshot đang hoạt động",
      });
  }
  await MasterDataEntry.deleteMany({ snapshot: snapshot._id });
  await snapshot.deleteOne();
  res.json({ success: true, deleted: true });
}

async function saveAlias(req, res) {
  const workspace = await findWorkspaceForUser(req.params.id, req.user._id);
  if (!workspace)
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy doanh nghiệp" });
  if (!userCanEditWorkspace(workspace, req.user._id)) {
    return res
      .status(403)
      .json({ success: false, message: "Bạn không có quyền lưu alias" });
  }
  const type = String(req.body.type || "").trim();
  const rawValue = String(req.body.rawValue || "").trim();
  const targetCode = String(req.body.targetCode || "").trim();
  const sourceSystem =
    String(req.body.sourceSystem || "default").trim() || "default";
  if (!SUPPORTED_MASTER_DATA_TYPES.includes(type) || !rawValue || !targetCode) {
    return res
      .status(400)
      .json({ success: false, message: "Alias không hợp lệ" });
  }
  const activeRef = (workspace.activeSnapshots || []).find(
    (item) => item.type === type,
  );
  if (!activeRef)
    return res
      .status(409)
      .json({ success: false, message: "Chưa có danh mục đang hoạt động" });
  const target = await MasterDataEntry.findOne({
    snapshot: activeRef.snapshot,
    type,
    normalizedCode: normalizeCode(targetCode),
  });
  if (!target)
    return res
      .status(422)
      .json({
        success: false,
        message: "Mã đích không tồn tại trong danh mục đang hoạt động",
      });
  const alias = await MasterDataAlias.findOneAndUpdate(
    {
      workspace: workspace._id,
      type,
      sourceSystem,
      normalizedRawValue: normalizeName(rawValue),
    },
    {
      $set: {
        rawValue,
        targetCode: target.code,
        normalizedTargetCode: target.normalizedCode,
        status: "confirmed",
        confirmedBy: req.user._id,
      },
      $setOnInsert: { usageCount: 0 },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
  workspace.masterDataRevision = Number(workspace.masterDataRevision || 0) + 1;
  await workspace.save();
  res.json({ success: true, alias });
}

async function createConversionContext(req, res) {
  const context = await issueConversionContextForRun({
    conversionRunId: req.body?.conversion_run_id,
    userId: req.user._id,
    expectedWorkspaceId: req.params.id,
  });
  if (!context) {
    return res
      .status(404)
      .json({ success: false, message: "Không tìm thấy phiên chuyển đổi" });
  }
  res.json({
    success: true,
    contextToken: context.contextToken,
    conversionRunId: context.conversionRunId,
    operationSessionId: context.operationSessionId,
    uploadId: context.uploadId,
    targetTemplateId: context.targetTemplateId,
    snapshotSetHash: context.snapshotSetHash,
    workspace: serializeWorkspace(context.workspace),
    snapshots: context.snapshots.map(serializeSnapshot),
  });
}

async function getInternalMasterDataContext(req, res) {
  try {
    const claims = authenticateInternalContext(req, "analyze");
    const { workspace, snapshots } = await assertCurrentMasterDataContext(
      claims,
      req.params.snapshotSetHash,
    );
    const [entries, aliases] = await Promise.all([
      MasterDataEntry.find({
        snapshot: { $in: snapshots.map((item) => item._id) },
      }).lean(),
      MasterDataAlias.find({
        workspace: workspace._id,
        status: "confirmed",
      }).lean(),
    ]);
    res.json(
      buildMasterDataContext({ workspace, snapshots, entries, aliases }),
    );
  } catch (error) {
    sendInternalError(res, error);
  }
}

async function validateInternalMasterDataContext(req, res) {
  try {
    const claims = authenticateInternalContext(req, "analyze");
    const { workspace } = await assertCurrentMasterDataContext(
      claims,
      req.params.snapshotSetHash,
    );
    return res.json({
      success: true,
      valid: true,
      snapshotSetHash: claims.snapshot_set_hash,
      masterDataRevision: workspace.masterDataRevision || 0,
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
}

async function findInternalMappingProfile(req, res) {
  try {
    const claims = authenticateInternalContext(req, "analyze");
    const owner = await mappingProfileAccessFromClaims(claims);
    const targetTemplateId = String(req.query.targetTemplateId || "").trim();
    const sourceSignatureHash = String(
      req.query.sourceSignatureHash || "",
    ).trim();
    if (!targetTemplateId || !sourceSignatureHash) {
      throw httpError(400, "Thiếu targetTemplateId hoặc sourceSignatureHash");
    }
    const profile = await MappingProfile.findOne({
      ownerScope: owner.ownerScope,
      targetTemplateId,
      sourceSignatureHash,
    });
    return res.json({
      success: true,
      profile: profile ? serializeMappingProfile(profile) : null,
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
}

async function getInternalMappingProfile(req, res) {
  try {
    const claims = authenticateInternalContext(req, "export");
    const owner = await mappingProfileAccessFromClaims(claims);
    const profile = mongoose.isValidObjectId(req.params.profileId)
      ? await MappingProfile.findOne({
          _id: req.params.profileId,
          ownerScope: owner.ownerScope,
        })
      : null;
    if (!profile) throw httpError(404, "Không tìm thấy mapping profile");
    return res.json({
      success: true,
      profile: serializeMappingProfile(profile),
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
}

async function saveInternalMappingProfile(req, res) {
  try {
    const claims = authenticateInternalContext(req, "attempt");
    const owner = await mappingProfileAccessFromClaims(claims, {
      requireEdit: true,
    });
    const payload = cleanMappingProfilePayload(req.body);
    if (!payload.targetTemplateId || !payload.sourceSignatureHash) {
      throw httpError(
        400,
        "Mapping profile thiếu template hoặc source signature",
      );
    }
    const profile = await MappingProfile.findOneAndUpdate(
      {
        ownerScope: owner.ownerScope,
        targetTemplateId: payload.targetTemplateId,
        sourceSignatureHash: payload.sourceSignatureHash,
      },
      {
        $set: {
          ...payload,
          ownerScope: owner.ownerScope,
          workspace: owner.workspace?._id || null,
          user: owner.userId,
          updatedBy: owner.userId,
        },
        $setOnInsert: { usageCount: 0 },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );
    return res.status(201).json({
      success: true,
      profile: serializeMappingProfile(profile),
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
}

async function markInternalMappingProfileUsed(req, res) {
  try {
    const claims = authenticateInternalContext(req, "analyze");
    const owner = await mappingProfileAccessFromClaims(claims);
    const profile = mongoose.isValidObjectId(req.params.profileId)
      ? await MappingProfile.findOneAndUpdate(
          { _id: req.params.profileId, ownerScope: owner.ownerScope },
          { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
          { new: true },
        )
      : null;
    if (!profile) throw httpError(404, "Không tìm thấy mapping profile");
    return res.json({
      success: true,
      profile: serializeMappingProfile(profile),
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
}

module.exports = {
  activateSnapshot,
  cleanWorkspacePayload,
  createConversionContext,
  createWorkspace,
  deleteSnapshot,
  deleteWorkspace,
  getInternalMasterDataContext,
  findInternalMappingProfile,
  getInternalMappingProfile,
  getWorkspace,
  importMasterData,
  listMasterData,
  listWorkspaces,
  markInternalMappingProfileUsed,
  saveInternalMappingProfile,
  saveAlias,
  searchMasterData,
  serializeSnapshot,
  serializeWorkspace,
  authenticateInternalContext,
  updateWorkspace,
  validateInternalMasterDataContext,
};
