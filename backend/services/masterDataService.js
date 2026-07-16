const crypto = require("crypto");
const { MASTER_DATA_TYPES } = require("../models/MasterDataSnapshot");

const SUPPORTED_MASTER_DATA_TYPES = Object.freeze([...MASTER_DATA_TYPES]);

function textValue(value) {
  return value == null ? "" : String(value).normalize("NFKC").trim();
}

function normalizeCode(value) {
  return textValue(value).toUpperCase();
}

function normalizeName(value) {
  return textValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeTaxCode(value) {
  return textValue(value).toUpperCase().replace(/\s+/g, "");
}

function prepareMasterDataEntries(type, rows) {
  if (!SUPPORTED_MASTER_DATA_TYPES.includes(type)) {
    throw new Error(`Loại danh mục không được hỗ trợ: ${type}`);
  }

  const entries = [];
  const warnings = [];
  const seenCodes = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const code = textValue(row.code);
    const name = textValue(row.name);
    const taxCode = textValue(row.taxCode);
    if (!code && !name && !taxCode) continue;

    const normalizedCode = normalizeCode(code);
    if (normalizedCode && seenCodes.has(normalizedCode)) {
      warnings.push(
        `Mã ${normalizedCode} xuất hiện nhiều lần; chỉ giữ dòng đầu tiên.`,
      );
      continue;
    }
    if (normalizedCode) seenCodes.add(normalizedCode);

    entries.push({
      type,
      code,
      normalizedCode,
      name,
      normalizedName: normalizeName(name),
      taxCode,
      normalizedTaxCode: normalizeTaxCode(taxCode),
      active: row.active !== false,
      attributes:
        row.attributes && typeof row.attributes === "object"
          ? row.attributes
          : {},
    });
  }

  return { entries, warnings };
}

function userCanAccessWorkspace(workspace, userId) {
  if (!workspace || !userId) return false;
  const candidate = String(userId);
  if (String(workspace.owner) === candidate) return true;
  return (workspace.members || []).some(
    (member) => String(member.user) === candidate,
  );
}

function userCanEditWorkspace(workspace, userId) {
  if (!workspace || !userId) return false;
  const candidate = String(userId);
  if (String(workspace.owner) === candidate) return true;
  return (workspace.members || []).some(
    (member) =>
      String(member.user) === candidate &&
      ["owner", "editor"].includes(member.role),
  );
}

function buildSnapshotSetHash(snapshots) {
  const payload = (snapshots || [])
    .map((snapshot) => ({
      type: String(snapshot.type || ""),
      id: String(snapshot.id || snapshot._id || ""),
      sourceFileHash: String(snapshot.sourceFileHash || ""),
    }))
    .sort(
      (left, right) =>
        left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
    );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function buildMasterDataContext({
  workspace,
  snapshots = [],
  entries = [],
  aliases = [],
}) {
  const catalogs = {};
  for (const type of SUPPORTED_MASTER_DATA_TYPES) {
    const snapshot = snapshots.find((item) => String(item.type) === type);
    const typeEntries = entries.filter((item) => String(item.type) === type);
    const typeAliases = aliases.filter((item) => String(item.type) === type);
    if (!snapshot && !typeEntries.length && !typeAliases.length) continue;
    catalogs[type] = {
      snapshot: snapshot
        ? {
            id: String(snapshot._id || snapshot.id),
            sourceFileHash: snapshot.sourceFileHash || "",
            importedAt:
              snapshot.activatedAt ||
              snapshot.updatedAt ||
              snapshot.createdAt ||
              null,
          }
        : null,
      entries: typeEntries.map((item) => ({
        code: item.code || "",
        normalizedCode: item.normalizedCode || "",
        name: item.name || "",
        normalizedName: item.normalizedName || "",
        taxCode: item.taxCode || "",
        normalizedTaxCode: item.normalizedTaxCode || "",
        active: item.active !== false,
        attributes: item.attributes || {},
      })),
      aliases: typeAliases.map((item) => ({
        sourceSystem: item.sourceSystem || "default",
        rawValue: item.rawValue || "",
        normalizedRawValue: item.normalizedRawValue || "",
        targetCode: item.targetCode || "",
        normalizedTargetCode: item.normalizedTargetCode || "",
      })),
    };
  }

  return {
    workspace: {
      id: String(workspace._id || workspace.id),
      name: workspace.name || "",
      taxCode: workspace.taxCode || "",
      misaProduct: workspace.misaProduct || "AMIS",
      accountingRegime: workspace.accountingRegime || "AUTO",
      fiscalYearStartMonth: workspace.fiscalYearStartMonth || 1,
      lockedThroughDate: workspace.lockedThroughDate || null,
    },
    snapshotSetHash: buildSnapshotSetHash(snapshots),
    masterDataRevision: workspace.masterDataRevision || 0,
    catalogs,
  };
}

module.exports = {
  SUPPORTED_MASTER_DATA_TYPES,
  buildMasterDataContext,
  buildSnapshotSetHash,
  normalizeCode,
  normalizeName,
  normalizeTaxCode,
  prepareMasterDataEntries,
  userCanAccessWorkspace,
  userCanEditWorkspace,
};
