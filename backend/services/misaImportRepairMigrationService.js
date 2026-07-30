const MisaImportRepairSession = require("../models/MisaImportRepairSession");

const IDEMPOTENCY_INDEX_FIELDS = Object.freeze({
  user: 1,
  ownerScope: 1,
  idempotencyKey: 1,
});
const LEGACY_IDEMPOTENCY_INDEX_FIELDS = Object.freeze([
  Object.freeze({ user: 1, idempotencyKey: 1 }),
  IDEMPOTENCY_INDEX_FIELDS,
]);

function isNamespaceMissing(error) {
  return error?.code === 26 || error?.codeName === "NamespaceNotFound";
}

function isIndexMissing(error) {
  return error?.code === 27 || error?.codeName === "IndexNotFound";
}

function sameIndexKeys(index, fields) {
  return JSON.stringify(index?.key || {}) === JSON.stringify(fields);
}

function isStringPartialIndex(index) {
  return index?.unique === true &&
    JSON.stringify(index?.partialFilterExpression || {}) ===
      JSON.stringify({ idempotencyKey: { $type: "string" } });
}

async function listIndexes(model) {
  try {
    return await model.collection.indexes();
  } catch (error) {
    if (isNamespaceMissing(error)) return [];
    throw error;
  }
}

async function ensureMisaImportRepairIndexes({ model = MisaImportRepairSession } = {}) {
  if (model.db?.readyState !== 1) {
    return { skipped: true, droppedIndexes: [], unsetNullKeys: 0 };
  }

  const indexes = await listIndexes(model);
  const legacyIndexes = indexes.filter(
    (index) => LEGACY_IDEMPOTENCY_INDEX_FIELDS.some((fields) => sameIndexKeys(index, fields)) &&
      !isStringPartialIndex(index),
  );
  for (const index of legacyIndexes) {
    try {
      await model.collection.dropIndex(index.name);
    } catch (error) {
      if (!isIndexMissing(error)) throw error;
    }
  }

  const unsetResult = await model.updateMany(
    { idempotencyKey: { $type: "null" } },
    { $unset: { idempotencyKey: 1 } },
  );
  await model.createIndexes();
  return {
    skipped: false,
    droppedIndexes: legacyIndexes.map((index) => index.name),
    unsetNullKeys: Number(unsetResult?.modifiedCount || unsetResult?.nModified || 0),
  };
}

module.exports = {
  IDEMPOTENCY_INDEX_FIELDS,
  LEGACY_IDEMPOTENCY_INDEX_FIELDS,
  ensureMisaImportRepairIndexes,
};
