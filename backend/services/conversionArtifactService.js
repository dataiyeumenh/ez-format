const crypto = require("node:crypto");
const ConversionArtifact = require("../models/ConversionArtifact");
const {
  assertMongoGridFsConfigured,
  createMongoGridFsArtifactStorage,
  configuredMaxBytes,
} = require("./mongoGridFsArtifactStorage");

const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ARTIFACT_KINDS = new Set(["analysis", "upload", "output", "state", "manifest", "import_result"]);
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

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function plain(document) {
  return document && typeof document.toObject === "function" ? document.toObject() : document;
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
    async findExpired({ now, limit }) {
      const documents = await Model.find({
        tombstoneOnly: false,
        $or: [
          { status: "deletion_pending" },
          { status: "available", expiresAt: { $lte: now } },
        ],
      }).sort({ expiresAt: 1 }).limit(limit);
      return documents.map(plain);
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

function assertBinding(metadata, input) {
  if (metadata.ownerScope !== normalizeOwnerScope(input.ownerScope)) throw storageError(403, "Artifact belongs to another owner", "ARTIFACT_OWNER_MISMATCH");
  for (const [field, label] of [["runId", "run"], ["sessionId", "session"], ["uploadId", "upload"], ["targetTemplateId", "template"]]) {
    const expected = normalizeIdentifier(input[field], `${label[0].toUpperCase()}${label.slice(1)} id`);
    if (metadata[field] !== expected) throw storageError(403, "Artifact binding does not match this conversion", "ARTIFACT_BINDING_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(String(metadata.sha256 || "")) || !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0) {
    throw storageError(409, "Artifact metadata checksum is invalid", "ARTIFACT_CHECKSUM_MISMATCH");
  }
}

function createConversionArtifactService({
  repository = createMongooseArtifactRepository(),
  storageAdapter,
  now = () => new Date(),
  maxBytes = configuredMaxBytes(),
  tombstoneRetentionMs = DEFAULT_TOMBSTONE_RETENTION_MS,
} = {}) {
  if (!storageAdapter) throw new Error("MongoDB/GridFS artifact adapter is required");

  function purgeAt() {
    return new Date(now().getTime() + Math.max(60_000, tombstoneRetentionMs));
  }

  async function markDeletionPending(metadata) {
    await repository.markStatus(metadata.gridFsObjectId, "deletion_pending", { purgeAt: null });
  }

  async function compensate(objectId, metadata) {
    try {
      await storageAdapter.deleteArtifact({ objectId });
    } catch {
      await repository.createTombstone({
        gridFsObjectId: objectId,
        sha256: metadata.sha256,
        sizeBytes: metadata.sizeBytes,
        mime: metadata.mime,
        expiresAt: metadata.expiresAt,
        status: "deletion_pending",
        purgeAt: null,
      }).catch(() => {});
    }
  }

  async function putArtifact(input) {
    const binding = normalizeBinding(input);
    if (binding.revision == null) throw storageError(400, "Artifact revision is required", "INVALID_ARTIFACT_REVISION");
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now()) throw storageError(400, "Artifact expiry is invalid", "INVALID_ARTIFACT_EXPIRY");
    const existing = await repository.findLatest(binding);
    if (existing) {
      assertBinding(existing, input);
      if (existing.status === "available" && new Date(existing.expiresAt) > now()) return existing;
      throw storageError(410, "Artifact revision has been retired", "ARTIFACT_REVISION_RETIRED");
    }
    const expectedSha256 = input.sha256 == null ? "" : String(input.sha256).trim().toLowerCase();
    const uploaded = await storageAdapter.putArtifact({
      bytes: input.bytes || input.content,
      metadata: { ownerScope: binding.ownerScope, runId: binding.runId, mime: input.mime || input.contentType, sha256: expectedSha256, sizeBytes: input.sizeBytes },
    });
    const metadata = {
      ...binding,
      workspaceId: input.workspaceId == null || String(input.workspaceId).trim() === "" ? null : normalizeIdentifier(input.workspaceId, "Workspace id"),
      gridFsObjectId: uploaded.objectId,
      sha256: uploaded.sha256,
      sizeBytes: uploaded.sizeBytes,
      mime: String(input.mime || input.contentType || uploaded.mime || "application/octet-stream").trim(),
      expiresAt,
      status: "available",
    };
    if (metadata.sizeBytes > maxBytes) {
      await compensate(uploaded.objectId, metadata);
      throw storageError(413, "Artifact exceeds size limit", "ARTIFACT_TOO_LARGE");
    }
    try {
      return await repository.create(metadata);
    } catch (error) {
      await compensate(uploaded.objectId, metadata);
      throw error;
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
        await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
        await repository.markStatus(metadata.gridFsObjectId, "expired", { purgeAt: purgeAt() });
      } catch {
        await markDeletionPending(metadata);
      }
      throw storageError(410, "Artifact has expired", "ARTIFACT_EXPIRED");
    }
    return metadata;
  }

  async function getArtifact(input) {
    const metadata = await validatedMetadata(input);
    const found = await storageAdapter.getArtifact({ objectId: metadata.gridFsObjectId });
    if (!found) {
      await repository.markStatus(metadata.gridFsObjectId, "missing", { purgeAt: purgeAt() });
      throw storageError(410, "Artifact bytes are unavailable", "ARTIFACT_GONE");
    }
    const actualSha256 = found.sha256 || sha256(found.bytes);
    const actualSizeBytes = found.sizeBytes == null ? found.bytes.length : found.sizeBytes;
    if (actualSha256 !== metadata.sha256 || actualSizeBytes !== metadata.sizeBytes) {
      try {
        await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
        await repository.markStatus(metadata.gridFsObjectId, "corrupted", { purgeAt: purgeAt() });
      } catch {
        await markDeletionPending(metadata);
      }
      throw storageError(409, "Artifact checksum mismatch", "ARTIFACT_CHECKSUM_MISMATCH");
    }
    return { metadata, content: found.bytes };
  }

  async function deleteArtifact(input) {
    const metadata = await validatedMetadata(input);
    try {
      const result = await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
      await repository.markStatus(metadata.gridFsObjectId, "deleted", { purgeAt: purgeAt() });
      return result;
    } catch (error) {
      await markDeletionPending(metadata);
      throw error;
    }
  }

  async function sweepExpiredArtifacts({ limit = 100 } = {}) {
    const candidates = await repository.findExpired({ now: now(), limit: Math.min(Math.max(Number(limit) || 100, 1), 1000) });
    let deleted = 0;
    let pending = 0;
    for (const metadata of candidates) {
      try {
        await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
        await repository.markStatus(metadata.gridFsObjectId, "expired", { purgeAt: purgeAt() });
        deleted += 1;
      } catch {
        await markDeletionPending(metadata);
        pending += 1;
      }
    }
    return { scanned: candidates.length, deleted, pending };
  }

  return { putArtifact, getArtifact, deleteArtifact, sweepExpiredArtifacts };
}

let defaultService;
function activeService() {
  if (!defaultService) defaultService = createConversionArtifactService({ storageAdapter: createMongoGridFsArtifactStorage() });
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
    await db.collection(`${String(env.CONVERTER_GRIDFS_BUCKET).trim()}.files`).findOne({}, { projection: { _id: 1 } });
  }
  return true;
}

