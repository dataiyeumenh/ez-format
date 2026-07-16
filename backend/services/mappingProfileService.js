function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
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
    workspaceId: String(profile.workspace?._id || profile.workspace),
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
  serializeMappingProfile,
};
