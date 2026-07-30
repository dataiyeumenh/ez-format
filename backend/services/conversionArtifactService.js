const crypto = require("node:crypto");
const { compose, Transform } = require("node:stream");
const ConversionArtifact = require("../models/ConversionArtifact");
const {
  assertMongoGridFsConfigured,
  createMongoGridFsArtifactStorage,
  configuredMaxBytes,
} = require("./mongoGridFsArtifactStorage");

const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
        $or: [
          { tombstoneOnly: false, status: "deletion_pending" },
          { tombstoneOnly: false, status: "available", expiresAt: { $lte: now } },
          { tombstoneOnly: true, status: "deletion_pending" },
        ],
      }).sort({ purgeAt: 1, expiresAt: 1 }).limit(limit);
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
    let uploaded;
    try {
      uploaded = await storageAdapter.putArtifact({
        bytes: input.bytes || input.content,
        metadata: { ownerScope: binding.ownerScope, runId: binding.runId, mime: input.mime || input.contentType, sha256: expectedSha256, sizeBytes: input.sizeBytes },
      });
    } catch (error) {
      if (error?.orphanedArtifact) await createCleanupTombstone(error.orphanedArtifact, expiresAt);
      throw error;
    }
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

  async function sweepExpiredArtifacts({ limit = 100 } = {}) {
    const candidates = await repository.findExpired({ now: now(), limit: Math.min(Math.max(Number(limit) || 100, 1), 1000) });
    let deleted = 0;
    let pending = 0;
    const failures = [];
    for (const metadata of candidates) {
      try {
        await markDeletionPending(metadata);
        await storageAdapter.deleteArtifact({ objectId: metadata.gridFsObjectId });
        await repository.markStatus(metadata.gridFsObjectId, "expired", { purgeAt: purgeAt() });
        deleted += 1;
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
    return { scanned: candidates.length, deleted, pending, failures };
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

async function ensureConversionArtifactIndexes({ model = ConversionArtifact } = {}) {
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
  await model.createIndexes();
  return { droppedIndexes };
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
