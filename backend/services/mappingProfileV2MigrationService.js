const crypto = require("crypto");
const mongoose = require("mongoose");
const MappingProfile = require("../models/MappingProfile");
const MappingProfileV2 = require("../models/MappingProfileV2");
const {
  buildProfileKey,
  buildStateHash,
  detectRiskFlags,
} = require("./mappingProfileV2Service");

const MIGRATION_MODES = new Set(["off", "dry-run", "apply"]);
const OWNER_SCOPE_PATTERN = /^(workspace|user):[a-f\d]{24}$/i;

function normalizedId(value) {
  if (value == null) return "";
  return String(value?._id || value).trim();
}

function inferLegacyDocumentType(targetTemplateId) {
  const value = String(targetTemplateId || "").toLowerCase();
  const direction = /purchase|mua/.test(value) ? "purchase" : /sales|ban/.test(value) ? "sales" : "unknown";
  const nature = /service|dich/.test(value) ? "services" : /goods|hang|bsn/.test(value) ? "goods" : "unknown";
  return `${direction}_${nature}`;
}

function buildMigrationCandidate(profile = {}) {
  const legacyProfileId = normalizedId(profile._id);
  const ownerScope = String(profile.ownerScope || "").trim();
  const targetTemplateId = String(profile.targetTemplateId || "").trim();
  const sourceSignatureHash = String(profile.sourceSignatureHash || "").trim();
  const userId = normalizedId(profile.user || profile.updatedBy);
  const workspaceId = normalizedId(profile.workspace);
  const reasons = [];

  if (!mongoose.isValidObjectId(legacyProfileId)) reasons.push("invalid_legacy_id");
  if (!OWNER_SCOPE_PATTERN.test(ownerScope)) reasons.push("invalid_owner_scope");
  if (!targetTemplateId) reasons.push("missing_target_template");
  if (!sourceSignatureHash) reasons.push("missing_source_signature");
  if (!mongoose.isValidObjectId(userId)) reasons.push("missing_profile_user");
  if (
    ownerScope.startsWith("workspace:") &&
    (!mongoose.isValidObjectId(workspaceId) || ownerScope !== `workspace:${workspaceId}`)
  ) {
    reasons.push("workspace_owner_mismatch");
  }
  if (ownerScope.startsWith("user:") && ownerScope !== `user:${userId}`) {
    reasons.push("user_owner_mismatch");
  }

  const mapping = profile.mapping && typeof profile.mapping === "object" ? profile.mapping : {};
  const defaults = profile.defaults && typeof profile.defaults === "object" ? profile.defaults : {};
  const formulas = profile.formulas && typeof profile.formulas === "object" ? profile.formulas : {};
  const riskFlags = detectRiskFlags({ mapping, defaults, formulas });
  if (riskFlags.length) reasons.push("high_risk_legacy_profile");

  if (reasons.length) {
    return {
      action: "quarantine",
      legacyProfileId,
      ownerScope,
      reasons: [...new Set(reasons)],
      riskFlags,
    };
  }

  const document = {
    ownerScope,
    workspace: workspaceId || null,
    user: userId,
    profileFamilyId: crypto.randomUUID(),
    version: 1,
    status: "draft",
    name: String(profile.name || "Mapping profile V1 migrated")
      .trim()
      .slice(0, 160),
    sourceFamily: `legacy:${sourceSignatureHash}`.slice(0, 160),
    documentType: inferLegacyDocumentType(targetTemplateId),
    headerFingerprint: sourceSignatureHash.slice(0, 128),
    dataShapeFingerprint: "legacy:missing",
    targetTemplateId: targetTemplateId.slice(0, 120),
    targetTemplateVersion: "legacy:unknown",
    mapping,
    defaults,
    formulas,
    riskFlags: [],
    confirmationCount: 0,
    createdBy: userId,
    legacyProfileId,
  };
  document.profileKey = buildProfileKey(document);
  document.stateHash = buildStateHash(document);
  return { action: "migrate", legacyProfileId, document };
}

async function readLegacyProfiles(sourceModel) {
  const query = sourceModel.find({});
  return typeof query?.lean === "function" ? query.lean() : query;
}

function emptyReport(mode) {
  return {
    mode,
    skipped: mode === "off",
    scanned: 0,
    planned: 0,
    created: 0,
    skippedExisting: 0,
    quarantined: 0,
    quarantinePersisted: 0,
    quarantine: [],
  };
}

async function migrateMappingProfilesV1ToV2({
  sourceModel = MappingProfile,
  targetModel = MappingProfileV2,
  mode = process.env.MAPPING_PROFILE_V2_MIGRATION_MODE || "off",
} = {}) {
  const normalizedMode = String(mode || "off").trim().toLowerCase();
  if (!MIGRATION_MODES.has(normalizedMode)) {
    throw new Error("MAPPING_PROFILE_V2_MIGRATION_MODE phải là off, dry-run hoặc apply");
  }
  const report = emptyReport(normalizedMode);
  if (normalizedMode === "off") return report;

  const profiles = await readLegacyProfiles(sourceModel);
  report.scanned = profiles.length;
  for (const profile of profiles) {
    const candidate = buildMigrationCandidate(profile);
    if (candidate.action === "quarantine") {
      report.quarantined += 1;
      report.quarantine.push({
        legacyProfileId: candidate.legacyProfileId,
        ownerScope: candidate.ownerScope,
        reasons: candidate.reasons,
        riskFlags: candidate.riskFlags,
      });
      if (
        normalizedMode === "apply" &&
        mongoose.isValidObjectId(candidate.legacyProfileId)
      ) {
        if (typeof sourceModel.updateOne !== "function") {
          throw new Error("Legacy mapping profile model không hỗ trợ quarantine persistence");
        }
        await sourceModel.updateOne(
          { _id: profile._id },
          {
            $set: {
              status: "quarantined",
              quarantinedAt: new Date(),
              quarantineReason: candidate.reasons.join(","),
            },
          },
        );
        report.quarantinePersisted += 1;
      }
      continue;
    }
    const exists = await targetModel.exists({
      legacyProfileId: candidate.legacyProfileId,
    });
    if (exists) {
      report.skippedExisting += 1;
      continue;
    }
    report.planned += 1;
    if (normalizedMode === "dry-run") continue;
    try {
      await targetModel.create(candidate.document);
      report.created += 1;
    } catch (error) {
      if (error?.code === 11000) {
        report.skippedExisting += 1;
        continue;
      }
      throw error;
    }
  }
  return report;
}

async function ensureMappingProfileV2Indexes({ model = MappingProfileV2 } = {}) {
  if (typeof model.createIndexes !== "function") {
    throw new Error("MappingProfileV2 model không hỗ trợ createIndexes");
  }
  const indexes = await model.createIndexes();
  return { indexes: Array.isArray(indexes) ? indexes : [] };
}

module.exports = {
  MIGRATION_MODES,
  buildMigrationCandidate,
  ensureMappingProfileV2Indexes,
  inferLegacyDocumentType,
  migrateMappingProfilesV1ToV2,
};
