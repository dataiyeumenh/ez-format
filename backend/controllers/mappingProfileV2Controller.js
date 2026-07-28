const mongoose = require("mongoose");
const AccountingWorkspace = require("../models/AccountingWorkspace");
const {
  authenticateInternalContext,
} = require("./accountingWorkspaceController");
const {
  assertConversionContextBinding,
} = require("../services/conversionContextService");
const {
  mappingProfileOwnerFromClaims,
} = require("../services/mappingProfileService");
const {
  userCanAccessWorkspace,
  userCanEditWorkspace,
} = require("../services/masterDataService");
const {
  activateProfile,
  createDraft,
  createVersion,
  confirmProfile,
  getProfileHistory,
  listProfiles,
  matchProfiles,
  ownedProfile,
  quarantineProfile,
  recordConfirmedExport,
  serializeProfile,
  suspendProfile,
} = require("../services/mappingProfileV2Service");

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requestWorkspaceId(req) {
  return String(req.body?.workspaceId || req.query?.workspaceId || "").trim() || null;
}

async function resolvePublicOwnerAccess({
  user,
  workspaceId,
  requireEdit = false,
  requireManage = false,
  workspaceModel = AccountingWorkspace,
}) {
  const userId = String(user?._id || "").trim();
  if (!mongoose.isValidObjectId(userId)) {
    throw httpError(401, "Người dùng không hợp lệ");
  }
  if (!workspaceId) {
    return {
      ownerScope: `user:${userId}`,
      workspace: null,
      workspaceId: null,
      userId,
    };
  }
  if (!mongoose.isValidObjectId(workspaceId)) {
    throw httpError(400, "workspaceId không hợp lệ");
  }
  const workspace = await workspaceModel.findOne({
    _id: workspaceId,
    isActive: true,
  });
  if (!workspace || !userCanAccessWorkspace(workspace, userId)) {
    throw httpError(403, "Bạn không có quyền truy cập mapping profile này");
  }
  if (requireEdit && !userCanEditWorkspace(workspace, userId)) {
    throw httpError(403, "Bạn không có quyền chỉnh sửa mapping profile này");
  }
  if (
    requireManage &&
    String(workspace.owner) !== userId &&
    String(user.role || "") !== "admin"
  ) {
    throw httpError(403, "Chỉ chủ doanh nghiệp được quản lý mapping profile");
  }
  return {
    ownerScope: `workspace:${workspaceId}`,
    workspace,
    workspaceId,
    userId,
  };
}

function sendError(res, error) {
  const status = Number(error.statusCode) || 500;
  if (status >= 500) console.error("[mapping-profile-v2] Request failed:", error);
  return res.status(status).json({
    success: false,
    message: status === 500 ? "Không thể xử lý mapping profile" : error.message,
  });
}

async function publicOwner(req, options = {}) {
  return resolvePublicOwnerAccess({
    user: req.user,
    workspaceId: requestWorkspaceId(req),
    ...options,
  });
}

async function internalOwner(claims, { requireEdit = false } = {}) {
  const owner = mappingProfileOwnerFromClaims(claims);
  if (!owner.workspaceId) return { ...owner, workspace: null };
  const workspace = await AccountingWorkspace.findOne({
    _id: owner.workspaceId,
    isActive: true,
  });
  if (!workspace || !userCanAccessWorkspace(workspace, owner.userId)) {
    throw httpError(403, "Bạn không có quyền truy cập mapping profile này");
  }
  if (requireEdit && !userCanEditWorkspace(workspace, owner.userId)) {
    throw httpError(403, "Bạn không có quyền chỉnh sửa mapping profile này");
  }
  return { ...owner, workspace };
}

async function matchMappingProfile(req, res) {
  try {
    const owner = await publicOwner(req);
    const result = await matchProfiles({
      ownerScope: owner.ownerScope,
      identity: req.body,
    });
    return res.json({ success: true, match: result });
  } catch (error) {
    return sendError(res, error);
  }
}

