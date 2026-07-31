const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable } = require("node:stream");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const {
  createConversionArtifactService,
  createMongooseArtifactRepository,
  ensureConversionArtifactIndexes,
  startConversionArtifactSweeper,
} = require("../services/conversionArtifactService");

function repository() {
  const documents = [];
  const tombstones = [];
  const lifecycles = new Map();
  const lifecycleKey = (binding) => [
    binding.ownerScope,
    binding.userId,
    binding.sessionId,
    binding.uploadId,
    binding.runId,
    binding.targetTemplateId,
  ].join("\0");
  return {
    documents,
    tombstones,
    lifecycles,
    failStatusFor: null,
    failFinalDeleteStatus: false,
    async findLatest(binding) {
      return documents.find(
        (item) =>
          item.sessionId === binding.sessionId &&
          item.runId === binding.runId &&
          item.kind === binding.kind &&
          (binding.revision == null || item.revision === binding.revision),
      ) || null;
    },
    async create(metadata) {
      documents.push({ ...metadata });
      return metadata;
    },
    async markStatus(objectId, status, updates = {}) {
      if (this.failStatusFor === objectId || (this.failFinalDeleteStatus && status === "deleted")) {
        throw new Error(this.failFinalDeleteStatus && status === "deleted"
          ? "metadata delete status failed"
          : "metadata sweep status failed");
      }
      const item = documents.find((document) => document.gridFsObjectId === objectId)
        || tombstones.find((document) => document.gridFsObjectId === objectId);
      if (item) Object.assign(item, updates, { status });
    },
    async findExpired({ now, limit }) {
      return [...documents, ...tombstones]
        .filter((item) => item.status === "deletion_pending" || (item.status === "available" && item.expiresAt <= now))
        .slice(0, limit);
    },
    async findSessionArtifacts(binding, { limit }) {
      return documents.filter(
        (item) =>
          item.ownerScope === binding.ownerScope &&
          item.userId === binding.userId &&
          item.sessionId === binding.sessionId &&
          item.runId === binding.runId &&
          item.uploadId === binding.uploadId &&
          item.targetTemplateId === binding.targetTemplateId,
      ).slice(0, limit);
    },
    async deleteMetadata(objectId) {
      const index = documents.findIndex((item) => item.gridFsObjectId === objectId);
      if (index >= 0) documents.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
    async createTombstone(metadata) {
      tombstones.push(metadata);
      return metadata;
    },
    async acquireWriteLease(binding) {
      const key = lifecycleKey(binding);
      const lifecycle = lifecycles.get(key);
      if (lifecycle && lifecycle.status !== "active") return null;
      const active = lifecycle || { ...binding, status: "active", activeLeases: 0 };
      active.activeLeases += 1;
      lifecycles.set(key, active);
      return { ...active };
    },
    async releaseWriteLease(binding) {
      const lifecycle = lifecycles.get(lifecycleKey(binding));
      if (lifecycle) lifecycle.activeLeases = Math.max(0, lifecycle.activeLeases - 1);
    },
    async beginPurge(binding) {
      const key = lifecycleKey(binding);
      const lifecycle = lifecycles.get(key) || { ...binding, activeLeases: 0 };
      lifecycle.status = lifecycle.status === "purged" ? "purged" : "purging";
      lifecycles.set(key, lifecycle);
      return { ...lifecycle };
    },
    async find(binding) {
      const lifecycle = lifecycles.get(lifecycleKey(binding));
      return lifecycle ? { ...lifecycle } : null;
    },
    async markPurged(binding) {
      const lifecycle = lifecycles.get(lifecycleKey(binding));
      lifecycle.status = "purged";
      lifecycle.activeLeases = 0;
      return { ...lifecycle };
    },
  };
}

function storage() {
  const objects = new Map();
  const bindings = new Map();
  let id = 1;
  return {
    objects,
    failDeletes: false,
    async putArtifact(input) {
      const objectId = `object-${id++}`;
      objects.set(objectId, Buffer.from(input.bytes));
      bindings.set(objectId, { ...(input.metadata || {}) });
      return {
        objectId,
        sha256: require("node:crypto").createHash("sha256").update(input.bytes).digest("hex"),
        sizeBytes: input.bytes.length,
      };
    },
    async getArtifact({ objectId }) {
      const bytes = objects.get(objectId);
      return bytes ? { stream: Readable.from([bytes]), sizeBytes: bytes.length } : null;
    },
    async deleteArtifact({ objectId }) {
      if (this.failDeletes) throw new Error("delete failed");
      objects.delete(objectId);
      bindings.delete(objectId);
      return { deleted: true };
    },
    async findArtifactsByBinding(binding) {
      return [...bindings.entries()]
        .filter(([, metadata]) =>
          metadata.ownerScope === binding.ownerScope &&
          metadata.runId === binding.runId
        )
        .map(([objectId]) => ({ objectId }));
    },
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("repository includes pending tombstones in the bounded sweep regardless of retention time", async () => {
  let filter;
  const query = {
    sort() { return this; },
    limit() { return Promise.resolve([]); },
  };
  const repo = createMongooseArtifactRepository({
    find(value) {
      filter = value;
      return query;
    },
  });

  await repo.findExpired({ now: new Date("2026-07-30T00:00:00.000Z"), limit: 5 });
  const tombstoneClause = filter.$or.find((item) => item.tombstoneOnly === true);
  assert.deepEqual(tombstoneClause, { tombstoneOnly: true, status: "deletion_pending" });
});

test("artifact index setup removes the legacy TTL before creating the durable pending-tombstone index", async () => {
  const events = [];
  const model = {
    collection: {
      async indexes() {
        return [{ name: "_id_" }, { name: "purgeAt_1", key: { purgeAt: 1 }, expireAfterSeconds: 0 }];
      },
      async dropIndex(name) { events.push(`drop:${name}`); },
    },
    async createIndexes() { events.push("artifact:create"); },
  };
  const lifecycleModel = { async createIndexes() { events.push("lifecycle:create"); } };

  const result = await ensureConversionArtifactIndexes({ model, lifecycleModel });
  assert.deepEqual(events, ["drop:purgeAt_1", "artifact:create", "lifecycle:create"]);
  assert.deepEqual(result.droppedIndexes, ["purgeAt_1"]);
});

test("scheduled sweeper records only redacted candidate failures", async () => {
  const logs = [];
  const sweeper = startConversionArtifactSweeper({
    service: {
      async sweepExpiredArtifacts() {
        return { scanned: 1, deleted: 0, pending: 1, failures: [{ code: "REPOSITORY_WRITE_FAILED", statusCode: 500 }] };
      },
    },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    logger: { error: (message) => logs.push(message) },
  });

  await sweeper.ready;
  assert.deepEqual(logs, ["[ARTIFACT_SWEEP] candidate failed code=REPOSITORY_WRITE_FAILED status=500"]);
});

test("internal artifact consumers stream downloads and bound state accumulation", async () => {
  const source = await readFile(path.join(__dirname, "..", "routes", "internalConverterSessions.js"), "utf8");
  assert.match(source, /pipeline\(found\.content, res\)/);
  assert.match(source, /for await \(const chunk of stream\)/);
  assert.match(source, /size > MAX_STATE_BYTES/);
  assert.doesNotMatch(source, /res\.send\(found\.content\)|found\.content\.toString/);
});

const binding = {
  ownerScope: "user:user-1",
  userId: "user-1",
  sessionId: "session-1",
  runId: "run-1",
  uploadId: "upload-1",
  targetTemplateId: "bsn_sales",
  kind: "output",
  revision: 1,
  expiresAt: new Date(Date.now() + 60_000),
  contentType: "application/octet-stream",
};

test("all-artifact purge removes every revision, kind, metadata row, and byte", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  await service.putArtifact({ ...binding, kind: "state", content: Buffer.from("state-1") });
  await service.putArtifact({ ...binding, kind: "state", revision: 2, content: Buffer.from("state-2") });
  await service.putArtifact({ ...binding, kind: "output", content: Buffer.from("output-1") });
  await service.putArtifact({ ...binding, kind: "upload", content: Buffer.from("upload-1") });

  const result = await service.purgeSessionArtifacts(binding);

  assert.deepEqual(result, {
    success: true,
    purgeScope: "all_artifacts",
    deletedArtifacts: 4,
    remainingMetadata: 0,
    remainingBytes: 0,
  });
  assert.equal(repo.documents.length, 0);
  assert.equal(backend.objects.size, 0);
});

test("all-artifact purge fails closed when byte deletion is pending", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  await service.putArtifact({ ...binding, kind: "state", content: Buffer.from("state") });
  backend.failDeletes = true;

  await assert.rejects(
    service.purgeSessionArtifacts(binding),
    (error) => error.code === "ARTIFACT_PURGE_INCOMPLETE" && error.statusCode === 503,
  );
  assert.equal(repo.documents.length, 1);
  assert.equal(backend.objects.size, 1);
});

test("durable operation purge fence rejects writes after purge across service restart", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, lifecycleRepository: repo, storageAdapter: backend });
  await service.putArtifact({ ...binding, kind: "state", content: Buffer.from("state") });
  await service.purgeSessionArtifacts(binding);

  const restarted = createConversionArtifactService({ repository: repo, lifecycleRepository: repo, storageAdapter: backend });
  await assert.rejects(
    restarted.putArtifact({ ...binding, revision: 2, content: Buffer.from("resurrect") }),
    (error) => error.code === "ARTIFACT_OPERATION_PURGED" && error.statusCode === 410,
  );
  assert.equal(repo.documents.length, 0);
  assert.equal(backend.objects.size, 0);
});

