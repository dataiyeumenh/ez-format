const crypto = require("node:crypto");
const ConversionSessionState = require("../models/ConversionSessionState");
const conversionArtifacts = require("./conversionArtifactService");

const DEFAULT_SESSION_STATE_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_STATE_SWEEP_LIMIT = 100;
const DEFAULT_SESSION_STATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function configuredTombstoneRetentionMs(env = process.env) {
  const seconds = Number(
    env.CONVERTER_SESSION_STATE_TOMBSTONE_TTL_SECONDS ||
      env.CONVERTER_ARTIFACT_TOMBSTONE_TTL_SECONDS ||
      DEFAULT_SESSION_STATE_TOMBSTONE_RETENTION_MS / 1000,
  );
  const bounded = Number.isSafeInteger(seconds)
    ? Math.min(Math.max(seconds, 60), 31 * 24 * 60 * 60)
    : DEFAULT_SESSION_STATE_TOMBSTONE_RETENTION_MS / 1000;
  return bounded * 1000;
}

function configuredSweepLimit(env = process.env) {
  const value = Number(env.CONVERTER_SESSION_STATE_SWEEP_MAX_SESSIONS || DEFAULT_SESSION_STATE_SWEEP_LIMIT);
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 1000) : DEFAULT_SESSION_STATE_SWEEP_LIMIT;
}

function configuredSweepIntervalMs(env = process.env) {
  const seconds = Number(env.CONVERTER_SESSION_STATE_SWEEP_INTERVAL_SECONDS || 300);
  const bounded = Number.isSafeInteger(seconds) ? Math.max(seconds, 60) : 300;
  return bounded * 1000 || DEFAULT_SESSION_STATE_SWEEP_INTERVAL_MS;
}

function sessionError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function plainDocument(document) {
  if (!document) return null;
  return typeof document.toObject === "function" ? document.toObject() : document;
}

function createMongooseSessionRepository(Model = ConversionSessionState) {
  return {
    async find({ sessionId, runId }) {
      return plainDocument(await Model.findOne({ sessionId, runId }));
    },
    async findExpired({ now, limit }) {
      const documents = await Model.find({
        $or: [
          { status: { $in: ["allocated", "active"] }, expiresAt: { $lte: now } },
          { status: "deletion_pending" },
          { status: "expired", purgeAt: null },
        ],
      })
        .sort({ expiresAt: 1, updatedAt: 1 })
        .limit(limit);
      return documents.map(plainDocument);
    },
    async reserve(metadata) {
      try {
        return plainDocument(await Model.create(metadata));
      } catch (error) {
        if (error?.code !== 11000) throw error;
        return plainDocument(
          await Model.findOne({ sessionId: metadata.sessionId, runId: metadata.runId }),
        );
      }
    },
    async bindUpload(binding, previous) {
      return plainDocument(
        await Model.findOneAndUpdate(
          {
            sessionId: previous.sessionId,
            runId: previous.runId,
            revision: previous.revision,
            status: previous.status,
            ownerScope: previous.ownerScope,
            userId: previous.userId,
            workspaceId: previous.workspaceId,
            targetTemplateId: previous.targetTemplateId,
            uploadId: previous.uploadId,
          },
          {
            $set: {
              targetTemplateId: binding.targetTemplateId,
              uploadId: binding.uploadId,
              expiresAt: binding.expiresAt,
            },
          },
          { new: true, runValidators: true },
        ),
      );
    },
    async saveNext(metadata, previousRevision) {
      return plainDocument(
        await Model.findOneAndUpdate(
          {
            sessionId: metadata.sessionId,
            runId: metadata.runId,
            revision: previousRevision,
            ownerScope: metadata.ownerScope,
            userId: metadata.userId,
            workspaceId: metadata.workspaceId,
            targetTemplateId: metadata.targetTemplateId,
            uploadId: metadata.uploadId,
          },
          { $set: metadata },
          { new: true, runValidators: true },
        ),
      );
    },
    async markStatus({ sessionId, runId }, status, updates = {}) {
      const update = { $set: { status } };
      if (Object.hasOwn(updates, "purgeAt")) {
        if (updates.purgeAt == null) update.$unset = { purgeAt: 1 };
        else update.$set.purgeAt = updates.purgeAt;
      }
      await Model.updateOne({ sessionId, runId }, update);
    },
  };
}

