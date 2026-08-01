const crypto = require("node:crypto");
const { compose, Transform } = require("node:stream");
const mongoose = require("mongoose");
const ConversionArtifact = require("../models/ConversionArtifact");
const {
  assertMongoGridFsConfigured,
  createMongoGridFsArtifactStorage,
  configuredMaxBytes,
} = require("./mongoGridFsArtifactStorage");

const conversionOperationLifecycleSchema = new mongoose.Schema(
  {
    operationKey: { type: String, required: true, trim: true, immutable: true },
    operationKeys: {
      type: [{
        _id: false,
        keyId: { type: String, required: true, immutable: true },
        operationKey: { type: String, required: true, immutable: true },
      }],
      default: [],
    },
    requiredPreviousKeyIds: { type: [String], default: [] },
    keyRingRetainUntil: { type: Date, default: null },
    status: {
      type: String,
      enum: ["active", "purging", "purged"],
      default: "active",
      required: true,
      index: true,
    },
    writeLeases: {
      type: [{
        _id: false,
        leaseId: { type: String, required: true, immutable: true },
        leaseExpiresAt: { type: Date, required: true },
      }],
      default: [],
    },
    purgeStartedAt: { type: Date, default: null },
    purgedAt: { type: Date, default: null },
    retainUntil: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversionOperationLifecycleSchema.index(
  { operationKey: 1 },
  { name: "operationKey_1", unique: true },
);
conversionOperationLifecycleSchema.index(
  { "operationKeys.operationKey": 1 },
  { name: "conversion_operation_key_alias_unique", unique: true, sparse: true },
);
conversionOperationLifecycleSchema.index(
  { purgeAt: 1 },
  {
    name: "conversion_operation_purged_ttl",
    expireAfterSeconds: 0,
    partialFilterExpression: { status: "purged" },
  },
);

const ConversionOperationLifecycle = mongoose.models.ConversionOperationLifecycle ||
  mongoose.model("ConversionOperationLifecycle", conversionOperationLifecycleSchema);

const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIFECYCLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STUDENT_CONTEXT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WRITE_INTENT_TIMEOUT_MS = 15 * 60 * 1000;
const LEGACY_LIFECYCLE_BINDING_FIELDS = [
  "ownerScope",
  "userId",
  "sessionId",
  "uploadId",
  "runId",
  "targetTemplateId",
];
const LEGACY_LIFECYCLE_UNIQUE_INDEX =
  "ownerScope_1_userId_1_sessionId_1_uploadId_1_runId_1_targetTemplateId_1";
const LEGACY_OPERATION_KEY_INDEX = "operationKey_1";
const LIFECYCLE_KEY_CANARY_CONTEXT = "ez-format:artifact-lifecycle-key-canary:v1";
const LIFECYCLE_KEY_CANARY_RECORD = "artifact_lifecycle_key_canary";
const LEGACY_LIFECYCLE_INDEX_KEY = Object.fromEntries(
  LEGACY_LIFECYCLE_BINDING_FIELDS.map((field) => [field, 1]),
);
const ARTIFACT_KINDS = new Set(["analysis", "upload", "output", "state", "manifest", "import_result", "repair_state", "retry_output"]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const OWNER_SCOPE = /^(user|workspace):[A-Za-z0-9_-]{1,160}$/;

function storageError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!SAFE_IDENTIFIER.test(normalized)) throw storageError(400, `${label} is invalid`, "INVALID_ARTIFACT_BINDING");
  return normalized;
}

function normalizeOwnerScope(value) {
  const normalized = String(value || "").trim();
  if (!OWNER_SCOPE.test(normalized)) throw storageError(400, "Artifact owner scope is invalid", "INVALID_ARTIFACT_OWNER");
  return normalized;
}

function plain(document) {
  return document && typeof document.toObject === "function" ? document.toObject() : document;
}

function artifactLifecycleSecret(explicitSecret) {
  const secret = String(
    explicitSecret || process.env.ARTIFACT_LIFECYCLE_HMAC_SECRET ||
    process.env.CONVERSION_CONTEXT_SECRET || "",
  ).trim();
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("ARTIFACT_LIFECYCLE_HMAC_SECRET must contain at least 32 bytes");
  }
  return secret;
}

function parsePreviousLifecycleKeys(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("ARTIFACT_LIFECYCLE_HMAC_PREVIOUS_KEYS must be a JSON object");
  }
}

function artifactLifecycleKeyRing({
  hmacSecret,
  activeKeyId = process.env.ARTIFACT_LIFECYCLE_HMAC_ACTIVE_KEY_ID || "v1",
  previousKeys = process.env.ARTIFACT_LIFECYCLE_HMAC_PREVIOUS_KEYS || "{}",
  rotationHorizon = process.env.ARTIFACT_LIFECYCLE_HMAC_ROTATION_HORIZON,
  now = () => new Date(),
} = {}) {
  const normalizedActiveKeyId = String(activeKeyId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(normalizedActiveKeyId)) {
    throw new Error("ARTIFACT_LIFECYCLE_HMAC_ACTIVE_KEY_ID is invalid");
  }
  const entries = [{ keyId: normalizedActiveKeyId, secret: artifactLifecycleSecret(hmacSecret) }];
  for (const [rawKeyId, rawSecret] of Object.entries(parsePreviousLifecycleKeys(previousKeys))) {
    const keyId = String(rawKeyId || "").trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || keyId === normalizedActiveKeyId) {
      throw new Error("ARTIFACT_LIFECYCLE_HMAC_PREVIOUS_KEYS contains an invalid key id");
    }
    const secret = String(rawSecret || "").trim();
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Every previous artifact lifecycle HMAC key must contain at least 32 bytes");
    }
    entries.push({ keyId, secret });
  }
  if (new Set(entries.map(({ secret }) => secret)).size !== entries.length) {
    throw new Error("Artifact lifecycle HMAC key ids must use distinct secrets");
  }
  const horizonText = String(rotationHorizon || "").trim();
  const horizon = horizonText ? new Date(horizonText) : null;
  if (horizon && Number.isNaN(horizon.getTime())) {
    throw new Error("ARTIFACT_LIFECYCLE_HMAC_ROTATION_HORIZON is invalid");
  }
  if (entries.length > 1 && !horizon) {
    throw new Error("ARTIFACT_LIFECYCLE_HMAC_ROTATION_HORIZON is required during key rotation");
  }
  if (horizon && horizon > now() && entries.length === 1) {
    throw new Error("Previous lifecycle key cannot be removed before the retention horizon");
  }
  return {
    activeKeyId: normalizedActiveKeyId,
    entries,
    previousKeyIds: entries.slice(1).map(({ keyId }) => keyId),
    rotationHorizon: horizon,
  };
}

function lifecycleAliases(binding, keyRing) {
  const canonical = [
    binding.ownerScope,
    binding.userId,
    binding.sessionId,
    binding.uploadId,
    binding.runId,
    binding.targetTemplateId,
  ].join("\0");
  return keyRing.entries.map(({ keyId, secret }) => ({
    keyId,
    operationKey: crypto.createHmac("sha256", secret).update(canonical).digest("hex"),
  }));
}

function lifecycleCompatibilityAlias(binding, keyRing) {
  const compatibilityKeyId = keyRing.entries[1]?.keyId || keyRing.activeKeyId;
  return lifecycleAliases(binding, keyRing).find(({ keyId }) => keyId === compatibilityKeyId);
}

function lifecycleFilter(binding, keyRing) {
  const operationKeys = lifecycleAliases(binding, keyRing).map(({ operationKey }) => operationKey);
  return {
    $or: [
      { operationKey: { $in: operationKeys } },
      { "operationKeys.operationKey": { $in: operationKeys } },
    ],
  };
}

function lifecycleKeyFingerprint(keyId, secret) {
  return crypto.createHmac("sha256", secret)
    .update(`${LIFECYCLE_KEY_CANARY_CONTEXT}\0${keyId}`)
    .digest("hex");
}

function lifecycleKeyCanaryId(keyId) {
  return new mongoose.Types.ObjectId(
    crypto.createHash("sha256")
      .update(`${LIFECYCLE_KEY_CANARY_RECORD}\0${keyId}`)
      .digest()
      .subarray(0, 12),
  );
}