test("operation purge drains an in-flight write lease before proving zero artifacts", async () => {
  const repo = repository();
  const backend = storage();
  const originalPut = backend.putArtifact.bind(backend);
  let releaseWrite;
  let signalWrite;
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  backend.putArtifact = async (input) => {
    const uploaded = await originalPut(input);
    signalWrite();
    await writeReleased;
    return uploaded;
  };
  const service = createConversionArtifactService({
    repository: repo,
    lifecycleRepository: repo,
    storageAdapter: backend,
    purgeLeaseWaitMs: 1_000,
    purgeLeasePollMs: 1,
  });

  const write = service.putArtifact({ ...binding, kind: "state", content: Buffer.from("state") });
  await writeStarted;
  let purgeFinished = false;
  const purge = service.purgeSessionArtifacts(binding).finally(() => { purgeFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(purgeFinished, false);

  releaseWrite();
  await write;
  const result = await purge;
  assert.equal(result.remainingMetadata, 0);
  assert.equal(result.remainingBytes, 0);
  assert.equal(repo.documents.length, 0);
  assert.equal(backend.objects.size, 0);
});

test("expired operation artifacts use the coordinated purge fence before metadata removal", async () => {
  const repo = repository();
  const backend = storage();
  let current = new Date("2026-07-31T00:00:00.000Z");
  const service = createConversionArtifactService({
    repository: repo,
    lifecycleRepository: repo,
    storageAdapter: backend,
    now: () => current,
  });
  await service.putArtifact({
    ...binding,
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
    content: Buffer.from("expiring-state"),
  });
  current = new Date("2026-07-31T00:02:00.000Z");

  const result = await service.sweepExpiredArtifacts({ limit: 10 });

  assert.deepEqual(result, { scanned: 1, deleted: 1, pending: 0, failures: [] });
  assert.equal(repo.documents.length, 0);
  assert.equal(backend.objects.size, 0);
  assert.equal([...repo.lifecycles.values()][0].status, "purged");
});

test("artifact service binds metadata, validates checksum, and compensates storage on metadata failure", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  const saved = await service.putArtifact({ ...binding, content: Buffer.from("artifact") });

  assert.equal(saved.ownerScope, binding.ownerScope);
  assert.equal(saved.runId, binding.runId);
  assert.equal(saved.status, "available");
  assert.deepEqual(await collect((await service.getArtifact(binding)).content), Buffer.from("artifact"));

  await assert.rejects(
    service.getArtifact({ ...binding, ownerScope: "user:other" }),
    (error) => error.code === "ARTIFACT_OWNER_MISMATCH",
  );
  await assert.rejects(
    service.getArtifact({ ...binding, userId: "user-2" }),
    (error) => error.code === "ARTIFACT_USER_MISMATCH",
  );

  const failingRepo = repository();
  failingRepo.create = async () => {
    throw new Error("metadata failed");
  };
  const failingStorage = storage();
  const failingService = createConversionArtifactService({
    repository: failingRepo,
    storageAdapter: failingStorage,
  });
  await assert.rejects(
    failingService.putArtifact({ ...binding, content: Buffer.from("orphan") }),
    /metadata failed/,
  );
  assert.equal(failingStorage.objects.size, 0);
});

test("artifact delete revalidates binding and keeps a tombstone when GridFS delete fails", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  const saved = await service.putArtifact({ ...binding, content: Buffer.from("artifact") });

  await assert.rejects(
    service.deleteArtifact({ ...binding, runId: "other-run" }),
    (error) => error.code === "ARTIFACT_NOT_FOUND" || error.code === "ARTIFACT_BINDING_MISMATCH",
  );
  backend.failDeletes = true;
  await assert.rejects(service.deleteArtifact(binding), /delete failed/);
  assert.equal(repo.documents[0].status, "deletion_pending");
});

