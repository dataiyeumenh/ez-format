const crypto = require("crypto");
const MappingProfileV2 = require("../models/MappingProfileV2");

const IDENTITY_FIELDS = Object.freeze([
  "sourceFamily",
  "documentType",
  "headerFingerprint",
  "dataShapeFingerprint",
  "targetTemplateId",
  "targetTemplateVersion",
]);
const CONTENT_FIELDS = Object.freeze([
  "name",
  ...IDENTITY_FIELDS,
  "mapping",
  "defaults",
  "formulas",
  "riskFlags",
]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function validateConfirmationPayload({ mapping, defaults, formulas, userCorrection }) {
  if (userCorrection !== true) {
    throw httpError(400, "Mapping profile V2 chỉ được kích hoạt sau khi người dùng xác nhận");
  }
  for (const [field, value] of Object.entries({ mapping, defaults, formulas })) {
    if (value != null && (typeof value !== "object" || Array.isArray(value))) {
      throw httpError(400, `Mapping profile V2 ${field} không hợp lệ`);
    }
    for (const key of Object.keys(plainObject(value))) {
      if (!String(key).trim() || key.startsWith("$")) {
        throw httpError(400, `Mapping profile V2 ${field} chứa khóa không hợp lệ`);
      }
    }
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function buildProfileKey(value = {}) {
  return sha256(
    Object.fromEntries(
      ["ownerScope", ...IDENTITY_FIELDS].map((field) => [
        field,
        String(value[field] || "").trim(),
      ]),
    ),
  );
}

function buildStateHash(value = {}) {
  return sha256(
    Object.fromEntries(
      CONTENT_FIELDS.map((field) => [field, value[field] ?? null]),
    ),
  );
}

function normalizedSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function detectRiskFlags({ mapping = {}, defaults = {}, formulas = {} } = {}) {
  const flags = new Set();
  const entries = [mapping, defaults, formulas].flatMap((group) =>
    Object.entries(plainObject(group)),
  );
  for (const [key, value] of entries) {
    const text = normalizedSearchText(`${key} ${String(value ?? "")}`);
    if (/\b(tk|tai khoan|debit|credit)\b/.test(text)) flags.add("account");
    if (/thue|vat|gtgt/.test(text)) flags.add("vat");
    if (/thanh tien|tong tien|don gia|so tien|amount|total/.test(text)) {
      flags.add("money");
    }
    if (/loai chung tu|phan loai|hang hoa|dich vu|document type/.test(text)) {
      flags.add("document_classification");
    }
    if (/^\s*-|am\/duong|dau am|negative|positive/.test(String(value ?? ""))) {
      flags.add("sign");
    }
  }
  return [...flags].sort();
}

function requiredString(value, field, maximum = 160) {
  const normalized = String(value || "").trim().slice(0, maximum);
  if (!normalized) throw httpError(400, `Mapping profile V2 thiếu ${field}`);
  return normalized;
}

function cleanDraftPayload(payload = {}) {
  const result = {
    name: requiredString(payload.name || "Thiết lập ghép cột", "name"),
    sourceFamily: requiredString(payload.sourceFamily, "sourceFamily"),
    documentType: requiredString(payload.documentType, "documentType", 120),
    headerFingerprint: requiredString(
      payload.headerFingerprint,
      "headerFingerprint",
      128,
    ),
    dataShapeFingerprint: requiredString(
      payload.dataShapeFingerprint,
      "dataShapeFingerprint",
      128,
    ),
    targetTemplateId: requiredString(
      payload.targetTemplateId,
      "targetTemplateId",
      120,
    ),
    targetTemplateVersion: requiredString(
      payload.targetTemplateVersion,
      "targetTemplateVersion",
      128,
    ),
    mapping: plainObject(payload.mapping),
    defaults: plainObject(payload.defaults),
    formulas: plainObject(payload.formulas),
  };
  result.riskFlags = detectRiskFlags(result);
  return result;
}

function assertFamilyIdentityUnchanged(source, patch = {}) {
  const changed = IDENTITY_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(patch, field) &&
      String(patch[field] || "").trim() !== String(source[field] || "").trim(),
  );
  if (changed.length) {
    throw httpError(
      400,
      `Mapping profile identity không thể đổi trong cùng family: ${changed.join(", ")}`,
    );
  }
}

function toPlain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function serializeProfile(profile) {
  if (!profile) return null;
  const value = toPlain(profile);
  return {
    id: String(value._id || value.id),
    ownerScope: value.ownerScope,
    workspaceId: value.workspace ? String(value.workspace._id || value.workspace) : null,
    userId: value.user ? String(value.user._id || value.user) : null,
    profileKey: value.profileKey,
    profileFamilyId: value.profileFamilyId,
    version: value.version,
    status: value.status,
    name: value.name,
    sourceFamily: value.sourceFamily,
    documentType: value.documentType,
    headerFingerprint: value.headerFingerprint,
    dataShapeFingerprint: value.dataShapeFingerprint,
    targetTemplateId: value.targetTemplateId,
    targetTemplateVersion: value.targetTemplateVersion,
    mapping: value.mapping || {},
    defaults: value.defaults || {},
    formulas: value.formulas || {},
    riskFlags: value.riskFlags || [],
    stateHash: value.stateHash,
    previousVersionId: value.previousVersion
      ? String(value.previousVersion._id || value.previousVersion)
      : null,
    confirmationCount: Number(value.confirmationCount || 0),
    lastConfirmedAt: value.lastConfirmedAt || null,
    approvedBy: value.approvedBy
      ? String(value.approvedBy._id || value.approvedBy)
      : null,
    quarantinedAt: value.quarantinedAt || null,
    quarantineReason: value.quarantineReason || "",
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
  };
}

function classifyProfileMatch(profile, requestedIdentity = {}) {
  const candidate = toPlain(profile);
  const conflicts = ["sourceFamily", "documentType", "targetTemplateId"].filter(
    (field) => String(candidate[field]) !== String(requestedIdentity[field]),
  );
  if (conflicts.length) return { tier: "rejected", driftFields: conflicts };

  const driftFields = IDENTITY_FIELDS.filter(
    (field) => String(candidate[field]) !== String(requestedIdentity[field]),
  );
  if (!driftFields.length) return { tier: "exact", driftFields: [] };
  if (
    driftFields.length === 1 &&
    driftFields[0] === "headerFingerprint" &&
    requestedIdentity.headerCompatibility === "safe"
  ) {
    return { tier: "compatible", driftFields };
  }
  return { tier: "review", driftFields };
}

const MATCH_RANK = Object.freeze({ exact: 0, compatible: 1, review: 2, rejected: 3 });

async function matchProfiles({
  model = MappingProfileV2,
  ownerScope,
  identity,
}) {
  const requested = cleanIdentity(identity);
  const candidates = await model.find(
    { ownerScope, status: "active" },
    null,
    { sort: { confirmationCount: -1, version: -1 }, limit: 50 },
  );
  const matches = (candidates || [])
    .map((profile) => ({
      profile,
      ...classifyProfileMatch(profile, requested),
    }))
    .sort((a, b) => MATCH_RANK[a.tier] - MATCH_RANK[b.tier]);
  const best = matches[0];
  if (!best) {
    return {
      tier: "rejected",
      driftFields: [],
      profile: null,
      approvalState: "unapproved",
      approvalAppliesToMatch: false,
      riskFlags: [],
      approvedRiskFlags: [],
      unapprovedRiskFlags: [],
      canSuggest: false,
      requiresPreview: false,
    };
  }

  const profile = serializeProfile(best.profile);
  const riskFlags = [...profile.riskFlags];
  const approvalState = profile.status === "active" && profile.approvedBy
    ? "approved"
    : "unapproved";
  const approvalAppliesToMatch = approvalState === "approved" && best.tier === "exact";
  return {
    tier: best.tier,
    driftFields: best.driftFields,
    profile,
    approvalState,
    approvalAppliesToMatch,
    riskFlags,
    approvedRiskFlags: approvalAppliesToMatch ? riskFlags : [],
    unapprovedRiskFlags: approvalAppliesToMatch ? [] : riskFlags,
    canSuggest: approvalAppliesToMatch,
    requiresPreview: best.tier !== "rejected",
  };
}

function cleanIdentity(value = {}) {
  const identity = Object.fromEntries(
    IDENTITY_FIELDS.map((field) => [
      field,
      requiredString(value[field], field, 160),
    ]),
  );
  identity.headerCompatibility =
    value.headerCompatibility === "safe" ? "safe" : "review";
  return identity;
}

async function createDraft({
  model = MappingProfileV2,
  ownerScope,
  workspace = null,
  user = null,
  createdBy,
  payload,
  legacyProfileId = null,
}) {
  const clean = cleanDraftPayload(payload);
  const document = {
    ownerScope,
    workspace,
    user: user || createdBy,
    profileFamilyId: crypto.randomUUID(),
    version: 1,
    status: "draft",
    ...clean,
    createdBy,
    legacyProfileId,
  };
  document.profileKey = buildProfileKey(document);
  document.stateHash = buildStateHash(document);
  return model.create(document);
}

async function ownedProfile(
  model = MappingProfileV2,
  ownerScope,
  profileId,
  options = {},
) {
  return model.findOne(
    { _id: profileId, ownerScope },
    null,
    options,
  );
}

async function createVersion({
  model = MappingProfileV2,
  ownerScope,
  profileId,
  createdBy,
  patch = {},
}) {
  const source = await ownedProfile(model, ownerScope, profileId);
  if (!source) throw httpError(404, "Không tìm thấy mapping profile V2");
  const sourceValue = toPlain(source);
  assertFamilyIdentityUnchanged(sourceValue, patch);
  const latest = await model.findOne(
    { ownerScope, profileFamilyId: sourceValue.profileFamilyId },
    null,
    { sort: { version: -1 } },
  );
  const latestVersion = Number(toPlain(latest)?.version || 0);
  const clean = cleanDraftPayload({
    ...Object.fromEntries(CONTENT_FIELDS.map((field) => [field, sourceValue[field]])),
    ...patch,
  });
  const document = {
    ownerScope,
    workspace: sourceValue.workspace || null,
    user: sourceValue.user || createdBy,
    profileFamilyId: sourceValue.profileFamilyId,
    version: latestVersion + 1,
    status: "draft",
    ...clean,
    previousVersion: sourceValue._id,
    createdBy,
  };
  document.profileKey = buildProfileKey(document);
  document.stateHash = buildStateHash(document);
  return model.create(document);
}

async function confirmProfile({
  model = MappingProfileV2,
  ownerScope,
  profileId,
  sourceSignatureHash,
  targetTemplateId,
  mapping,
  defaults,
  formulas,
  expectedVersion,
  userCorrection,
  approvedBy,
}) {
  validateConfirmationPayload({ mapping, defaults, formulas, userCorrection });
  const source = await ownedProfile(model, ownerScope, profileId);
  if (!source) throw httpError(404, "Không tìm thấy mapping profile V2");
  const sourceValue = toPlain(source);
  const version = Number(expectedVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw httpError(400, "expectedVersion không hợp lệ");
  }
  if (Number(sourceValue.version) !== version) {
    throw httpError(409, "Mapping profile đã thay đổi; vui lòng tải lại");
  }
  if (!String(sourceSignatureHash || "").trim()) {
    throw httpError(400, "Mapping profile V2 thiếu sourceSignatureHash");
  }
  if (String(sourceValue.headerFingerprint) !== String(sourceSignatureHash)) {
    throw httpError(409, "Source signature không khớp mapping profile");
  }
  if (
    targetTemplateId &&
    String(sourceValue.targetTemplateId) !== String(targetTemplateId)
  ) {
    throw httpError(409, "Target template không khớp mapping profile");
  }

  const draft = await createVersion({
    model,
    ownerScope,
    profileId,
    createdBy: approvedBy,
    patch: {
      mapping,
      defaults,
      formulas,
    },
  });
  const active = await activateProfile({
    model,
    ownerScope,
    profileId: String(draft._id || draft.id),
    stateHash: String(draft.stateHash),
    expectedPreviousVersion:
      sourceValue.status === "active" ? sourceValue.version : null,
    approvedBy,
  });
  return active;
}

function normalizedExpectedVersion(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw httpError(400, "expectedPreviousVersion không hợp lệ");
  }
  return parsed;
}

async function activateProfile({
  model = MappingProfileV2,
  ownerScope,
  profileId,
  stateHash,
  expectedPreviousVersion,
  approvedBy,
}) {
  const expected = normalizedExpectedVersion(expectedPreviousVersion);
  const runInTransaction =
    typeof model.db?.transaction === "function"
      ? (work) => model.db.transaction(work)
      : async (work) => work(null);

  return runInTransaction(async (session) => {
    const target = await ownedProfile(model, ownerScope, profileId, { session });
    const value = toPlain(target);
    if (!value) throw httpError(404, "Không tìm thấy mapping profile V2");
    if (value.status !== "draft" || value.stateHash !== stateHash) {
      throw httpError(409, "Mapping profile đã thay đổi; vui lòng tải lại");
    }
    const current = await model.findOne(
      {
        ownerScope,
        profileFamilyId: value.profileFamilyId,
        status: "active",
      },
      null,
      { session },
    );
    const currentValue = toPlain(current);
    const currentVersion = currentValue ? Number(currentValue.version) : null;
    if (currentVersion !== expected) {
      throw httpError(409, "Phiên bản active đã thay đổi; vui lòng tải lại");
    }
    if (currentValue) {
      const superseded = await model.updateOne(
        {
          _id: currentValue._id,
          ownerScope,
          status: "active",
          version: currentVersion,
        },
        { $set: { status: "superseded" } },
        { session },
      );
      if (Number(superseded.modifiedCount) !== 1) {
        throw httpError(409, "Phiên bản active đã thay đổi; vui lòng tải lại");
      }
    }
    const activated = await model.updateOne(
      {
        _id: value._id,
        ownerScope,
        status: "draft",
        stateHash,
      },
      { $set: { status: "active", approvedBy } },
      { session, runValidators: true },
    );
    if (Number(activated.modifiedCount) !== 1) {
      throw httpError(409, "Mapping profile đã thay đổi; vui lòng tải lại");
    }
    return ownedProfile(model, ownerScope, profileId, { session });
  });
}

async function suspendProfile({
  model = MappingProfileV2,
  ownerScope,
  profileId,
  stateHash,
}) {
  const result = await model.findOneAndUpdate(
    { _id: profileId, ownerScope, status: "active", stateHash },
    { $set: { status: "suspended" } },
    { new: true, runValidators: true },
  );
  if (!result) throw httpError(409, "Mapping profile đã thay đổi; vui lòng tải lại");
  return result;
}

async function quarantineProfile({
  model = MappingProfileV2,
  ownerScope,
  profileId,
  reason,
}) {
  const normalizedReason = String(reason || "semantic_validation_failed")
    .trim()
    .slice(0, 500);
  const profile = await model.findOneAndUpdate(
    { _id: profileId, ownerScope, status: { $in: ["active", "draft"] } },
    {
      $set: {
        status: "quarantined",
        quarantinedAt: new Date(),
        quarantineReason: normalizedReason,
      },
    },
    { new: true, runValidators: true },
  );
  if (!profile) throw httpError(409, "Mapping profile V2 không còn ở trạng thái có thể quarantine");
  return profile;
}

async function listProfiles({ model = MappingProfileV2, ownerScope, status }) {
  const filter = { ownerScope };
  if (status) filter.status = status;
  return model.find(filter, null, { sort: { updatedAt: -1 }, limit: 200 });
}

async function getProfileHistory({
  model = MappingProfileV2,
  ownerScope,
  profileFamilyId,
}) {
  return model.find(
    { ownerScope, profileFamilyId },
    null,
    { sort: { version: -1 }, limit: 200 },
  );
}

async function recordConfirmedExport({
  model = MappingProfileV2,
  ownerScope,
  profileId,
  exportId,
  version,
  stateHash,
  confirmedAt = new Date(),
}) {
  const normalizedExportId = requiredString(exportId, "exportId", 160);
  const normalizedVersion = Number(version);
  if (!Number.isInteger(normalizedVersion) || normalizedVersion < 1) {
    throw httpError(400, "Mapping profile V2 thiếu version hợp lệ");
  }
  const normalizedStateHash = requiredString(stateHash, "stateHash", 128);
  const profile = await model.findOneAndUpdate(
    {
      _id: profileId,
      ownerScope,
      status: "active",
      version: normalizedVersion,
      stateHash: normalizedStateHash,
      confirmedExportIds: { $ne: normalizedExportId },
    },
    {
      $addToSet: { confirmedExportIds: normalizedExportId },
      $inc: { confirmationCount: 1 },
      $set: { lastConfirmedAt: confirmedAt },
    },
    { new: true },
  );
  if (profile) return { profile, recorded: true };
  const existing = await ownedProfile(model, ownerScope, profileId);
  if (!existing) throw httpError(404, "Không tìm thấy mapping profile V2");
  const existingValue = toPlain(existing);
  if (
    existingValue.status !== "active" ||
    Number(existingValue.version) !== normalizedVersion ||
    existingValue.stateHash !== normalizedStateHash
  ) {
    throw httpError(409, "Mapping profile export context đã thay đổi");
  }
  return { profile: existing, recorded: false };
}

module.exports = {
  IDENTITY_FIELDS,
  activateProfile,
  buildProfileKey,
  buildStateHash,
  classifyProfileMatch,
  cleanDraftPayload,
  createDraft,
  createVersion,
  confirmProfile,
  detectRiskFlags,
  getProfileHistory,
  listProfiles,
  matchProfiles,
  ownedProfile,
  quarantineProfile,
  recordConfirmedExport,
  validateConfirmationPayload,
  serializeProfile,
  suspendProfile,
};