async function assertArtifactLifecycleKeyCanaries({
  model,
  keyRing,
  persistMissing = true,
  now = () => new Date(),
}) {
  const collection = model?.collection;
  if (!collection?.updateOne || !collection?.findOne || !collection?.find) {
    throw new Error("MongoDB lifecycle collection is required for lifecycle key canaries");
  }
  const observedByKeyId = new Map();
  for (const { keyId, secret } of keyRing.entries) {
    const _id = lifecycleKeyCanaryId(keyId);
    const keyFingerprint = lifecycleKeyFingerprint(keyId, secret);
    const observed = await collection.findOne(
      { _id },
      { projection: { recordType: 1, keyId: 1, keyFingerprint: 1, requiredUntil: 1 } },
    );
    observedByKeyId.set(keyId, observed);
    if (!observed && keyRing.previousKeyIds.includes(keyId)) {
      throw new Error(
        `Previous artifact lifecycle key canary ${keyId} is missing; deploy a one-key canary bootstrap first`,
      );
    }
    if (observed && (
      observed.recordType !== LIFECYCLE_KEY_CANARY_RECORD ||
      observed.keyId !== keyId ||
      observed.keyFingerprint !== keyFingerprint
    )) {
      throw new Error(`Artifact lifecycle key id ${keyId} uses different secret material`);
    }
    const observedRequiredUntil = observed?.requiredUntil == null
      ? null
      : new Date(observed.requiredUntil);
    if (observedRequiredUntil && Number.isNaN(observedRequiredUntil.getTime())) {
      throw new Error("Artifact lifecycle key canary is invalid");
    }
    if (
      observedRequiredUntil &&
      keyRing.previousKeyIds.includes(keyId) &&
      observedRequiredUntil > keyRing.rotationHorizon
    ) {
      throw new Error("Artifact lifecycle key rotation horizon cannot be shortened");
    }
  }

  for (const { keyId, secret } of keyRing.entries) {
    const _id = lifecycleKeyCanaryId(keyId);
    const keyFingerprint = lifecycleKeyFingerprint(keyId, secret);
    const operationKey = crypto.createHash("sha256")
      .update(`${LIFECYCLE_KEY_CANARY_RECORD}:operation\0${keyId}`)
      .digest("hex");
    let observed = observedByKeyId.get(keyId);
    if (!observed && !persistMissing) continue;
    if (!observed) {
      try {
        await collection.updateOne(
          { _id, recordType: LIFECYCLE_KEY_CANARY_RECORD, keyId },
          {
            $setOnInsert: {
              recordType: LIFECYCLE_KEY_CANARY_RECORD,
              keyId,
              keyFingerprint,
              operationKey,
              operationKeys: [],
            },
          },
          { upsert: true },
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
      observed = await collection.findOne(
        { _id },
        { projection: { recordType: 1, keyId: 1, keyFingerprint: 1, requiredUntil: 1 } },
      );
    }
    if (
      observed?.recordType !== LIFECYCLE_KEY_CANARY_RECORD ||
      observed?.keyId !== keyId ||
      observed?.keyFingerprint !== keyFingerprint
    ) {
      throw new Error(`Artifact lifecycle key id ${keyId} uses different secret material`);
    }
    if (persistMissing && keyRing.previousKeyIds.includes(keyId)) {
      const result = await collection.updateOne(
        { _id, recordType: LIFECYCLE_KEY_CANARY_RECORD, keyId, keyFingerprint },
        { $max: { requiredUntil: keyRing.rotationHorizon } },
      );
      if (Number(result?.matchedCount) !== 1) {
        throw new Error("Previous artifact lifecycle key canary could not be retained");
      }
    }
  }

  const persisted = await collection.find(
    { recordType: LIFECYCLE_KEY_CANARY_RECORD },
    { projection: { recordType: 1, keyId: 1, keyFingerprint: 1, requiredUntil: 1 } },
  ).toArray();
  if (!Array.isArray(persisted)) {
    throw new Error("MongoDB lifecycle key canary scan returned an invalid result");
  }
  const configuredKeyIds = new Set(keyRing.entries.map(({ keyId }) => keyId));
  const currentTime = now();
  for (const canary of persisted) {
    const requiredUntil = canary?.requiredUntil == null
      ? null
      : new Date(canary.requiredUntil);
    if (
      canary?.recordType !== LIFECYCLE_KEY_CANARY_RECORD ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(String(canary?.keyId || "")) ||
      !/^[a-f0-9]{64}$/.test(String(canary?.keyFingerprint || "")) ||
      (requiredUntil && Number.isNaN(requiredUntil.getTime()))
    ) {
      throw new Error("Artifact lifecycle key canary is invalid");
    }
    if (
      !configuredKeyIds.has(canary.keyId) &&
      requiredUntil && requiredUntil > currentTime
    ) {
      throw new Error("Previous lifecycle key cannot be removed before the retention horizon");
    }
  }
}

function lifecycleWriteError(message = "Operation session is no longer writable") {
  return storageError(410, message, "ARTIFACT_OPERATION_PURGED");
}

function normalizeArtifactLifecycleMigrationMode(value = "off") {
  const mode = String(value || "off").trim().toLowerCase();
  if (!new Set(["off", "dry-run", "apply"]).has(mode)) {
    throw new Error("ARTIFACT_LIFECYCLE_MIGRATION_MODE must be off, dry-run, or apply");
  }
  return mode;
}

function legacyLifecycleFilter(afterId) {
  const filter = {
    recordType: { $ne: LIFECYCLE_KEY_CANARY_RECORD },
    $or: [
      ...LEGACY_LIFECYCLE_BINDING_FIELDS.map((field) => ({ [field]: { $exists: true } })),
      { "writeLeases.expiresAt": { $exists: true } },
      { operationKeys: { $exists: false } },
    ],
  };
  if (afterId != null) filter._id = { $gt: afterId };
  return filter;
}

function sameIndexKey(actual, expected) {
  const actualEntries = Object.entries(actual || {});
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length &&
    actualEntries.every(([field, direction], index) =>
      field === expectedEntries[index][0] && direction === expectedEntries[index][1]
    );
}

async function readCollectionIndexes(collection) {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

function inspectLegacyLifecycleIndex(indexes) {
  const named = indexes.find((index) => index.name === LEGACY_LIFECYCLE_UNIQUE_INDEX);
  if (named && (named.unique !== true || !sameIndexKey(named.key, LEGACY_LIFECYCLE_INDEX_KEY))) {
    throw new Error("Legacy lifecycle index contract does not match the exact removable unique index");
  }
  const unexpected = indexes.find((index) =>
    index.name !== LEGACY_LIFECYCLE_UNIQUE_INDEX &&
    index.unique === true &&
    sameIndexKey(index.key, LEGACY_LIFECYCLE_INDEX_KEY)
  );
  if (unexpected) {
    throw new Error("Legacy lifecycle index contract uses an unexpected index name");
  }
  return named || null;
}

function inspectLegacyOperationKeyIndex(indexes) {
  const expectedKey = { operationKey: 1 };
  const named = indexes.find((index) => index.name === LEGACY_OPERATION_KEY_INDEX);
  if (named && (named.unique !== true || !sameIndexKey(named.key, expectedKey))) {
    throw new Error("Legacy operation key index contract does not match the exact removable unique index");
  }
  const unexpected = indexes.find((index) =>
    index.name !== LEGACY_OPERATION_KEY_INDEX &&
    index.unique === true &&
    sameIndexKey(index.key, expectedKey)
  );
  if (unexpected) {
    throw new Error("Legacy operation key index contract uses an unexpected index name");
  }
  return named || null;
}

function lifecycleMigrationError(message, report) {
  const error = new Error(message);
  error.code = "ARTIFACT_LIFECYCLE_MIGRATION_FAILED";
  error.report = { ...report, status: "failed", reason: message };
  return error;
}

async function migrateConversionOperationLifecycles({
  model = ConversionOperationLifecycle,
  mode: requestedMode = process.env.ARTIFACT_LIFECYCLE_MIGRATION_MODE,
  hmacSecret,
  activeKeyId,
  previousKeys,
  rotationHorizon,
  now = () => new Date(),
  batchSize = process.env.ARTIFACT_LIFECYCLE_MIGRATION_BATCH_SIZE || 100,
  maxTotal = process.env.ARTIFACT_LIFECYCLE_MIGRATION_MAX_TOTAL || 100_000,
  maxDurationMs = process.env.ARTIFACT_LIFECYCLE_MIGRATION_MAX_DURATION_MS || 60_000,
  lifecycleRetentionMs = DEFAULT_LIFECYCLE_RETENTION_MS,
} = {}) {
  const mode = normalizeArtifactLifecycleMigrationMode(requestedMode);
  if (mode === "off") return { mode, status: "skipped" };

  const collection = model?.collection;
  if (!collection?.find || !collection?.countDocuments || !collection?.indexes) {
    throw new Error("MongoDB lifecycle collection is required for artifact lifecycle migration");
  }
  const indexes = await readCollectionIndexes(collection);
  const oldIndex = inspectLegacyLifecycleIndex(indexes);
  const oldOperationKeyIndex = inspectLegacyOperationKeyIndex(indexes);
  const legacyDocuments = await collection.countDocuments(legacyLifecycleFilter());
  const report = {
    mode,
    status: mode === "dry-run" ? "dry-run" : "running",
    legacyDocuments,
    migratedDocuments: 0,
    remainingLegacyDocuments: legacyDocuments,
    oldUniqueIndexPresent: Boolean(oldIndex),
    oldOperationKeyIndexPresent: Boolean(oldOperationKeyIndex),
    droppedIndexes: [],
  };
  if (mode === "dry-run") return report;

  const keyRing = artifactLifecycleKeyRing({
    hmacSecret,
    activeKeyId,
    previousKeys,
    rotationHorizon,
    now,
  });
  await assertArtifactLifecycleKeyCanaries({ model, keyRing, persistMissing: false, now });
  const boundedBatchSize = Math.min(Math.max(Number(batchSize) || 100, 1), 1000);
  const boundedMaxTotal = Math.min(Math.max(Number(maxTotal) || 100_000, 1), 10_000_000);
  const boundedMaxDurationMs = Math.min(Math.max(Number(maxDurationMs) || 60_000, 100), 60 * 60 * 1000);
  const boundedRetentionMs = Math.max(
    Number(lifecycleRetentionMs) || DEFAULT_LIFECYCLE_RETENTION_MS,
    MAX_STUDENT_CONTEXT_LIFETIME_MS,
  );
  const startedAt = Date.now();
  const assertBudget = (additional = 0) => {
    if (report.migratedDocuments + additional > boundedMaxTotal) {
      throw lifecycleMigrationError("Artifact lifecycle migration exceeded max-total", report);
    }
    if (Date.now() - startedAt > boundedMaxDurationMs) {
      throw lifecycleMigrationError("Artifact lifecycle migration exceeded max-duration", report);
    }
  };

  let afterId = null;
  while (true) {
    assertBudget();
    const documents = await collection.find(
      legacyLifecycleFilter(afterId),
      { projection: Object.fromEntries(["_id", "operationKey", "operationKeys", "status", "writeLeases", "retainUntil", "keyRingRetainUntil", "purgeAt", ...LEGACY_LIFECYCLE_BINDING_FIELDS].map((field) => [field, 1])) },
    ).sort({ _id: 1 }).limit(boundedBatchSize).toArray();
    if (!documents.length) break;
    assertBudget(documents.length);
    const observedAt = now();
    const operations = documents.map((document) => {
      const hasRawBinding = LEGACY_LIFECYCLE_BINDING_FIELDS.some((field) => Object.hasOwn(document, field));
      let operationKeys = Array.isArray(document.operationKeys)
        ? document.operationKeys.map((alias) => ({
          keyId: String(alias.keyId || "").trim(),
          operationKey: String(alias.operationKey || "").trim(),
        }))
        : [];
      if (hasRawBinding) {
        for (const field of LEGACY_LIFECYCLE_BINDING_FIELDS) {
          if (!String(document[field] || "").trim()) {
            throw lifecycleMigrationError(`Legacy lifecycle binding is missing ${field}`, report);
          }
        }
        const expectedAliases = lifecycleAliases(document, keyRing);
        const legacyKey = String(document.operationKey || "").trim();
        if (legacyKey && !expectedAliases.some(({ operationKey }) => operationKey === legacyKey)) {
          throw lifecycleMigrationError("Legacy lifecycle HMAC does not match its binding", report);
        }
        operationKeys = expectedAliases;
      } else if (!operationKeys.length) {
        const legacyKey = String(document.operationKey || "").trim();
        const compatibilityKeyId = keyRing.entries[1]?.keyId || keyRing.activeKeyId;
        operationKeys = [{ keyId: compatibilityKeyId, operationKey: legacyKey }];
      }
      if (!operationKeys.length || operationKeys.some(({ keyId, operationKey }) =>
        !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || !/^[a-f0-9]{64}$/.test(operationKey)
      )) {
        throw lifecycleMigrationError("Legacy lifecycle operation key is unavailable", report);
      }
      if (!["active", "purging", "purged"].includes(document.status)) {
        throw lifecycleMigrationError("Legacy lifecycle status is invalid", report);
      }
      const compatibilityKeyId = keyRing.entries[1]?.keyId || keyRing.activeKeyId;
      const compatibilityAlias = operationKeys.find(({ keyId }) => keyId === compatibilityKeyId);
      const operationKey = String(document.operationKey || compatibilityAlias?.operationKey || "").trim();
      if (!/^[a-f0-9]{64}$/.test(operationKey)) {
        throw lifecycleMigrationError("Legacy lifecycle compatibility key is unavailable", report);
      }
      const set = { operationKey, operationKeys };
      if (keyRing.previousKeyIds.length) {
        set.requiredPreviousKeyIds = keyRing.previousKeyIds;
        set.keyRingRetainUntil = keyRing.rotationHorizon;
      }
      if (Array.isArray(document.writeLeases)) {
        set.writeLeases = document.writeLeases.map((lease) => {
          const leaseExpiresAt = new Date(lease.leaseExpiresAt || lease.expiresAt);
          if (!String(lease.leaseId || "").trim() || Number.isNaN(leaseExpiresAt.getTime())) {
            throw lifecycleMigrationError("Legacy lifecycle write lease is invalid", report);
          }
          return { leaseId: String(lease.leaseId), leaseExpiresAt };
        });
      }
      if (document.status === "purged") {
        const safePurgeAt = observedAt.getTime() + boundedRetentionMs;
        const retainUntil = new Date(document.retainUntil || 0).getTime();
        const keyRingRetainUntil = new Date(document.keyRingRetainUntil || 0).getTime();
        const currentPurgeAt = new Date(document.purgeAt || 0).getTime();
        set.purgeAt = new Date(Math.max(
          safePurgeAt,
          Number.isNaN(retainUntil) ? 0 : retainUntil,
          Number.isNaN(keyRingRetainUntil) ? 0 : keyRingRetainUntil,
          Number.isNaN(currentPurgeAt) ? 0 : currentPurgeAt,
        ));
      }
      return { updateOne: { filter: { _id: document._id }, update: { $set: set } } };
    });
    const result = await collection.bulkWrite(operations, { ordered: true });
    if (Number(result?.matchedCount) !== operations.length) {
      throw lifecycleMigrationError("Artifact lifecycle backfill lost a concurrent document", report);
    }
    report.migratedDocuments += operations.length;
    afterId = documents.at(-1)._id;
  }

  if (oldIndex) {
    await collection.dropIndex(LEGACY_LIFECYCLE_UNIQUE_INDEX);
    report.droppedIndexes.push(LEGACY_LIFECYCLE_UNIQUE_INDEX);
  }
  await assertArtifactLifecycleKeyCanaries({ model, keyRing, now });
  afterId = null;
  while (true) {
    assertBudget();
    const documents = await collection.find(
      {
        $or: LEGACY_LIFECYCLE_BINDING_FIELDS.map((field) => ({ [field]: { $exists: true } })),
        ...(afterId == null ? {} : { _id: { $gt: afterId } }),
      },
      { projection: { _id: 1 } },
    ).sort({ _id: 1 }).limit(boundedBatchSize).toArray();
    if (!documents.length) break;
    const operations = documents.map((document) => ({
      updateOne: {
        filter: { _id: document._id, "operationKeys.0": { $exists: true } },
        update: {
          $unset: Object.fromEntries(
            LEGACY_LIFECYCLE_BINDING_FIELDS.map((field) => [field, ""]),
          ),
        },
      },
    }));
    const result = await collection.bulkWrite(operations, { ordered: true });
    if (Number(result?.matchedCount) !== operations.length) {
      throw lifecycleMigrationError("Artifact lifecycle identifier minimization was incomplete", report);
    }
    afterId = documents.at(-1)._id;
  }

  report.remainingLegacyDocuments = await collection.countDocuments(legacyLifecycleFilter());
  if (report.remainingLegacyDocuments !== 0) {
    throw lifecycleMigrationError("Artifact lifecycle migration left legacy records", report);
  }
  await model.createIndexes();
  report.status = "applied";
  return report;
}

async function assertArtifactLifecycleKeyCoverage({
  model = ConversionOperationLifecycle,
  hmacSecret,
  activeKeyId,
  previousKeys,
  rotationHorizon,
  now = () => new Date(),
} = {}) {
  const keyRing = artifactLifecycleKeyRing({
    hmacSecret,
    activeKeyId,
    previousKeys,
    rotationHorizon,
    now,
  });
  await assertArtifactLifecycleKeyCanaries({ model, keyRing, now });
  if (typeof model?.countDocuments !== "function") {
    throw new Error("MongoDB lifecycle model is required for lifecycle key coverage");
  }
  const configuredKeyIds = keyRing.entries.map(({ keyId }) => keyId);
  const unsafe = await model.countDocuments({
    $or: [
      {
        status: { $in: ["active", "purging"] },
        operationKeys: { $not: { $elemMatch: { keyId: { $in: configuredKeyIds } } } },
      },
      {
        keyRingRetainUntil: { $gt: now() },
        requiredPreviousKeyIds: { $elemMatch: { $nin: configuredKeyIds } },
      },
    ],
  });
  if (unsafe > 0) {
    throw new Error("Previous lifecycle key cannot be removed before the retention horizon");
  }
  return { checked: true, configuredKeyIds: configuredKeyIds.length };
}

function createMongooseOperationLifecycleRepository(Model = ConversionOperationLifecycle, {
  hmacSecret,
  activeKeyId,
  previousKeys,
  rotationHorizon,
  leaseLifetimeMs = 30_000,
  lifecycleRetentionMs = DEFAULT_LIFECYCLE_RETENTION_MS,
} = {}) {
  const keyRing = artifactLifecycleKeyRing({
    hmacSecret,
    activeKeyId,
    previousKeys,
    rotationHorizon,
  });
  let keyCanariesReady;
  const assertKeyCanaries = () => {
    if (!keyCanariesReady) {
      keyCanariesReady = assertArtifactLifecycleKeyCanaries({ model: Model, keyRing });
    }
    return keyCanariesReady;
  };
  const boundedLeaseLifetimeMs = Math.min(
    Math.max(Number(leaseLifetimeMs) || 30_000, 100),
    15 * 60 * 1000,
  );
  const boundedLifecycleRetentionMs = Math.max(
    Number(lifecycleRetentionMs) || DEFAULT_LIFECYCLE_RETENTION_MS,
    24 * 60 * 60 * 1000,
  );
  const withLeaseCount = (document, leaseId) => {
    const value = plain(document);
    if (!value) return value;
    return {
      ...value,
      activeLeases: value.writeLeases?.length || 0,
      leaseId,
      leaseLifetimeMs: boundedLeaseLifetimeMs,
    };
  };
  const aliasUpdate = (binding) => {
    const update = {
      $set: {
        operationKey: lifecycleCompatibilityAlias(binding, keyRing).operationKey,
      },
      $addToSet: {
        operationKeys: { $each: lifecycleAliases(binding, keyRing) },
      },
    };
    if (keyRing.previousKeyIds.length) {
      update.$addToSet.requiredPreviousKeyIds = { $each: keyRing.previousKeyIds };
      update.$max = { keyRingRetainUntil: keyRing.rotationHorizon };
    }
    return update;
  };
  const mergeUpdates = (...updates) => {
    const merged = {};
    for (const update of updates) {
      for (const [operator, value] of Object.entries(update || {})) {
        merged[operator] = { ...(merged[operator] || {}), ...value };
      }
    }
    return merged;
  };
  return {
    async find(binding, now = new Date()) {
      await assertKeyCanaries();
      const document = await Model.findOneAndUpdate(
        lifecycleFilter(binding, keyRing),
        mergeUpdates(
          { $pull: { writeLeases: { leaseExpiresAt: { $lte: now } } } },
          aliasUpdate(binding),
        ),
        { new: true },
      );
      return withLeaseCount(document);
    },
    async acquireWriteLease(binding, { retainUntil } = {}) {
      await assertKeyCanaries();
      const leaseId = crypto.randomUUID();
      const lease = {
        leaseId,
        leaseExpiresAt: new Date(Date.now() + boundedLeaseLifetimeMs),
      };
      const filter = { ...lifecycleFilter(binding, keyRing), status: "active" };
      const update = mergeUpdates(
        { $push: { writeLeases: lease } },
        aliasUpdate(binding),
      );
      if (retainUntil instanceof Date && !Number.isNaN(retainUntil.getTime())) {
        update.$max = { ...(update.$max || {}), retainUntil };
      }
      const current = await Model.findOneAndUpdate(filter, update, { new: true });
      if (current) return withLeaseCount(current, leaseId);
      try {
        return withLeaseCount(await Model.create({
          operationKey: lifecycleCompatibilityAlias(binding, keyRing).operationKey,
          operationKeys: lifecycleAliases(binding, keyRing),
          requiredPreviousKeyIds: keyRing.previousKeyIds,
          keyRingRetainUntil: keyRing.rotationHorizon,
          status: "active",
          writeLeases: [lease],
          retainUntil,
        }), leaseId);
      } catch (error) {
        if (error?.code === 11000) {
          const raced = await Model.findOneAndUpdate(filter, update, { new: true });
          if (raced) return withLeaseCount(raced, leaseId);
          throw lifecycleWriteError();
        }
        throw error;
      }
    },
    async renewWriteLease(binding, leaseId, now = new Date()) {
      await assertKeyCanaries();
      if (!leaseId) return null;
      const document = await Model.findOneAndUpdate(
        {
          ...lifecycleFilter(binding, keyRing),
          status: "active",
          writeLeases: { $elemMatch: { leaseId, leaseExpiresAt: { $gt: now } } },
        },
        {
          $set: {
            "writeLeases.$.leaseExpiresAt": new Date(now.getTime() + boundedLeaseLifetimeMs),
          },
        },
        { new: true },
      );
      return withLeaseCount(document, leaseId);
    },
    async validateWriteLease(binding, leaseId, now = new Date()) {
      await assertKeyCanaries();
      if (!leaseId) return null;
      const document = await Model.findOne({
        ...lifecycleFilter(binding, keyRing),
        status: "active",
        writeLeases: { $elemMatch: { leaseId, leaseExpiresAt: { $gt: now } } },
      });
      return withLeaseCount(document, leaseId);
    },
    async releaseWriteLease(binding, leaseId) {
      await assertKeyCanaries();
      if (!leaseId) throw lifecycleWriteError("Operation write lease is invalid");
      await Model.updateOne(
        lifecycleFilter(binding, keyRing),
        { $pull: { writeLeases: { leaseId } } },
      );
    },
    async beginPurge(binding, now = new Date()) {
      await assertKeyCanaries();
      const started = await Model.findOneAndUpdate(
        { ...lifecycleFilter(binding, keyRing), status: "active" },
        mergeUpdates(
          { $set: { status: "purging", purgeStartedAt: now } },
          aliasUpdate(binding),
        ),
        { new: true },
      );
      if (started) return withLeaseCount(started);
      const existing = await Model.findOneAndUpdate(
        lifecycleFilter(binding, keyRing),
        aliasUpdate(binding),
        { new: true },
      );
      if (existing) return withLeaseCount(existing);
      try {
        return withLeaseCount(await Model.create({
          operationKey: lifecycleCompatibilityAlias(binding, keyRing).operationKey,
          operationKeys: lifecycleAliases(binding, keyRing),
          requiredPreviousKeyIds: keyRing.previousKeyIds,
          keyRingRetainUntil: keyRing.rotationHorizon,
          status: "purging",
          writeLeases: [],
          purgeStartedAt: now,
        }));
      } catch (error) {
        if (error?.code !== 11000) throw error;
        return withLeaseCount(await Model.findOne(lifecycleFilter(binding, keyRing)));
      }
    },
    async markPurged(binding, now = new Date()) {
      await assertKeyCanaries();
      const current = await Model.findOne(lifecycleFilter(binding, keyRing));
      const retainUntil = current?.retainUntil ? new Date(current.retainUntil) : now;
      const keyRingRetainUntil = current?.keyRingRetainUntil
        ? new Date(current.keyRingRetainUntil)
        : now;
      const purgeAt = new Date(Math.max(
        now.getTime() + boundedLifecycleRetentionMs,
        Number.isNaN(retainUntil.getTime()) ? 0 : retainUntil.getTime(),
        Number.isNaN(keyRingRetainUntil.getTime()) ? 0 : keyRingRetainUntil.getTime(),
      ));
      const result = await Model.findOneAndUpdate(
        {
          ...lifecycleFilter(binding, keyRing),
          status: "purging",
          "writeLeases.0": { $exists: false },
        },
        mergeUpdates(
          { $set: { status: "purged", purgedAt: now, purgeAt } },
          aliasUpdate(binding),
        ),
        { new: true },
      );
      if (result) return withLeaseCount(result);
      const existing = await Model.findOne(lifecycleFilter(binding, keyRing));
      if (existing?.status === "purged" && !(existing.writeLeases?.length)) {
        return withLeaseCount(existing);
      }
      throw lifecycleWriteError("Operation purge fence could not be finalized");
    },
  };
}

function createMongooseArtifactRepository(Model = ConversionArtifact) {
  return {
    async findLatest({ sessionId, runId, kind, revision }) {
      const filter = { tombstoneOnly: false, sessionId, runId, kind };
      if (revision != null) filter.revision = revision;
      return plain(await Model.findOne(filter).sort({ revision: -1 }));
    },
    async create(metadata) {
      return plain(await Model.create(metadata));
    },
    async createWriteIntent(metadata) {
      return plain(await Model.create({ ...metadata, status: "write_intent" }));
    },
    async publishWriteIntent(gridFsObjectId, metadata) {
      return plain(await Model.findOneAndUpdate(
        { gridFsObjectId, tombstoneOnly: false, status: "write_intent" },
        {
          $set: { ...metadata, status: "available" },
          $unset: { writeIntentExpiresAt: 1 },
        },
        { new: true, runValidators: true },
      ));
    },
    async markStatus(gridFsObjectId, status, updates = {}) {
      const update = { $set: { status } };
      if (Object.hasOwn(updates, "purgeAt")) {
        if (updates.purgeAt == null) update.$unset = { purgeAt: 1 };
        else update.$set.purgeAt = updates.purgeAt;
      }
      await Model.updateOne({ gridFsObjectId }, update);
    },
    async createTombstone(metadata) {
      return plain(await Model.create({ ...metadata, tombstoneOnly: true }));
    },
    async findExpired({ now, limit, afterId }) {
      const expired = {
        $or: [
          { tombstoneOnly: false, status: "write_intent", writeIntentExpiresAt: { $lte: now } },
          { tombstoneOnly: false, status: "deletion_pending" },
          { tombstoneOnly: false, status: "available", expiresAt: { $lte: now } },
          { tombstoneOnly: true, status: "deletion_pending" },
        ],
      };
      const filter = afterId == null
        ? expired
        : { $and: [expired, { _id: { $gt: afterId } }] };
      const documents = await Model.find(filter).sort({ _id: 1 }).limit(limit);
      return documents.map(plain);
    },
    async findSessionArtifacts(binding, { limit }) {
      const documents = await Model.find({
        tombstoneOnly: false,
        ownerScope: binding.ownerScope,
        userId: binding.userId,
        sessionId: binding.sessionId,
        runId: binding.runId,
        uploadId: binding.uploadId,
        targetTemplateId: binding.targetTemplateId,
      }).sort({ _id: 1 }).limit(limit);
      return documents.map(plain);
    },
    async findSessionRetentionHorizon(binding) {
      const document = await Model.findOne({
        tombstoneOnly: false,
        ownerScope: binding.ownerScope,
        userId: binding.userId,
        sessionId: binding.sessionId,
        runId: binding.runId,
        uploadId: binding.uploadId,
        targetTemplateId: binding.targetTemplateId,
      }).sort({ expiresAt: -1 }).select({ expiresAt: 1 });
      return plain(document)?.expiresAt || null;
    },
    async deleteMetadata(gridFsObjectId) {
      return Model.deleteOne({ gridFsObjectId, tombstoneOnly: false });
    },
  };
}

function normalizeBinding(input) {
  const binding = {
    ownerScope: normalizeOwnerScope(input.ownerScope),
    userId: normalizeIdentifier(input.userId, "User id"),
    sessionId: normalizeIdentifier(input.sessionId, "Session id"),
    runId: normalizeIdentifier(input.runId, "Run id"),
    uploadId: normalizeIdentifier(input.uploadId, "Upload id"),
    targetTemplateId: normalizeIdentifier(input.targetTemplateId, "Target template id"),
    kind: String(input.kind || "").trim().toLowerCase(),
    revision: input.revision == null || String(input.revision).trim() === "" ? null : Number(input.revision),
  };
  if (!ARTIFACT_KINDS.has(binding.kind)) throw storageError(400, "Artifact kind is invalid", "INVALID_ARTIFACT_KIND");
  if (binding.revision != null && (!Number.isSafeInteger(binding.revision) || binding.revision < 1)) throw storageError(400, "Artifact revision is invalid", "INVALID_ARTIFACT_REVISION");
  return binding;
}

function normalizeSessionBinding(input) {
  const { kind: _kind, revision: _revision, ...binding } = normalizeBinding({
    ...input,
    kind: "state",
    revision: null,
  });
  return binding;
}

function assertBinding(metadata, input) {
  if (metadata.ownerScope !== normalizeOwnerScope(input.ownerScope)) throw storageError(403, "Artifact belongs to another owner", "ARTIFACT_OWNER_MISMATCH");
  if (metadata.userId !== normalizeIdentifier(input.userId, "User id")) throw storageError(403, "Artifact belongs to another user", "ARTIFACT_USER_MISMATCH");
  for (const [field, label] of [["runId", "run"], ["sessionId", "session"], ["uploadId", "upload"], ["targetTemplateId", "template"]]) {
    const expected = normalizeIdentifier(input[field], `${label[0].toUpperCase()}${label.slice(1)} id`);
    if (metadata[field] !== expected) throw storageError(403, "Artifact binding does not match this conversion", "ARTIFACT_BINDING_MISMATCH");
  }
  if (
    metadata.status !== "write_intent" &&
    (!/^[a-f0-9]{64}$/.test(String(metadata.sha256 || "")) ||
      !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0)
  ) {
    throw storageError(409, "Artifact metadata checksum is invalid", "ARTIFACT_CHECKSUM_MISMATCH");
  }
}

function createConversionArtifactService({
  repository = createMongooseArtifactRepository(),
  lifecycleRepository,
  storageAdapter,
  now = () => new Date(),
  maxBytes = configuredMaxBytes(),
  tombstoneRetentionMs = DEFAULT_TOMBSTONE_RETENTION_MS,
  purgeBatchSize = 100,
  purgeMaxArtifacts = 10_000,
  purgeLeaseWaitMs = 5_000,
  purgeLeasePollMs = 10,
  leaseHeartbeatIntervalMs = 10_000,
  writeIntentTimeoutMs = DEFAULT_WRITE_INTENT_TIMEOUT_MS,
  objectIdFactory = () => new mongoose.Types.ObjectId(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!storageAdapter) throw new Error("MongoDB/GridFS artifact adapter is required");
  let sweepAfterId = null;
  const lifecycleStore = lifecycleRepository || (
    typeof repository.acquireWriteLease === "function"
      ? repository
      : createMongooseOperationLifecycleRepository()
  );
  for (const method of ["acquireWriteLease", "renewWriteLease", "validateWriteLease", "releaseWriteLease"]) {
    if (typeof lifecycleStore[method] !== "function") {
      throw new Error(`Artifact lifecycle repository is missing ${method}`);
    }
  }

  function purgeAt() {
    return new Date(now().getTime() + Math.max(60_000, tombstoneRetentionMs));
  }

  async function markDeletionPending(metadata) {
    await repository.markStatus(metadata.gridFsObjectId, "deletion_pending", { purgeAt: purgeAt() });
  }

  async function createCleanupTombstone(orphan, expiresAt) {
    if (!orphan?.objectId || !/^[a-f0-9]{64}$/.test(String(orphan.sha256 || "")) || !Number.isSafeInteger(orphan.sizeBytes) || orphan.sizeBytes < 0) {
      throw storageError(503, "Artifact cleanup tracking failed", "ARTIFACT_TOMBSTONE_FAILED");
    }
    try {
      await repository.createTombstone({
        gridFsObjectId: orphan.objectId,
        sha256: orphan.sha256,
        sizeBytes: orphan.sizeBytes,
        mime: String(orphan.mime || "application/octet-stream"),
        expiresAt,
        status: "deletion_pending",
        purgeAt: purgeAt(),
      });
    } catch {
      throw storageError(503, "Artifact cleanup tracking failed", "ARTIFACT_TOMBSTONE_FAILED");
    }
  }

  async function compensate(objectId, metadata) {
    try {
      await storageAdapter.deleteArtifact({ objectId });
    } catch {
      await createCleanupTombstone({ objectId, ...metadata }, metadata.expiresAt);
    }
  }

  function startWriteLeaseHeartbeat(binding, leaseId, leaseLifetimeMs) {
    const configuredIntervalMs = Math.min(
      Math.max(Number(leaseHeartbeatIntervalMs) || 10_000, 5),
      60_000,
    );
    const intervalMs = Number.isFinite(Number(leaseLifetimeMs))
      ? Math.min(configuredIntervalMs, Math.max(5, Math.floor(Number(leaseLifetimeMs) / 3)))
      : configuredIntervalMs;
    let stopped = false;
    let failure = null;
    let inFlight = Promise.resolve();
    const timer = setIntervalImpl(() => {
      inFlight = inFlight.then(async () => {
        if (stopped || failure) return;
        const renewed = await lifecycleStore.renewWriteLease(binding, leaseId);
        if (!renewed || renewed.status !== "active") throw lifecycleWriteError();
      }).catch((error) => {
        failure = error?.code === "ARTIFACT_OPERATION_PURGED" ? error : lifecycleWriteError();
      });
    }, intervalMs);
    timer?.unref?.();
    return {
      async assertHealthy() {
        await inFlight;
        if (failure) throw failure;
      },
      async stop() {
        stopped = true;
        clearIntervalImpl(timer);
        await inFlight;
      },
    };
  }

  async function discardProvisionalArtifact(intent, cause) {
    let cleanupFailure = null;
    try {
      await storageAdapter.deleteArtifact({ objectId: intent.gridFsObjectId });
      if (await storageAdapter.getArtifact({ objectId: intent.gridFsObjectId })) {
        throw new Error("Provisional artifact bytes remain");
      }
      const removed = await repository.deleteMetadata(intent.gridFsObjectId);
      if (Number(removed?.deletedCount || 0) !== 1) {
        throw new Error("Provisional artifact metadata remains");
      }
    } catch (error) {
      cleanupFailure = error;
      try {
        await repository.markStatus(intent.gridFsObjectId, "deletion_pending", { purgeAt: purgeAt() });
      } catch {
        // The pre-existing write intent remains durable and sweep-discoverable.
      }
    }
    if (cleanupFailure) {
      const pending = storageError(503, "Artifact cleanup remains pending", "ARTIFACT_CLEANUP_PENDING");
      pending.cause = cause || cleanupFailure;
      throw pending;
    }
  }

  async function putArtifact(input) {
    const binding = normalizeBinding(input);
    if (binding.revision == null) throw storageError(400, "Artifact revision is required", "INVALID_ARTIFACT_REVISION");
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now()) throw storageError(400, "Artifact expiry is invalid", "INVALID_ARTIFACT_EXPIRY");
    const lease = await lifecycleStore.acquireWriteLease(binding, { retainUntil: expiresAt });
    if (!lease || lease.status !== "active") throw lifecycleWriteError();
    const heartbeat = startWriteLeaseHeartbeat(binding, lease.leaseId, lease.leaseLifetimeMs);
    try {
      const existing = await repository.findLatest(binding);
      if (existing) {
        assertBinding(existing, input);
        if (existing.status === "available" && new Date(existing.expiresAt) > now()) return existing;
        throw storageError(410, "Artifact revision has been retired", "ARTIFACT_REVISION_RETIRED");
      }
      const expectedSha256 = input.sha256 == null ? "" : String(input.sha256).trim().toLowerCase();
      const workspaceId = input.workspaceId == null || String(input.workspaceId).trim() === ""
        ? null
        : normalizeIdentifier(input.workspaceId, "Workspace id");
      const intent = await repository.createWriteIntent({
        ...binding,
        workspaceId,
        gridFsObjectId: objectIdFactory(),
        sha256: "",
        sizeBytes: 0,
        mime: String(input.mime || input.contentType || "application/octet-stream").trim(),
        expiresAt,
        writeIntentExpiresAt: new Date(
          now().getTime() + Math.max(60_000, Number(writeIntentTimeoutMs) || DEFAULT_WRITE_INTENT_TIMEOUT_MS),
        ),
      });
      let uploaded;
      try {
        uploaded = await storageAdapter.putArtifact({
          objectId: intent.gridFsObjectId,
          bytes: input.bytes || input.content,
          metadata: {
            ...binding,
            mime: input.mime || input.contentType,
            sha256: expectedSha256,
            sizeBytes: input.sizeBytes,
          },
        });
      } catch (error) {
        await discardProvisionalArtifact(intent, error);
        throw error;
      }
      const metadata = {
        ...binding,
        workspaceId,
        gridFsObjectId: uploaded.objectId,
        sha256: uploaded.sha256,
        sizeBytes: uploaded.sizeBytes,
        mime: String(input.mime || input.contentType || uploaded.mime || "application/octet-stream").trim(),
        expiresAt,
      };
      if (metadata.sizeBytes > maxBytes) {
        await discardProvisionalArtifact(intent);
        throw storageError(413, "Artifact exceeds size limit", "ARTIFACT_TOO_LARGE");
      }
      await heartbeat.assertHealthy();
      const finalLease = await lifecycleStore.validateWriteLease(binding, lease.leaseId);
      if (!finalLease || finalLease.status !== "active") {
        await discardProvisionalArtifact(intent);
        throw lifecycleWriteError();
      }
      let published;
      try {
        published = await repository.publishWriteIntent(intent.gridFsObjectId, metadata);
        if (!published) throw lifecycleWriteError("Artifact write intent could not be published");
      } catch (error) {
        await discardProvisionalArtifact(intent, error);
        throw error;
      }
      await heartbeat.assertHealthy();
      const publishedLease = await lifecycleStore.validateWriteLease(binding, lease.leaseId);
      if (!publishedLease || publishedLease.status !== "active") {
        await discardProvisionalArtifact(published);
        throw lifecycleWriteError();
      }
      return published;
    } finally {
      await heartbeat.stop();
      await lifecycleStore.releaseWriteLease(binding, lease.leaseId);
    }
  }

  async function validatedMetadata(input) {
    const binding = normalizeBinding(input);
    const metadata = await repository.findLatest(binding);
    if (!metadata) throw storageError(404, "Artifact was not found", "ARTIFACT_NOT_FOUND");
    assertBinding(metadata, input);
    if (metadata.status !== "available") throw storageError(410, "Artifact is unavailable", "ARTIFACT_UNAVAILABLE");
    if (new Date(metadata.expiresAt) <= now()) {
      try {
        await markDeletionPending(metadata);
        await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
        await repository.markStatus(metadata.gridFsObjectId, "expired", { purgeAt: purgeAt() });
      } catch {
        try { await markDeletionPending(metadata); } catch { /* leave metadata untouched if the first write failed */ }
      }
      throw storageError(410, "Artifact has expired", "ARTIFACT_EXPIRED");
    }
    return metadata;
  }

  async function retireCorruptedArtifact(metadata) {
    try {
      await markDeletionPending(metadata);
      await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
      await repository.markStatus(metadata.gridFsObjectId, "corrupted", { purgeAt: purgeAt() });
    } catch {
      try { await markDeletionPending(metadata); } catch { /* retain the durable state when possible */ }
    }
  }

  async function getArtifact(input) {
    const metadata = await validatedMetadata(input);
    const found = await storageAdapter.getArtifact({ objectId: metadata.gridFsObjectId });
    if (!found) {
      await repository.markStatus(metadata.gridFsObjectId, "missing", { purgeAt: purgeAt() });
      throw storageError(410, "Artifact bytes are unavailable", "ARTIFACT_GONE");
    }
    if (found.sizeBytes !== metadata.sizeBytes || (found.sha256 && found.sha256 !== metadata.sha256)) {
      await retireCorruptedArtifact(metadata);
      throw storageError(409, "Artifact checksum mismatch", "ARTIFACT_CHECKSUM_MISMATCH");
    }
    if (!found.stream || typeof found.stream.pipe !== "function") {
      throw storageError(503, "Artifact stream is unavailable", "ARTIFACT_STREAM_UNAVAILABLE");
    }
    const digest = crypto.createHash("sha256");
    let streamedBytes = 0;
    const verified = new Transform({
      transform: (chunk, _encoding, callback) => {
        const buffer = Buffer.from(chunk);
        streamedBytes += buffer.length;
        digest.update(buffer);
        callback(null, buffer);
      },
      flush: (callback) => {
        if (streamedBytes !== metadata.sizeBytes || digest.digest("hex") !== metadata.sha256) {
          const error = storageError(409, "Artifact checksum mismatch", "ARTIFACT_CHECKSUM_MISMATCH");
          retireCorruptedArtifact(metadata).finally(() => callback(error));
          return;
        }
        callback();
      },
    });
    // Keep source failures in the stream consumed by the HTTP pipeline.
    return { metadata, content: compose(found.stream, verified) };
  }

  async function deleteArtifact(input) {
    const metadata = await validatedMetadata(input);
    await markDeletionPending(metadata);
    try {
      const result = await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
      await repository.markStatus(metadata.gridFsObjectId, "deleted", { purgeAt: purgeAt() });
      return result;
    } catch (error) {
      await markDeletionPending(metadata);
      throw error;
    }
  }

  function purgeIncomplete(message, cause) {
    const error = storageError(503, message, "ARTIFACT_PURGE_INCOMPLETE");
    if (cause) error.cause = cause;
    return error;
  }

  async function verifiedByteMatches(binding, limit) {
    if (typeof storageAdapter.findArtifactsByBinding !== "function") {
      throw purgeIncomplete("Artifact byte verification is unavailable");
    }
    const matches = await storageAdapter.findArtifactsByBinding(binding, { limit });
    if (!Array.isArray(matches)) {
      throw purgeIncomplete("Artifact byte verification returned an invalid result");
    }
    return matches;
  }

  async function purgeSessionArtifacts(input) {
    const binding = normalizeSessionBinding(input);
    const batchSize = Math.min(Math.max(Number(purgeBatchSize) || 100, 1), 1000);
    const maxArtifacts = Math.min(Math.max(Number(purgeMaxArtifacts) || 10_000, 1), 100_000);
    let deletedArtifacts = 0;
    try {
      const lifecycle = await lifecycleStore.beginPurge(binding, now());
      if (!lifecycle || !["purging", "purged"].includes(lifecycle.status)) {
        throw purgeIncomplete("Operation purge fence is unavailable");
      }
      const waitMs = Math.min(Math.max(Number(purgeLeaseWaitMs) || 5_000, 0), 60_000);
      const pollMs = Math.min(Math.max(Number(purgeLeasePollMs) || 10, 1), 1_000);
      const deadline = Date.now() + waitMs;
      while (true) {
        const current = await lifecycleStore.find(binding, now());
        if (!current || Number(current.activeLeases || 0) <= 0) break;
        if (Date.now() >= deadline) throw purgeIncomplete("Operation write leases did not drain");
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      while (true) {
        const artifacts = await repository.findSessionArtifacts(binding, { limit: batchSize });
        if (!Array.isArray(artifacts)) {
          throw purgeIncomplete("Artifact metadata verification returned an invalid result");
        }
        if (artifacts.length === 0) break;
        if (deletedArtifacts + artifacts.length > maxArtifacts) {
          throw purgeIncomplete("Artifact purge exceeded the bounded maximum");
        }
        for (const metadata of artifacts) {
          assertBinding(metadata, { ...binding, kind: metadata.kind, revision: metadata.revision });
          await markDeletionPending(metadata);
          await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
          if (await storageAdapter.getArtifact({ objectId: metadata.gridFsObjectId })) {
            throw purgeIncomplete("Artifact bytes remain after deletion");
          }
          const removed = await repository.deleteMetadata(metadata.gridFsObjectId);
          if (Number(removed?.deletedCount || 0) !== 1) {
            throw purgeIncomplete("Artifact metadata remains after deletion");
          }
          deletedArtifacts += 1;
        }
      }

      let remainingBytes = await verifiedByteMatches(binding, batchSize);
      while (remainingBytes.length > 0) {
        if (deletedArtifacts + remainingBytes.length > maxArtifacts) {
          throw purgeIncomplete("Artifact byte purge exceeded the bounded maximum");
        }
        for (const artifact of remainingBytes) {
          const objectId = artifact?.objectId ?? artifact?._id;
          if (objectId == null) throw purgeIncomplete("Artifact byte match has no object ID");
          await storageAdapter.deleteArtifact({ objectId });
          if (await storageAdapter.getArtifact({ objectId })) {
            throw purgeIncomplete("Unlinked artifact bytes remain after deletion");
          }
          deletedArtifacts += 1;
        }
        remainingBytes = await verifiedByteMatches(binding, batchSize);
      }

      const remainingMetadata = await repository.findSessionArtifacts(binding, { limit: 1 });
      const finalBytes = await verifiedByteMatches(binding, 1);
      if (remainingMetadata.length || finalBytes.length) {
        throw purgeIncomplete("Operation artifact purge could not prove zero remaining data");
      }
      await lifecycleStore.markPurged(binding, now());
      return {
        success: true,
        purgeScope: "all_artifacts",
        deletedArtifacts,
        remainingMetadata: 0,
        remainingBytes: 0,
      };
    } catch (error) {
      if (error?.code === "ARTIFACT_PURGE_INCOMPLETE") throw error;
      throw purgeIncomplete("Operation artifact purge did not complete", error);
    }
  }

  async function sweepExpiredArtifacts({ limit = 100 } = {}) {
    const successBudget = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const scanLimit = Math.min(successBudget * 8, 1000);
    const sweepNow = now();
    let candidates = await repository.findExpired({
      now: sweepNow,
      limit: scanLimit,
      afterId: sweepAfterId,
    });
    if (!Array.isArray(candidates)) throw purgeIncomplete("Artifact sweep returned an invalid result");
    if (!candidates.length && sweepAfterId != null) {
      sweepAfterId = null;
      candidates = await repository.findExpired({ now: sweepNow, limit: scanLimit, afterId: null });
      if (!Array.isArray(candidates)) throw purgeIncomplete("Artifact sweep returned an invalid result");
    }
    let deleted = 0;
    let pending = 0;
    let completedCandidates = 0;
    let scanned = 0;
    let lastInspectedId = null;
    const failures = [];
    const inspectedOperations = new Set();
    for (const metadata of candidates) {
      if (completedCandidates >= successBudget) break;
      scanned += 1;
      if (metadata?._id != null) lastInspectedId = metadata._id;
      try {
        if (metadata.tombstoneOnly !== true) {
          const candidateBinding = normalizeSessionBinding(metadata);
          const candidateOperationKey = [
            candidateBinding.ownerScope,
            candidateBinding.userId,
            candidateBinding.sessionId,
            candidateBinding.uploadId,
            candidateBinding.runId,
            candidateBinding.targetTemplateId,
          ].join("\0");
          if (inspectedOperations.has(candidateOperationKey)) continue;
        }
        if (
          metadata.tombstoneOnly !== true &&
          (
            metadata.status === "write_intent" ||
            (metadata.status === "available" && new Date(metadata.expiresAt) <= sweepNow)
          )
        ) {
          const binding = normalizeSessionBinding(metadata);
          const operationKey = [
            binding.ownerScope,
            binding.userId,
            binding.sessionId,
            binding.uploadId,
            binding.runId,
            binding.targetTemplateId,
          ].join("\0");
          if (inspectedOperations.has(operationKey)) continue;
          inspectedOperations.add(operationKey);
          if (typeof repository.findSessionRetentionHorizon !== "function") {
            throw purgeIncomplete("Operation retention verification is unavailable");
          }
          const [artifactHorizon, lifecycle] = await Promise.all([
            repository.findSessionRetentionHorizon(binding),
            lifecycleStore.find(binding, sweepNow),
          ]);
          const horizons = [artifactHorizon, lifecycle?.retainUntil]
            .filter((value) => value != null)
            .map((value) => new Date(value));
          if (!horizons.length || horizons.some((value) => Number.isNaN(value.getTime()))) {
            throw purgeIncomplete("Operation retention horizon is unavailable");
          }
          if (Math.max(...horizons.map((value) => value.getTime())) > sweepNow.getTime()) {
            continue;
          }
          const result = await purgeSessionArtifacts(metadata);
          deleted += Number(result.deletedArtifacts || 0);
          completedCandidates += 1;
          continue;
        }
        await markDeletionPending(metadata);
        await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
        await repository.markStatus(metadata.gridFsObjectId, "expired", { purgeAt: purgeAt() });
        deleted += 1;
        completedCandidates += 1;
      } catch (error) {
        pending += 1;
        let failure = error;
        try { await markDeletionPending(metadata); } catch (repositoryError) { failure = repositoryError; }
        failures.push({
          code: String(failure?.code || "ARTIFACT_SWEEP_FAILED").slice(0, 80),
          statusCode: Number.isInteger(failure?.statusCode) ? failure.statusCode : 500,
        });
      }
    }
    sweepAfterId = lastInspectedId != null && (scanned < candidates.length || candidates.length === scanLimit)
      ? lastInspectedId
      : null;
    return { scanned, deleted, pending, failures };
  }

  return {
    putArtifact,
    getArtifact,
    deleteArtifact,
    purgeSessionArtifacts,
    sweepExpiredArtifacts,
  };
}

let defaultService;
function activeService() {
  if (!defaultService) defaultService = createConversionArtifactService({
    storageAdapter: createMongoGridFsArtifactStorage(),
    lifecycleRepository: createMongooseOperationLifecycleRepository(),
  });
  return defaultService;
}

function assertArtifactStorageConfigured(env = process.env) {
  return assertMongoGridFsConfigured(env);
}

async function assertArtifactStorageReachable({ env = process.env, connection } = {}) {
  assertMongoGridFsConfigured(env);
  const db = connection?.db;
  if (!db?.command) throw storageError(503, "MongoDB connection is required", "GRIDFS_DB_UNAVAILABLE");
  await db.command({ ping: 1 });
  if (typeof db.collection === "function") {
    await db.collection(`${String(env.CONVERTER_MONGODB_GRIDFS_BUCKET).trim()}.files`).findOne({}, { projection: { _id: 1 } });
  }
  return true;
}

function startConversionArtifactSweeper({ service = activeService(), env = process.env, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, logger = console } = {}) {
  const intervalMs = Math.max(60_000, Number(env.CONVERTER_ARTIFACT_SWEEP_INTERVAL_SECONDS || 300) * 1000);
  const limit = Math.min(Math.max(Number(env.CONVERTER_ARTIFACT_SWEEP_MAX_FILES || 100), 1), 1000);
  let running;
  const runOnce = () => {
    if (!running) running = service.sweepExpiredArtifacts({ limit }).then((result) => {
      for (const failure of result.failures || []) {
        logger.error?.(`[ARTIFACT_SWEEP] candidate failed code=${failure.code} status=${failure.statusCode}`);
      }
      return result;
    }).catch((error) => {
      logger.error?.(`[ARTIFACT_SWEEP] run failed code=${String(error?.code || "ARTIFACT_SWEEP_FAILED").slice(0, 80)} status=${Number.isInteger(error?.statusCode) ? error.statusCode : 500}`);
      return { scanned: 0, deleted: 0, pending: 0, failures: [{ code: "ARTIFACT_SWEEP_FAILED", statusCode: 500 }], failed: true };
    }).finally(() => { running = null; });
    return running;
  };
  const ready = runOnce();
  const timer = setIntervalImpl(runOnce, intervalMs);
  timer?.unref?.();
  return { ready, runOnce, stop: () => clearIntervalImpl(timer) };
}

async function ensureConversionArtifactIndexes({
  model = ConversionArtifact,
  lifecycleModel = ConversionOperationLifecycle,
} = {}) {
  const droppedIndexes = [];
  let indexes = [];
  try {
    indexes = await model.collection.indexes();
  } catch (error) {
    if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") throw error;
  }
  if (indexes.some((index) => index.name === "purgeAt_1")) {
    try {
      await model.collection.dropIndex("purgeAt_1");
      droppedIndexes.push("purgeAt_1");
    } catch (error) {
      if (error?.code !== 27 && error?.codeName !== "IndexNotFound") throw error;
    }
  }
  if (lifecycleModel.collection?.indexes && lifecycleModel.collection?.countDocuments) {
    const lifecycleIndexes = await readCollectionIndexes(lifecycleModel.collection);
    const oldLifecycleIndex = inspectLegacyLifecycleIndex(lifecycleIndexes);
    const oldOperationKeyIndex = inspectLegacyOperationKeyIndex(lifecycleIndexes);
    const remainingLegacy = await lifecycleModel.collection.countDocuments(legacyLifecycleFilter());
    if (oldLifecycleIndex || remainingLegacy > 0) {
      throw new Error(
        "ARTIFACT_LIFECYCLE_MIGRATION_MODE=apply is required before lifecycle indexes can be created",
      );
    }
    await assertArtifactLifecycleKeyCoverage({ model: lifecycleModel });
  }
  await model.createIndexes();
  await lifecycleModel.createIndexes();
  return { droppedIndexes };
}

module.exports = {
  assertArtifactLifecycleKeyCoverage,
  assertArtifactStorageConfigured,
  assertArtifactStorageReachable,
  createConversionArtifactService,
  createMongooseArtifactRepository,
  createMongooseOperationLifecycleRepository,
  deleteArtifact: (...args) => activeService().deleteArtifact(...args),
  ensureConversionArtifactIndexes,
  getArtifact: (...args) => activeService().getArtifact(...args),
  purgeSessionArtifacts: (...args) => activeService().purgeSessionArtifacts(...args),
  putArtifact: (...args) => activeService().putArtifact(...args),
  migrateConversionOperationLifecycles,
  normalizeArtifactLifecycleMigrationMode,
  startConversionArtifactSweeper,
  sweepExpiredArtifacts: (...args) => activeService().sweepExpiredArtifacts(...args),
  storageError,
};