test("streamed checksum failure retires corrupted bytes without buffering the download", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  const saved = await service.putArtifact({ ...binding, content: Buffer.from("artifact") });
  backend.objects.set(saved.gridFsObjectId, Buffer.from("corrupt!"));

  const found = await service.getArtifact(binding);
  await assert.rejects(collect(found.content), (error) => error.code === "ARTIFACT_CHECKSUM_MISMATCH");
  assert.equal(repo.documents[0].status, "corrupted");
  assert.equal(backend.objects.size, 0);
});

test("source stream errors terminate the HTTP pipeline instead of hanging", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  const saved = await service.putArtifact({ ...binding, content: Buffer.from("artifact") });
  const sourceError = new Error("GridFS source failed");
  backend.getArtifact = async () => ({
    sizeBytes: saved.sizeBytes,
    stream: Readable.from((async function* () {
      yield Buffer.from("artifact");
      throw sourceError;
    })()),
  });
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

  const found = await service.getArtifact(binding);
  await assert.rejects(pipeline(found.content, response), (error) => error === sourceError);
  assert.equal(response.destroyed, true);
});

test("stream size mismatch terminates the returned response pipeline", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  const saved = await service.putArtifact({ ...binding, content: Buffer.from("artifact") });
  backend.getArtifact = async () => ({
    sizeBytes: saved.sizeBytes,
    stream: Readable.from([Buffer.from("short")]),
  });
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

  const found = await service.getArtifact(binding);
  await assert.rejects(pipeline(found.content, response), (error) => error.code === "ARTIFACT_CHECKSUM_MISMATCH");
  assert.equal(response.destroyed, true);
});

