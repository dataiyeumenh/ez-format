const SAFE_GROUPING_FIELDS = new Set([
  "invoice_number",
  "invoice_symbol",
  "invoice_date",
  "posting_date",
  "supplier_tax_code",
  "customer_tax_code",
  "purchase_receipt",
]);

const SAFE_FILL_DOWN_FIELDS = new Set([
  ...SAFE_GROUPING_FIELDS,
  "supplier_code",
  "supplier_name",
  "customer_code",
  "customer_name",
  "payment_method",
]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeList(value, allowed) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()))].filter(
    (item) => item && allowed.has(item),
  );
}

function cleanReconstructionProfilePayload(body = {}) {
  const direction = String(body.directionScope || "auto").toLowerCase();
  return {
    name: String(body.name || "Thiết lập tái tạo chứng từ")
      .trim()
      .slice(0, 160),
    sourceSignatureHash: String(body.sourceSignatureHash || "")
      .trim()
      .slice(0, 128),
    compatibleHeaderFingerprint: String(
      body.compatibleHeaderFingerprint || "",
    )
      .trim()
      .slice(0, 128),
    directionScope: ["auto", "purchase", "sales"].includes(direction)
      ? direction
      : "auto",
    groupingKeys: safeList(body.groupingKeys, SAFE_GROUPING_FIELDS),
    fillDownFields: safeList(body.fillDownFields, SAFE_FILL_DOWN_FIELDS),
    fieldRoles: objectValue(body.fieldRoles),
    mapping: objectValue(body.mapping),
    defaults: objectValue(body.defaults),
    formulas: objectValue(body.formulas),
    classificationRules: objectValue(body.classificationRules),
    templateRouting: objectValue(body.templateRouting),
  };
}

function serializeReconstructionProfile(profile) {
  return {
    id: String(profile._id || profile.id),
    workspaceId: String(profile.workspace?._id || profile.workspace),
    name: profile.name,
    sourceSignatureHash: profile.sourceSignatureHash,
    compatibleHeaderFingerprint: profile.compatibleHeaderFingerprint || "",
    directionScope: profile.directionScope || "auto",
    status: profile.status || "draft",
    version: Number(profile.version || 1),
    groupingKeys: profile.groupingKeys || [],
    fillDownFields: profile.fillDownFields || [],
    fieldRoles: profile.fieldRoles || {},
    mapping: profile.mapping || {},
    defaults: profile.defaults || {},
    formulas: profile.formulas || {},
    classificationRules: profile.classificationRules || {},
    templateRouting: profile.templateRouting || {},
    metrics: {
      usageCount: Number(profile.usageCount || 0),
      successCount: Number(profile.successCount || 0),
      reviewCount: Number(profile.reviewCount || 0),
    },
    approvedAt: profile.approvedAt || null,
    activatedAt: profile.activatedAt || null,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
  };
}

module.exports = {
  SAFE_FILL_DOWN_FIELDS,
  SAFE_GROUPING_FIELDS,
  cleanReconstructionProfilePayload,
  serializeReconstructionProfile,
};
