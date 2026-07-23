function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function optionalId(value) {
  if (value == null) return null;
  const normalized = String(value?._id || value).trim();
  return normalized || null;
}

function mappingProfileOwnerFromClaims(claims = {}) {
  const purpose = String(claims.purpose || "");
  const userId = optionalId(claims.user_id);
  const workspaceId = optionalId(claims.workspace_id);

  if (purpose === "student_file_session") {
    const sessionId = String(claims.session_id || "").trim();
    const ownerScope = String(claims.owner_scope || "").trim();
    if (!sessionId || !userId || !ownerScope) {
      throw new Error("Student context thiếu session, user hoặc owner scope");
    }
    if (
      (ownerScope.startsWith("workspace:") &&
        ownerScope !== `workspace:${workspaceId || ""}`) ||
      (ownerScope.startsWith("user:") && ownerScope !== `user:${userId}`) ||
      (!ownerScope.startsWith("workspace:") && !ownerScope.startsWith("user:"))
    ) {
      throw new Error("Student context owner scope không hợp lệ");
    }
    return { ownerScope, userId, workspaceId };
  }

  if (!["misa_conversion", "misa_reconstruction"].includes(purpose)) {
    throw new Error("Conversion context token không hợp lệ");
  }
  if (!workspaceId || !userId) {
    throw new Error("Conversion context thiếu workspace hoặc user");
  }
  return {
    ownerScope: `workspace:${workspaceId}`,
    userId,
    workspaceId,
  };
}

function cleanMappingProfilePayload(body = {}) {
  return {
    name: String(body.name || "Thiết lập ghép cột")
      .trim()
      .slice(0, 160),
    targetTemplateId: String(body.targetTemplateId || "").trim(),
    sourceSignatureHash: String(body.sourceSignatureHash || "").trim(),
    sourceHeaders: Array.isArray(body.sourceHeaders)
      ? body.sourceHeaders
          .filter((item) => item != null)
          .map((item) => String(item).trim())
          .filter(Boolean)
      : [],
    sheetName: String(body.sheetName || "")
      .trim()
      .slice(0, 160),
    headerRow: Math.max(1, Number(body.headerRow) || 1),
    mapping: objectValue(body.mapping),
    defaults: objectValue(body.defaults),
    formulas: objectValue(body.formulas),
    confidence: Math.max(0, Math.min(1, Number(body.confidence) || 0)),
  };
}

function serializeMappingProfile(profile) {
  return {
    id: String(profile._id || profile.id),
    ownerScope: String(profile.ownerScope || ""),
    workspaceId: optionalId(profile.workspace),
    userId: optionalId(profile.user),
    name: profile.name,
    targetTemplateId: profile.targetTemplateId,
    sourceSignatureHash: profile.sourceSignatureHash,
    sourceHeaders: profile.sourceHeaders || [],
    sheetName: profile.sheetName || "",
    headerRow: profile.headerRow || 1,
    mapping: profile.mapping || {},
    defaults: profile.defaults || {},
    formulas: profile.formulas || {},
    confidence: Number(profile.confidence || 0),
    usageCount: Number(profile.usageCount || 0),
    lastUsedAt: profile.lastUsedAt || null,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
  };
}

module.exports = {
  cleanMappingProfilePayload,
  mappingProfileOwnerFromClaims,
  serializeMappingProfile,
};