function requiredText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw sessionError(400, `${label} is required`, "INVALID_SESSION_BINDING");
  return normalized;
}

function optionalText(value) {
  return value == null || String(value).trim() === "" ? "" : String(value).trim();
}

function workspaceValue(value) {
  return value == null || String(value).trim() === "" ? null : String(value).trim();
}

function createConversionSessionStateService({
  repository = createMongooseSessionRepository(),
  artifactService = conversionArtifacts,
  now = () => new Date(),
  tombstoneRetentionMs = DEFAULT_SESSION_STATE_TOMBSTONE_RETENTION_MS,
} = {}) {
  function futureExpiry(value) {
    const expiresAt = new Date(value);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now()) {
      throw sessionError(400, "Session expiry is invalid", "INVALID_SESSION_EXPIRY");
    }
    return expiresAt;
  }

  function identity(input) {
    return {
      sessionId: requiredText(input.sessionId, "Session id"),
      runId: requiredText(input.runId, "Run id"),
      ownerScope: requiredText(input.ownerScope, "Owner scope"),
      userId: requiredText(input.userId, "User id"),
      workspaceId: workspaceValue(input.workspaceId),
      targetTemplateId: optionalText(input.targetTemplateId),
      uploadId: optionalText(input.uploadId),
    };
  }

  function assertMetadataBinding(current, expected, { requireBound = false } = {}) {
    if (
      current.ownerScope !== expected.ownerScope ||
      current.userId !== expected.userId ||
      workspaceValue(current.workspaceId) !== expected.workspaceId
    ) {
      throw sessionError(403, "Session belongs to another owner", "SESSION_OWNER_MISMATCH");
    }
    for (const [field, label] of [
      ["targetTemplateId", "template"],
      ["uploadId", "upload"],
    ]) {
      const actual = optionalText(current[field]);
      const wanted = optionalText(expected[field]);
      if ((actual && wanted && actual !== wanted) || (requireBound && (!actual || !wanted))) {
        throw sessionError(
          409,
          `Session ${label} binding does not match`,
          "SESSION_BINDING_MISMATCH",
        );
      }
    }
    return current;
  }

  function assertStatePayloadBinding(state, binding) {
    const session = state && typeof state === "object" && !Array.isArray(state)
      ? state.session
      : null;
    if (!session || typeof session !== "object" || Array.isArray(session)) {
      throw sessionError(400, "Session state binding is required", "INVALID_SESSION_STATE");
    }
    const fields = [
      ["session_id", binding.sessionId],
      ["upload_id", binding.uploadId],
      ["owner_scope", binding.ownerScope],
      ["user_id", binding.userId],
      ["workspace_id", binding.workspaceId],
      ["target_template_id", binding.targetTemplateId],
    ];
    for (const [field, expected] of fields) {
      const actual = field === "workspace_id"
        ? workspaceValue(session[field])
        : optionalText(session[field]);
      const normalizedExpected = field === "workspace_id"
        ? workspaceValue(expected)
        : optionalText(expected);
      if (!normalizedExpected && field !== "workspace_id" || actual !== normalizedExpected) {
        throw sessionError(409, "Session state binding does not match", "SESSION_BINDING_MISMATCH");
      }
    }
  }

  async function assertNotExpired(current) {
    if (
      !["allocated", "active"].includes(current.status) ||
      new Date(current.expiresAt) <= now()
    ) {
      await repository.markStatus(
        { sessionId: current.sessionId, runId: current.runId },
        "expired",
      );
      if (current.stateArtifactKey) {
        await artifactService.deleteArtifact?.({
          sessionId: current.sessionId,
          runId: current.runId,
          ownerScope: current.ownerScope,
          uploadId: current.uploadId,
          targetTemplateId: current.targetTemplateId,
          kind: "state",
          revision: current.revision,
        }).catch(() => {});
      }
      throw sessionError(410, "Session state has expired", "SESSION_EXPIRED");
    }
    return current;
  }

  async function reserveSessionState(input) {
    const binding = identity(input);
    const expiresAt = futureExpiry(input.expiresAt);
    const metadata = {
      ...binding,
      stateArtifactKey: "",
      stateSha256: "",
      revision: 0,
      expiresAt,
      status: "allocated",
    };
    const current = await repository.find(binding);
    if (current) {
      assertMetadataBinding(current, binding);
      return assertNotExpired(current);
    }
    const stored = await repository.reserve(metadata);
    if (!stored) {
      throw sessionError(409, "Session reservation changed", "SESSION_REVISION_CONFLICT");
    }
    assertMetadataBinding(stored, binding);
    return assertNotExpired(stored);
  }

  async function bindSessionUpload(input) {
    const binding = identity(input);
    if (!binding.uploadId || !binding.targetTemplateId) {
      throw sessionError(400, "Session upload and template are required", "INVALID_SESSION_BINDING");
    }
    let current = await repository.find(binding);
    if (!current) throw sessionError(404, "Session state was not found", "SESSION_NOT_FOUND");
    assertMetadataBinding(current, binding);
    await assertNotExpired(current);
    if (
      optionalText(current.uploadId) === binding.uploadId &&
      optionalText(current.targetTemplateId) === binding.targetTemplateId
    ) {
      return current;
    }
    if (current.uploadId || (current.targetTemplateId && current.targetTemplateId !== binding.targetTemplateId)) {
      throw sessionError(409, "Session binding does not match", "SESSION_BINDING_MISMATCH");
    }
    const expiresAt = input.expiresAt == null
      ? new Date(current.expiresAt)
      : futureExpiry(input.expiresAt);
    const stored = await repository.bindUpload(
      { ...binding, expiresAt },
      current,
    );
    if (stored) return stored;
    current = await repository.find(binding);
    if (current) {
      assertMetadataBinding(current, binding, { requireBound: true });
      return assertNotExpired(current);
    }
    throw sessionError(409, "Session binding changed", "SESSION_REVISION_CONFLICT");
  }

  async function assertSessionBinding(input) {
    const binding = identity(input);
    const current = await repository.find(binding);
    if (!current) throw sessionError(404, "Session state was not found", "SESSION_NOT_FOUND");
    assertMetadataBinding(current, binding, { requireBound: true });
    return assertNotExpired(current);
  }

  async function resolveSessionArtifactBinding(input) {
    const expected = identity(input);
    const current = await repository.find({
      sessionId: expected.sessionId,
      runId: expected.runId,
    });
    if (!current) throw sessionError(404, "Session state was not found", "SESSION_NOT_FOUND");
    assertMetadataBinding(current, expected);
    await assertNotExpired(current);
    if (
      current.status !== "active" ||
      current.revision < 1 ||
      !current.stateArtifactKey ||
      !optionalText(current.uploadId) ||
      !optionalText(current.targetTemplateId)
    ) {
      throw sessionError(409, "Session state is not active", "SESSION_STATE_NOT_ACTIVE");
    }
    return current;
  }

  async function putSessionState(input) {
    const binding = identity(input);
    const { sessionId, runId, ownerScope, userId, workspaceId } = binding;
    const revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw sessionError(400, "Session revision is invalid", "INVALID_SESSION_REVISION");
    }
    const expiresAt = futureExpiry(input.expiresAt);
    assertStatePayloadBinding(input.state, binding);
    let serialized;
    try {
      serialized = JSON.stringify(input.state);
    } catch (_error) {
      throw sessionError(400, "Session state is not JSON serializable", "INVALID_SESSION_STATE");
    }
    if (serialized == null) {
      throw sessionError(400, "Session state is required", "INVALID_SESSION_STATE");
    }
    const stateSha256 = crypto
      .createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex");

    let current = await repository.find({ sessionId, runId });
    if (!current) throw sessionError(404, "Session state was not found", "SESSION_NOT_FOUND");
    assertMetadataBinding(current, binding);
    await assertNotExpired(current);
    if (!current.uploadId || !current.targetTemplateId) {
      current = await bindSessionUpload({ ...binding, expiresAt });
    }
    assertMetadataBinding(current, binding, { requireBound: true });
    const previousRevision = current.revision;
    if (current && revision === previousRevision) {
      if (current.stateSha256 === stateSha256) return current;
      throw sessionError(409, "Session revision is stale", "SESSION_REVISION_CONFLICT");
    }
    if (revision !== previousRevision + 1) {
      throw sessionError(409, "Session revision is stale", "SESSION_REVISION_CONFLICT");
    }

    const artifact = await artifactService.putArtifact({
      sessionId,
      runId,
      ownerScope,
      userId,
      workspaceId,
      targetTemplateId: binding.targetTemplateId,
      uploadId: binding.uploadId,
      kind: "state",
      revision,
      content: Buffer.from(serialized, "utf8"),
      contentType: "application/json",
      expiresAt,
    });
    const metadata = {
      ownerScope,
      userId,
      workspaceId,
      runId,
      sessionId,
      targetTemplateId: binding.targetTemplateId,
      uploadId: binding.uploadId,
      stateArtifactKey: artifact.storageKey,
      stateSha256: artifact.sha256,
      revision,
      expiresAt,
      status: "active",
    };
    const stored = await repository.saveNext(metadata, previousRevision);
    if (!stored) {
      await artifactService.deleteArtifact?.({
        sessionId,
        runId,
        ownerScope,
        uploadId: binding.uploadId,
        targetTemplateId: binding.targetTemplateId,
        kind: "state",
        revision,
      }).catch(() => {});
      throw sessionError(409, "Session revision changed", "SESSION_REVISION_CONFLICT");
    }
    return stored;
  }

  async function getSessionState(input) {
    const binding = identity(input);
    const { sessionId, runId, ownerScope } = binding;
    const metadata = await repository.find({ sessionId, runId });
    if (!metadata) throw sessionError(404, "Session state was not found", "SESSION_NOT_FOUND");
    assertMetadataBinding(metadata, binding);
    await assertNotExpired(metadata);
    if (metadata.status !== "active" || metadata.revision < 1 || !metadata.stateArtifactKey) {
      throw sessionError(409, "Session state is not active", "SESSION_STATE_NOT_ACTIVE");
    }
    const artifact = await artifactService.getArtifact({
      sessionId,
      runId,
      ownerScope,
      uploadId: metadata.uploadId,
      targetTemplateId: metadata.targetTemplateId,
      kind: "state",
      revision: metadata.revision,
    });
    if (
      artifact.metadata.storageKey !== metadata.stateArtifactKey ||
      artifact.metadata.sha256 !== metadata.stateSha256
    ) {
      throw sessionError(409, "Session artifact binding is invalid", "SESSION_ARTIFACT_MISMATCH");
    }
    let state;
    try {
      state = JSON.parse(artifact.content.toString("utf8"));
    } catch (_error) {
      throw sessionError(409, "Session artifact is invalid JSON", "SESSION_ARTIFACT_INVALID");
    }
    return { metadata, state };
  }

  function purgeAt() {
    const retention = Number.isFinite(tombstoneRetentionMs)
      ? Math.max(60_000, tombstoneRetentionMs)
      : DEFAULT_SESSION_STATE_TOMBSTONE_RETENTION_MS;
    return new Date(now().getTime() + retention);
  }

  async function deleteStateArtifact(candidate) {
    if (!candidate.stateArtifactKey) return;
    if (typeof artifactService.deleteArtifact !== "function") {
      throw sessionError(
        503,
        "Session state artifact service is unavailable",
        "SESSION_ARTIFACT_SERVICE_UNAVAILABLE",
      );
    }
    try {
      await artifactService.deleteArtifact({
        sessionId: candidate.sessionId,
        runId: candidate.runId,
        ownerScope: candidate.ownerScope,
        uploadId: candidate.uploadId,
        targetTemplateId: candidate.targetTemplateId,
        kind: "state",
        revision: candidate.revision,
      });
    } catch (error) {
      // The artifact service reports an expired object after deleting its bytes.
      if (error?.code === "ARTIFACT_EXPIRED" && error.deleted === true) return;
      if (error?.code === "ARTIFACT_GONE") return;
      throw error;
    }
  }

  async function sweepExpiredSessionStates({ limit = DEFAULT_SESSION_STATE_SWEEP_LIMIT } = {}) {
    const boundedLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), 1000)
      : DEFAULT_SESSION_STATE_SWEEP_LIMIT;
    const candidates = await repository.findExpired({ now: now(), limit: boundedLimit });
    let deleted = 0;
    let pending = 0;
    for (const candidate of candidates) {
      const identity = { sessionId: candidate.sessionId, runId: candidate.runId };
      try {
        await repository.markStatus(identity, "deletion_pending", { purgeAt: null });
        await deleteStateArtifact(candidate);
        await repository.markStatus(identity, "expired", { purgeAt: purgeAt() });
        deleted += 1;
      } catch (_error) {
        await repository.markStatus(identity, "deletion_pending", { purgeAt: null });
        pending += 1;
      }
    }
    return { scanned: candidates.length, deleted, pending };
  }

  return {
    assertSessionBinding,
    bindSessionUpload,
    getSessionState,
    putSessionState,
    reserveSessionState,
    resolveSessionArtifactBinding,
    sweepExpiredSessionStates,
  };
}