test("metadata failure plus GridFS delete failure creates a purgeable tombstone", async () => {
  const repo = repository();
  repo.create = async () => { throw new Error("metadata failed"); };
  const backend = storage();
  backend.failDeletes = true;
  const service = createConversionArtifactService({
    repository: repo,
    storageAdapter: backend,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });

  await assert.rejects(service.putArtifact({ ...binding, content: Buffer.from("orphan") }), /metadata failed/);
  assert.equal(repo.tombstones.length, 1);
  assert.equal(repo.tombstones[0].status, "deletion_pending");
  assert.equal(repo.tombstones[0].purgeAt.toISOString(), "2026-08-06T00:00:00.000Z");
});

test("GridFS write cleanup failure is persisted as a purgeable tombstone", async () => {
  const repo = repository();
  const backend = storage();
  backend.putArtifact = async () => {
    const error = new Error("upload failed");
    error.code = "GRIDFS_UPLOAD_FAILED";
    error.orphanedArtifact = {
      objectId: "orphan-object",
      sha256: "a".repeat(64),
      sizeBytes: 5,
      mime: "application/octet-stream",
    };
    throw error;
  };
  const service = createConversionArtifactService({
    repository: repo,
    storageAdapter: backend,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });

  await assert.rejects(service.putArtifact({ ...binding, content: Buffer.from("orphan") }), /upload failed/);
  assert.equal(repo.tombstones.length, 1);
  assert.equal(repo.tombstones[0].gridFsObjectId, "orphan-object");
  assert.equal(repo.tombstones[0].purgeAt.toISOString(), "2026-08-06T00:00:00.000Z");
});