function startConversionArtifactSweeper({ service = activeService(), env = process.env, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, logger = console } = {}) {
  const intervalMs = Math.max(60_000, Number(env.CONVERTER_ARTIFACT_SWEEP_INTERVAL_SECONDS || 300) * 1000);
  const limit = Math.min(Math.max(Number(env.CONVERTER_ARTIFACT_SWEEP_MAX_FILES || 100), 1), 1000);
  let running;
  const runOnce = () => {
    if (!running) running = service.sweepExpiredArtifacts({ limit }).catch((error) => {
      logger.error?.(`[ARTIFACT_SWEEP] ${error.message}`);
      return { scanned: 0, deleted: 0, pending: 0, failed: true };
    }).finally(() => { running = null; });
    return running;
  };
  const ready = runOnce();
  const timer = setIntervalImpl(runOnce, intervalMs);
  timer?.unref?.();
  return { ready, runOnce, stop: () => clearIntervalImpl(timer) };
}

async function ensureConversionArtifactIndexes({ model = ConversionArtifact } = {}) {
  await model.createIndexes();
  return { droppedIndexes: [] };
}

module.exports = {
  assertArtifactStorageConfigured,
  assertArtifactStorageReachable,
  createConversionArtifactService,
  createMongooseArtifactRepository,
  deleteArtifact: (...args) => activeService().deleteArtifact(...args),
  ensureConversionArtifactIndexes,
  getArtifact: (...args) => activeService().getArtifact(...args),
  putArtifact: (...args) => activeService().putArtifact(...args),
  startConversionArtifactSweeper,
  sweepExpiredArtifacts: (...args) => activeService().sweepExpiredArtifacts(...args),
  storageError,
};