let defaultService;

function activeService() {
  if (!defaultService) {
    defaultService = createConversionSessionStateService({
      tombstoneRetentionMs: configuredTombstoneRetentionMs(),
    });
  }
  return defaultService;
}

function startConversionSessionStateSweeper({
  service = activeService(),
  env = process.env,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  const limit = configuredSweepLimit(env);
  let running = null;
  const runOnce = () => {
    if (running) return running;
    running = Promise.resolve(service.sweepExpiredSessionStates({ limit }))
      .catch((error) => {
        logger.error?.(`[SESSION_STATE_SWEEP] ${error?.message || "Sweep failed"}`);
        return { scanned: 0, deleted: 0, pending: 0, failed: true };
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const ready = runOnce();
  const timer = setIntervalImpl(runOnce, configuredSweepIntervalMs(env));
  timer?.unref?.();
  return {
    ready,
    runOnce,
    stop() {
      clearIntervalImpl(timer);
    },
  };
}

async function ensureConversionSessionStateIndexes({ model = ConversionSessionState } = {}) {
  await model.createIndexes();
  const indexes = await model.collection.indexes();
  const legacyExpiryIndexes = indexes.filter((index) => {
    const keys = Object.keys(index.key || {});
    return keys.length === 1 &&
      index.key.expiresAt === 1 &&
      Object.hasOwn(index, "expireAfterSeconds");
  });
  for (const index of legacyExpiryIndexes) {
    await model.collection.dropIndex(index.name);
  }
  return { droppedIndexes: legacyExpiryIndexes.map((index) => index.name) };
}

module.exports = {
  createConversionSessionStateService,
  createMongooseSessionRepository,
  ensureConversionSessionStateIndexes,
  assertSessionBinding: (...args) => activeService().assertSessionBinding(...args),
  bindSessionUpload: (...args) => activeService().bindSessionUpload(...args),
  getSessionState: (...args) => activeService().getSessionState(...args),
  putSessionState: (...args) => activeService().putSessionState(...args),
  reserveSessionState: (...args) => activeService().reserveSessionState(...args),
  resolveSessionArtifactBinding: (...args) =>
    activeService().resolveSessionArtifactBinding(...args),
  sessionError,
  startConversionSessionStateSweeper,
  sweepExpiredSessionStates: (...args) => activeService().sweepExpiredSessionStates(...args),
};