test("metadata failure never hides an undurable cleanup tombstone failure", async () => {
  const repo = repository();
  repo.create = async () => { throw new Error("metadata secret"); };
  repo.createTombstone = async () => { throw new Error("repository secret"); };
  const backend = storage();
  backend.failDeletes = true;
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });

  await assert.rejects(
    service.putArtifact({ ...binding, content: Buffer.from("orphan") }),
    (error) => error.code === "ARTIFACT_TOMBSTONE_FAILED" && !error.message.includes("secret"),
  );
});

test("delete marks metadata pending before deleting bytes and preserves pending state if final metadata write fails", async () => {
  const repo = repository();
  const backend = storage();
  let statusAtDelete;
  const originalDelete = backend.deleteArtifact;
  backend.deleteArtifact = async (input) => {
    statusAtDelete = repo.documents[0].status;
    return originalDelete.call(backend, input);
  };
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  await service.putArtifact({ ...binding, content: Buffer.from("artifact") });
  repo.failFinalDeleteStatus = true;

  await assert.rejects(service.deleteArtifact(binding), /metadata delete status failed/);
  assert.equal(statusAtDelete, "deletion_pending");
  assert.equal(repo.documents[0].status, "deletion_pending");
  assert.equal(backend.objects.size, 0);
});

test("sweeper does not delete bytes when the durable pending-status write fails", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({
    repository: repo,
    storageAdapter: backend,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  const saved = await service.putArtifact({ ...binding, content: Buffer.from("artifact") });
  repo.documents[0].expiresAt = new Date("2026-07-29T00:00:00.000Z");
  repo.failStatusFor = saved.gridFsObjectId;

  const result = await service.sweepExpiredArtifacts({ limit: 1 });

  assert.equal(result.pending, 1);
  assert.equal(backend.objects.has(saved.gridFsObjectId), true);
  assert.equal(repo.documents[0].status, "available");
});

test("bounded sweeper includes expired tombstones, continues after repository failures, and redacts failures", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({
    repository: repo,
    storageAdapter: backend,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  const first = await service.putArtifact({ ...binding, content: Buffer.from("first") });
  const second = await service.putArtifact({ ...binding, revision: 2, content: Buffer.from("second") });
  for (const document of repo.documents) {
    document.status = "deletion_pending";
    document.purgeAt = new Date("2026-07-29T00:00:00.000Z");
  }
  repo.tombstones.push({
    gridFsObjectId: "tombstone-object",
    purgeAt: new Date("2026-08-06T00:00:00.000Z"),
    status: "deletion_pending",
    tombstoneOnly: true,
  });
  backend.objects.set("tombstone-object", Buffer.from("orphan"));
  repo.failStatusFor = first.gridFsObjectId;

  const result = await service.sweepExpiredArtifacts({ limit: 3 });

  assert.equal(result.scanned, 3);
  assert.equal(result.deleted, 2);
  assert.equal(result.pending, 1);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(Object.keys(result.failures[0]).sort(), ["code", "statusCode"]);
  assert.equal(result.failures[0].objectId, undefined);
  assert.equal(backend.objects.has(second.gridFsObjectId), false);
  assert.equal(backend.objects.has("tombstone-object"), false);
});