async function createMappingProfile(req, res) {
  try {
    const owner = await publicOwner(req, { requireEdit: true });
    const profile = await createDraft({
      ownerScope: owner.ownerScope,
      workspace: owner.workspaceId,
      user: owner.userId,
      createdBy: owner.userId,
      payload: req.body,
    });
    return res.status(201).json({ success: true, profile: serializeProfile(profile) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function createMappingProfileVersion(req, res) {
  try {
    const owner = await publicOwner(req, { requireEdit: true });
    const profile = await createVersion({
      ownerScope: owner.ownerScope,
      profileId: req.params.id,
      createdBy: owner.userId,
      patch: req.body,
    });
    return res.status(201).json({ success: true, profile: serializeProfile(profile) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function activateMappingProfile(req, res) {
  try {
    const owner = await publicOwner(req, { requireEdit: true, requireManage: true });
    const profile = await activateProfile({
      ownerScope: owner.ownerScope,
      profileId: req.params.id,
      stateHash: String(req.body.stateHash || ""),
      expectedPreviousVersion: req.body.expectedPreviousVersion,
      approvedBy: owner.userId,
    });
    return res.json({ success: true, profile: serializeProfile(profile) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function suspendMappingProfile(req, res) {
  try {
    const owner = await publicOwner(req, { requireEdit: true, requireManage: true });
    const profile = await suspendProfile({
      ownerScope: owner.ownerScope,
      profileId: req.params.id,
      stateHash: String(req.body.stateHash || ""),
    });
    return res.json({ success: true, profile: serializeProfile(profile) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function listMappingProfiles(req, res) {
  try {
    const owner = await publicOwner(req);
    const profiles = await listProfiles({
      ownerScope: owner.ownerScope,
      status: req.query.status ? String(req.query.status) : null,
    });
    return res.json({
      success: true,
      items: profiles.map(serializeProfile),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getMappingProfileHistory(req, res) {
  try {
    const owner = await publicOwner(req);
    const selected = await ownedProfile(undefined, owner.ownerScope, req.params.id);
    if (!selected) throw httpError(404, "Không tìm thấy mapping profile V2");
    const profiles = await getProfileHistory({
      ownerScope: owner.ownerScope,
      profileFamilyId: selected.profileFamilyId,
    });
    return res.json({ success: true, items: profiles.map(serializeProfile) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function matchInternalMappingProfile(req, res) {
  try {
    const claims = authenticateInternalContext(req, "analyze");
    const owner = mappingProfileOwnerFromClaims(claims);
    const result = await matchProfiles({
      ownerScope: owner.ownerScope,
      identity: req.body,
    });
    return res.json({ success: true, match: result });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getInternalMappingProfileV2(req, res) {
  try {
    const claims = authenticateInternalContext(req, "export");
    const owner = mappingProfileOwnerFromClaims(claims);
    const profile = mongoose.isValidObjectId(req.params.id)
      ? await ownedProfile(undefined, owner.ownerScope, req.params.id)
      : null;
    if (!profile) throw httpError(404, "Không tìm thấy mapping profile V2");
    if (profile.status !== "active") {
      throw httpError(409, "Mapping profile V2 không còn hoạt động");
    }
    return res.json({ success: true, profile: serializeProfile(profile) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function quarantineInternalMappingProfileV2(req, res) {
  try {
    const claims = authenticateInternalContext(req, "analyze");
    const owner = mappingProfileOwnerFromClaims(claims);
    const profile = await quarantineProfile({
      ownerScope: owner.ownerScope,
      profileId: req.params.id,
      reason: req.body?.reason,
    });
    return res.json({ success: true, profile: serializeProfile(profile) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function recordInternalConfirmedExport(req, res) {
  try {
    const claims = authenticateInternalContext(req, "export");
    const owner = mappingProfileOwnerFromClaims(claims);
    const result = await recordConfirmedExport({
      ownerScope: owner.ownerScope,
      profileId: req.params.id,
      exportId: req.body.exportId,
      version: req.body.version,
      stateHash: req.body.stateHash,
    });
    return res.json({
      success: true,
      recorded: result.recorded,
      profile: serializeProfile(result.profile),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function confirmInternalMappingProfile(req, res) {
  try {
    const claims = authenticateInternalContext(req, "confirm");
    if (claims.purpose === "misa_conversion") {
      try {
        assertConversionContextBinding(claims, { requiredScope: "confirm" });
      } catch (error) {
        throw httpError(403, error.message);
      }
    }
    const owner = await internalOwner(claims, { requireEdit: true });
    const profile = await confirmProfile({
      ownerScope: owner.ownerScope,
      profileId: req.body.candidate_profile_id || req.body.candidateProfileId,
      sourceSignatureHash:
        req.body.source_signature_hash || req.body.sourceSignatureHash,
      targetTemplateId:
        req.body.target_template_id || req.body.targetTemplateId,
      mapping: req.body.mapping,
      defaults: req.body.defaults,
      formulas: req.body.formulas,
      expectedVersion: req.body.expected_version ?? req.body.expectedVersion,
      userCorrection: req.body.user_correction ?? req.body.userCorrection,
      approvedBy: owner.userId,
    });
    return res.json({
      success: true,
      saved: true,
      profile: serializeProfile(profile),
      profile_id: String(profile._id || profile.id),
      version: Number(profile.version),
      state_hash: profile.stateHash,
      status: profile.status,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  activateMappingProfile,
  confirmInternalMappingProfile,
  createMappingProfile,
  createMappingProfileVersion,
  getInternalMappingProfileV2,
  getMappingProfileHistory,
  listMappingProfiles,
  matchInternalMappingProfile,
  matchMappingProfile,
  recordInternalConfirmedExport,
  quarantineInternalMappingProfileV2,
  resolvePublicOwnerAccess,
  suspendMappingProfile,
};
