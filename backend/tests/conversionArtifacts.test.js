const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const {
  LocalArtifactStorageAdapter,
  S3CompatibleArtifactStorageAdapter,
  createConversionArtifactService,
  createArtifactStorageAdapter,
  ensureConversionArtifactIndexes,
  startConversionArtifactSweeper,
} = require("../services/conversionArtifactService");
const ConversionArtifact = require("../models/ConversionArtifact");
const ConversionSessionState = require("../models/ConversionSessionState");
const {
  createConversionSessionStateService,
  ensureConversionSessionStateIndexes,
  startConversionSessionStateSweeper,
} = require("../services/conversionSessionStateService");
const {
  authenticateInternalConversionRequest,
  createInternalConversionSessionController,
} = require("../controllers/internalConversionSessionController");
const {
  createInternalConversionSessionsRouter,
} = require("../routes/internalConversionSessions");

function memoryArtifactRepository() {
  const documents = [];
  return {
    documents,
    async upsert(metadata) {
      const existing = documents.find(
        (item) =>
          item.sessionId === metadata.sessionId &&
          item.kind === metadata.kind &&
          item.revision === metadata.revision,
      );
      if (existing) return existing;
      documents.push({ ...metadata });
      return documents.at(-1);
    },
    async findLatest({ sessionId, runId, kind, revision }) {
      return (
        documents
          .filter(
            (item) =>
              item.sessionId === sessionId &&
              item.runId === runId &&
              item.kind === kind &&
              (revision == null || item.revision === revision),
          )
          .sort((left, right) => right.revision - left.revision)[0] || null
      );
    },
    async findExpired({ now, limit }) {
      return documents
        .filter(
          (item) =>
            item.status === "deletion_pending" ||
            (item.status === "available" && new Date(item.expiresAt) <= now),
        )
        .slice(0, limit);
    },
    async markStatus(storageKey, status, updates = {}) {
      const document = documents.find((item) => item.storageKey === storageKey);
      if (document) Object.assign(document, updates, { status });
    },
  };
}

function memorySessionRepository() {
  const documents = [];
  return {
    documents,
    async find({ sessionId, runId }) {
      return documents.find(
        (item) => item.sessionId === sessionId && item.runId === runId,
      ) || null;
    },
    async reserve(metadata) {
      const existing = documents.find(
        (item) => item.sessionId === metadata.sessionId && item.runId === metadata.runId,
      );
      if (existing) return existing;
      documents.push({ ...metadata });
      return documents.at(-1);
    },
    async bindUpload(binding) {
      const index = documents.findIndex(
        (item) => item.sessionId === binding.sessionId && item.runId === binding.runId,
      );
      if (index === -1) return null;
      if (documents[index].revision !== 0 || documents[index].status !== "allocated") {
        return null;
      }
      documents[index] = { ...documents[index], ...binding };
      return documents[index];
    },
    async saveNext(metadata, previousRevision) {
      const index = documents.findIndex(
        (item) => item.sessionId === metadata.sessionId && item.runId === metadata.runId,
      );
      if (index === -1) {
        if (previousRevision !== 0) return null;
        documents.push({ ...metadata });
        return documents.at(-1);
      }
      if (documents[index].revision !== previousRevision) return null;
      documents[index] = { ...metadata };
      return documents[index];
    },
    async findExpired({ now, limit }) {
      return documents
        .filter(
          (item) =>
            item.status === "deletion_pending" ||
            (["allocated", "active"].includes(item.status) && new Date(item.expiresAt) <= now) ||
            (item.status === "expired" && item.purgeAt == null),
        )
        .slice(0, limit);
    },
    async markStatus({ sessionId, runId }, status, updates = {}) {
      const document = documents.find(
        (item) => item.sessionId === sessionId && item.runId === runId,
      );
      if (document) {
        Object.assign(document, updates, { status });
        if (Object.hasOwn(updates, "purgeAt") && updates.purgeAt == null) {
          delete document.purgeAt;
        }
      }
    },
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("local artifact adapter round-trips bytes and rejects path traversal", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-artifacts-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const adapter = new LocalArtifactStorageAdapter({ rootDir });
  const content = Buffer.from("session-state", "utf8");

  await adapter.putArtifact({
    key: "sessions/session-1/state/r1.json",
    content,
    contentType: "application/json",
    expiresAt: new Date(Date.now() + 60_000),
  });

  assert.deepEqual(
    await adapter.getArtifact({ key: "sessions/session-1/state/r1.json" }),
    content,
  );
  await adapter.deleteArtifact({ key: "sessions/session-1/state/r1.json" });
  assert.equal(
    await adapter.getArtifact({ key: "sessions/session-1/state/r1.json" }),
    null,
  );
  await assert.rejects(
    adapter.putArtifact({ key: "../escape.bin", content }),
    (error) => error.code === "INVALID_ARTIFACT_KEY",
  );
  await adapter.putArtifact({ key: "sessions/session-1/state/r2.json", content });
  await assert.rejects(
    adapter.putArtifact({
      key: "sessions/session-1/state/r2.json",
      content: Buffer.from("different-length-content"),
    }),
    (error) => error.code === "ARTIFACT_KEY_CONFLICT",
  );
});

test("production object storage requirement fails closed when S3 config is missing", () => {
  assert.throws(
    () =>
      createArtifactStorageAdapter({
        NODE_ENV: "production",
        CONVERTER_OBJECT_STORAGE_REQUIRED: "true",
      }),
    (error) =>
      error.statusCode === 503 && error.code === "OBJECT_STORAGE_CONFIG_MISSING",
  );
});

test("production artifact storage rejects local driver even when legacy flag is false", () => {
  assert.throws(
    () =>
      createArtifactStorageAdapter({
        NODE_ENV: "production",
        CONVERTER_ARTIFACT_STORAGE_DRIVER: "local",
        CONVERTER_OBJECT_STORAGE_REQUIRED: "false",
        CONVERTER_ALLOW_LOCAL_ARTIFACT_STORAGE: "true",
      }),
    (error) =>
      error.statusCode === 503 && error.code === "LOCAL_ARTIFACT_STORAGE_FORBIDDEN",
  );
});

test("local artifact storage requires an explicit development or test override", () => {
  assert.throws(
    () =>
      createArtifactStorageAdapter({
        NODE_ENV: "test",
        CONVERTER_ARTIFACT_STORAGE_DRIVER: "local",
      }),
    (error) =>
      error.statusCode === 503 && error.code === "LOCAL_ARTIFACT_STORAGE_FORBIDDEN",
  );
  assert.throws(
    () =>
      createArtifactStorageAdapter({
        CONVERTER_ARTIFACT_STORAGE_DRIVER: "local",
        CONVERTER_ALLOW_LOCAL_ARTIFACT_STORAGE: "true",
      }),
    (error) =>
      error.statusCode === 503 && error.code === "LOCAL_ARTIFACT_STORAGE_FORBIDDEN",
  );

  assert.ok(
    createArtifactStorageAdapter({
      NODE_ENV: "development",
      CONVERTER_ARTIFACT_STORAGE_DRIVER: "local",
      CONVERTER_ALLOW_LOCAL_ARTIFACT_STORAGE: "true",
    }) instanceof LocalArtifactStorageAdapter,
  );
});

test("S3-compatible adapter signs and performs put, get and delete", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === "GET") {
      return new Response(Buffer.from("remote-bytes"), { status: 200 });
    }
    return new Response(null, { status: options.method === "DELETE" ? 204 : 200 });
  };
  const adapter = new S3CompatibleArtifactStorageAdapter({
    endpoint: "https://objects.example.test",
    region: "auto",
    bucket: "ezformat-private",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    sessionToken: "session-token",
    fetchImpl,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
  });

  await adapter.putArtifact({
    key: "sessions/session-1/upload/r1.bin",
    content: Buffer.from("remote-bytes"),
    contentType: "application/octet-stream",
  });
  assert.deepEqual(
    await adapter.getArtifact({ key: "sessions/session-1/upload/r1.bin" }),
    Buffer.from("remote-bytes"),
  );
  await adapter.deleteArtifact({ key: "sessions/session-1/upload/r1.bin" });

  assert.deepEqual(requests.map((item) => item.options.method), ["PUT", "GET", "DELETE"]);
  for (const request of requests) {
    assert.match(request.options.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(request.options.headers["x-amz-security-token"], "session-token");
    assert.match(request.url, /ezformat-private\/sessions\/session-1\/upload\/r1\.bin$/);
  }
});

test("S3-compatible adapter rejects cleartext endpoints except explicit local development", () => {
  const config = {
    region: "auto",
    bucket: "ezformat-private",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    fetchImpl: async () => new Response(null, { status: 200 }),
  };
  assert.throws(
    () => new S3CompatibleArtifactStorageAdapter({
      ...config,
      endpoint: "http://objects.example.test",
    }),
    (error) => error.code === "OBJECT_STORAGE_INSECURE_ENDPOINT",
  );
  assert.throws(
    () => new S3CompatibleArtifactStorageAdapter({
      ...config,
      endpoint: "http://127.0.0.1:9000",
    }),
    (error) => error.code === "OBJECT_STORAGE_INSECURE_ENDPOINT",
  );
  assert.doesNotThrow(
    () => new S3CompatibleArtifactStorageAdapter({
      ...config,
      endpoint: "http://127.0.0.1:9000",
      allowInsecureLocalhost: true,
    }),
  );
});

test("storage factory permits cleartext S3 only for explicit local non-production use", () => {
  const config = {
    CONVERTER_ARTIFACT_STORAGE_DRIVER: "s3",
    CONVERTER_S3_ENDPOINT: "http://127.0.0.1:9000",
    CONVERTER_S3_REGION: "auto",
    CONVERTER_S3_BUCKET: "ezformat-private",
    CONVERTER_S3_ACCESS_KEY_ID: "access-key",
    CONVERTER_S3_SECRET_ACCESS_KEY: "secret-key",
    CONVERTER_S3_ALLOW_INSECURE_LOCALHOST: "true",
  };

  assert.throws(
    () => createArtifactStorageAdapter({ ...config, NODE_ENV: "production" }),
    (error) => error.code === "OBJECT_STORAGE_INSECURE_ENDPOINT",
  );
  assert.ok(
    createArtifactStorageAdapter({ ...config, NODE_ENV: "test" }) instanceof
      S3CompatibleArtifactStorageAdapter,
  );
  assert.ok(
    createArtifactStorageAdapter({ ...config, NODE_ENV: "development" }) instanceof
      S3CompatibleArtifactStorageAdapter,
  );
});

test("artifact index migration drops only legacy expiresAt TTL indexes", async () => {
  const dropped = [];
  let created = 0;
  const model = {
    async createIndexes() {
      created += 1;
    },
    collection: {
      async indexes() {
        return [
          { name: "_id_", key: { _id: 1 } },
          { name: "expiresAt_1", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
          { name: "expiresAt_archive", key: { expiresAt: 1 }, expireAfterSeconds: 3600 },
          { name: "expiresAt_lookup", key: { expiresAt: 1 } },
          { name: "manual_lookup", key: { ownerScope: 1, createdAt: -1 } },
        ];
      },
      async dropIndex(name) {
        dropped.push(name);
      },
    },
  };

  const result = await ensureConversionArtifactIndexes({ model });

  assert.equal(created, 1);
  assert.deepEqual(dropped, ["expiresAt_1", "expiresAt_archive"]);
  assert.deepEqual(result.droppedIndexes, dropped);
});

test("artifact Mongo model keeps tombstones until coordinated byte deletion", () => {
  for (const forbidden of ["content", "bytes", "rows", "state", "payload"]) {
    assert.equal(ConversionArtifact.schema.path(forbidden), undefined);
  }
  for (const required of [
    "ownerScope",
    "userId",
    "runId",
    "sessionId",
    "uploadId",
    "targetTemplateId",
    "storageKey",
    "sha256",
    "revision",
    "expiresAt",
    "status",
    "purgeAt",
  ]) {
    assert.ok(ConversionArtifact.schema.path(required), `missing ${required}`);
  }
  assert.ok(
    ConversionArtifact.schema
      .indexes()
      .some(([fields, options]) => fields.purgeAt === 1 && options.expireAfterSeconds === 0),
  );
  assert.equal(
    ConversionArtifact.schema
      .indexes()
      .some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0),
    false,
  );
});

test("artifact service stores bytes outside Mongo and enforces owner scope", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-service-"));
  const repository = memoryArtifactRepository();
  const service = createConversionArtifactService({
    repository,
    storageAdapter: new LocalArtifactStorageAdapter({ rootDir }),
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  const content = Buffer.from("raw workbook bytes");

  const stored = await service.putArtifact({
    sessionId: "session-1",
    runId: "run-1",
    ownerScope: "user:user-a",
    userId: "user-a",
    uploadId: "upload-1",
    targetTemplateId: "bsn_sales",
    kind: "upload",
    revision: 1,
    content,
    contentType: "application/vnd.ms-excel",
    expiresAt: new Date("2026-07-28T01:00:00.000Z"),
  });

  assert.equal(repository.documents.length, 1);
  assert.equal(repository.documents[0].content, undefined);
  assert.equal(repository.documents[0].bytes, undefined);
  assert.equal(repository.documents[0].sha256, stored.sha256);
  assert.deepEqual(
    (
      await service.getArtifact({
        sessionId: "session-1",
        runId: "run-1",
        ownerScope: "user:user-a",
        uploadId: "upload-1",
        targetTemplateId: "bsn_sales",
        kind: "upload",
      })
    ).content,
    content,
  );
  let expiryError;
  await assert.rejects(
    service.getArtifact({
      sessionId: "session-1",
      runId: "run-1",
      ownerScope: "user:user-b",
      uploadId: "upload-1",
      targetTemplateId: "bsn_sales",
      kind: "upload",
    }),
    (error) => error.statusCode === 403 && error.code === "ARTIFACT_OWNER_MISMATCH",
  );
  await assert.rejects(
    service.getArtifact({
      sessionId: "session-1",
      runId: "run-1",
      ownerScope: "user:user-a",
      uploadId: "upload-foreign",
      targetTemplateId: "bsn_sales",
      kind: "upload",
    }),
    (error) => error.statusCode === 403 && error.code === "ARTIFACT_BINDING_MISMATCH",
  );
});

test("expired or corrupted artifacts fail closed and expired bytes are deleted", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-expiry-"));
  const repository = memoryArtifactRepository();
  let clock = new Date("2026-07-28T00:00:00.000Z");
  const adapter = new LocalArtifactStorageAdapter({ rootDir });
  const service = createConversionArtifactService({
    repository,
    storageAdapter: adapter,
    now: () => clock,
  });
  const stored = await service.putArtifact({
    sessionId: "session-expiry",
    runId: "run-expiry",
    ownerScope: "user:user-a",
    userId: "user-a",
    uploadId: "upload-expiry",
    targetTemplateId: "bsn_sales",
    kind: "state",
    revision: 1,
    content: Buffer.from("state"),
    contentType: "application/json",
    expiresAt: new Date("2026-07-28T00:01:00.000Z"),
  });

  clock = new Date("2026-07-28T00:02:00.000Z");
  await assert.rejects(
    service.getArtifact({
      sessionId: "session-expiry",
      runId: "run-expiry",
      ownerScope: "user:user-a",
      uploadId: "upload-expiry",
      targetTemplateId: "bsn_sales",
      kind: "state",
    }),
    (error) => {
      expiryError = error;
      return error.statusCode === 410 && error.code === "ARTIFACT_EXPIRED";
    },
  );
  assert.equal(expiryError.deleted, true);
  assert.equal(await adapter.getArtifact({ key: stored.storageKey }), null);
  assert.equal(repository.documents[0].status, "expired");
  assert.ok(repository.documents[0].purgeAt > clock);
});

test("retired artifact revisions cannot be reactivated or leave orphaned bytes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-retired-"));
  const repository = memoryArtifactRepository();
  let clock = new Date("2026-07-28T00:00:00.000Z");
  const adapter = new LocalArtifactStorageAdapter({ rootDir });
  const service = createConversionArtifactService({
    repository,
    storageAdapter: adapter,
    now: () => clock,
  });
  const input = {
    sessionId: "session-retired",
    runId: "run-retired",
    ownerScope: "user:user-a",
    userId: "user-a",
    uploadId: "upload-retired",
    targetTemplateId: "bsn_sales",
    kind: "output",
    revision: 1,
    content: Buffer.from("output"),
    contentType: "application/vnd.ms-excel",
    expiresAt: new Date("2026-07-28T00:01:00.000Z"),
  };
  const stored = await service.putArtifact(input);
  clock = new Date("2026-07-28T00:02:00.000Z");
  await service.sweepExpiredArtifacts();

  await assert.rejects(
    service.putArtifact({
      ...input,
      expiresAt: new Date("2026-07-28T01:00:00.000Z"),
    }),
    (error) => error.statusCode === 410 && error.code === "ARTIFACT_REVISION_RETIRED",
  );
  assert.equal(repository.documents[0].status, "expired");
  assert.equal(await adapter.getArtifact({ key: stored.storageKey }), null);
});

test("artifact sweeper retains retryable tombstones until object deletion succeeds", async () => {
  const repository = memoryArtifactRepository();
  const objects = new Map();
  let deletionFails = true;
  let clock = new Date("2026-07-28T00:00:00.000Z");
  const storageAdapter = {
    async putArtifact({ key, content }) {
      objects.set(key, Buffer.from(content));
      return { key, created: true };
    },
    async getArtifact({ key }) {
      return objects.get(key) || null;
    },
    async deleteArtifact({ key }) {
      if (deletionFails) throw new Error("temporary object store outage");
      const deleted = objects.delete(key);
      return { deleted };
    },
  };
  const service = createConversionArtifactService({
    repository,
    storageAdapter,
    now: () => clock,
  });
  const stored = await service.putArtifact({
    sessionId: "session-sweep",
    runId: "run-sweep",
    ownerScope: "user:user-a",
    userId: "user-a",
    uploadId: "upload-sweep",
    targetTemplateId: "bsn_sales",
    kind: "output",
    revision: 1,
    content: Buffer.from("output"),
    contentType: "application/vnd.ms-excel",
    expiresAt: new Date("2026-07-28T00:01:00.000Z"),
  });

  clock = new Date("2026-07-28T00:02:00.000Z");
  const first = await service.sweepExpiredArtifacts({ limit: 10 });
  assert.deepEqual(first, { scanned: 1, deleted: 0, pending: 1 });
  assert.equal(repository.documents[0].status, "deletion_pending");
  assert.equal(repository.documents[0].purgeAt == null, true);
  assert.equal(objects.has(stored.storageKey), true);
  await assert.rejects(
    service.getArtifact({
      sessionId: "session-sweep",
      runId: "run-sweep",
      ownerScope: "user:user-a",
      uploadId: "upload-sweep",
      targetTemplateId: "bsn_sales",
      kind: "output",
    }),
    (error) => error.statusCode === 410 && error.code === "ARTIFACT_EXPIRED",
  );

  deletionFails = false;
  const retry = await service.sweepExpiredArtifacts({ limit: 10 });
  assert.deepEqual(retry, { scanned: 1, deleted: 1, pending: 0 });
  assert.equal(repository.documents[0].status, "expired");
  assert.ok(repository.documents[0].purgeAt > clock);
  assert.equal(objects.has(stored.storageKey), false);
});

test("corrupted object bytes are deleted before their metadata tombstone can expire", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ezformat-corrupted-"));
  const repository = memoryArtifactRepository();
  const clock = new Date("2026-07-28T00:00:00.000Z");
  const adapter = new LocalArtifactStorageAdapter({ rootDir });
  const service = createConversionArtifactService({
    repository,
    storageAdapter: adapter,
    now: () => clock,
  });
  const stored = await service.putArtifact({
    sessionId: "session-corrupted",
    runId: "run-corrupted",
    ownerScope: "user:user-a",
    userId: "user-a",
    uploadId: "upload-corrupted",
    targetTemplateId: "bsn_sales",
    kind: "output",
    revision: 1,
    content: Buffer.from("expected"),
    contentType: "application/vnd.ms-excel",
    expiresAt: new Date("2026-07-28T01:00:00.000Z"),
  });
  await fs.writeFile(adapter.targetPath(stored.storageKey), Buffer.from("tampered"));

  await assert.rejects(
    service.getArtifact({
      sessionId: "session-corrupted",
      runId: "run-corrupted",
      ownerScope: "user:user-a",
      uploadId: "upload-corrupted",
      targetTemplateId: "bsn_sales",
      kind: "output",
    }),
    (error) => error.statusCode === 409 && error.code === "ARTIFACT_CHECKSUM_MISMATCH",
  );
  assert.equal(await adapter.getArtifact({ key: stored.storageKey }), null);
  assert.equal(repository.documents[0].status, "corrupted");
  assert.ok(repository.documents[0].purgeAt > clock);
});

test("artifact sweeper starts immediately, stays bounded, and stops with the server", async () => {
  const calls = [];
  let scheduled = null;
  let cleared = null;
  let unrefCalled = false;
  const handle = {
    unref() {
      unrefCalled = true;
    },
  };
  const sweeper = startConversionArtifactSweeper({
    service: {
      async sweepExpiredArtifacts(options) {
        calls.push(options);
        return { scanned: 0, deleted: 0, pending: 0 };
      },
    },
    env: {
      CONVERTER_ARTIFACT_SWEEP_INTERVAL_SECONDS: "60",
      CONVERTER_ARTIFACT_SWEEP_MAX_FILES: "25",
    },
    setIntervalImpl(callback, intervalMs) {
      scheduled = { callback, intervalMs };
      return handle;
    },
    clearIntervalImpl(value) {
      cleared = value;
    },
    logger: { error() {} },
  });

  await sweeper.ready;
  assert.deepEqual(calls, [{ limit: 25 }]);
  assert.equal(scheduled.intervalMs, 60_000);
  assert.equal(unrefCalled, true);
  await scheduled.callback();
  assert.deepEqual(calls, [{ limit: 25 }, { limit: 25 }]);
  sweeper.stop();
  assert.equal(cleared, handle);
});

test("session-state Mongo model stores only ownership, version and artifact metadata", () => {
  for (const forbidden of ["state", "payload", "rows", "content", "bytes"]) {
    assert.equal(ConversionSessionState.schema.path(forbidden), undefined);
  }
  for (const required of [
    "ownerScope",
    "userId",
    "runId",
    "sessionId",
    "targetTemplateId",
    "uploadId",
    "stateArtifactKey",
    "stateSha256",
    "revision",
    "expiresAt",
    "status",
  ]) {
    assert.ok(ConversionSessionState.schema.path(required), `missing ${required}`);
  }
  assert.equal(ConversionSessionState.schema.path("revision").options.min, 0);
  assert.equal(Boolean(ConversionSessionState.schema.path("stateArtifactKey").isRequired), false);
  assert.equal(Boolean(ConversionSessionState.schema.path("stateSha256").isRequired), false);
  assert.ok(ConversionSessionState.schema.path("purgeAt"));
  assert.ok(ConversionSessionState.schema.path("status").enumValues.includes("allocated"));
  assert.ok(
    ConversionSessionState.schema
      .indexes()
      .some(([fields, options]) => fields.purgeAt === 1 && options.expireAfterSeconds === 0),
  );
  assert.equal(
    ConversionSessionState.schema
      .indexes()
      .some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0),
    false,
  );
});

test("analyze context cannot read session state or upload artifacts", async () => {
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  let stateReads = 0;
  let artifactReads = 0;
  const controller = createInternalConversionSessionController({
    sessionStateService: {
      async getSessionState() {
        stateReads += 1;
        return { metadata: {}, state: {} };
      },
    },
    artifactService: {
      async getArtifact() {
        artifactReads += 1;
        return {
          metadata: { contentType: "application/octet-stream", sha256: "a".repeat(64), revision: 1 },
          content: Buffer.from("must-not-read"),
        };
      },
    },
  });
  const contextToken = jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: "user-a",
      owner_scope: "user:user-a",
      workspace_id: null,
      conversion_run_id: "run-1",
      operation_session_id: "session-1",
      upload_id: "upload-1",
      target_template_id: "bsn_sales",
      scopes: ["analyze"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" },
  );
  const request = {
    headers: {
      "x-converter-service-token": "service-secret",
      "x-conversion-context": contextToken,
    },
    params: { sessionId: "session-1" },
  };

  try {
    await assert.rejects(
      controller.getState(
        { ...request, query: { run_id: "run-1" } },
        responseRecorder(),
      ),
      (error) => error.statusCode === 403 && error.code === "CONTEXT_SCOPE_MISMATCH",
    );
    await assert.rejects(
      controller.getArtifact(
        { ...request, params: { sessionId: "session-1", kind: "upload" }, query: { run_id: "run-1" } },
        responseRecorder(),
      ),
      (error) => error.statusCode === 403 && error.code === "CONTEXT_SCOPE_MISMATCH",
    );
    assert.equal(stateReads, 0);
    assert.equal(artifactReads, 0);
  } finally {
    if (previousServiceToken == null) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
    if (previousSecret == null) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("state and upload reads preserve owner, session, run, upload and template bindings", async () => {
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  const captured = { state: null, artifact: null };
  const controller = createInternalConversionSessionController({
    sessionStateService: {
      async getSessionState(input) {
        captured.state = input;
        return { metadata: { sessionId: input.sessionId }, state: { ok: true } };
      },
    },
    artifactService: {
      async getArtifact(input) {
        captured.artifact = input;
        return {
          metadata: { contentType: "application/octet-stream", sha256: "a".repeat(64), revision: 1 },
          content: Buffer.from("upload"),
        };
      },
    },
  });
  const contextToken = jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: "user-a",
      owner_scope: "workspace:workspace-a",
      workspace_id: "workspace-a",
      conversion_run_id: "run-1",
      operation_session_id: "session-1",
      upload_id: "upload-1",
      target_template_id: "bsn_sales",
      scopes: ["preview"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" },
  );
  const headers = {
    "x-converter-service-token": "service-secret",
    "x-conversion-context": contextToken,
  };

  try {
    await controller.getState(
      { headers, params: { sessionId: "session-1" }, query: { run_id: "run-1" } },
      responseRecorder(),
    );
    await controller.getArtifact(
      { headers, params: { sessionId: "session-1", kind: "upload" }, query: { run_id: "run-1", revision: "1" } },
      responseRecorder(),
    );
    for (const binding of [captured.state, captured.artifact]) {
      assert.deepEqual(
        {
          sessionId: binding.sessionId,
          runId: binding.runId,
          ownerScope: binding.ownerScope,
          userId: binding.userId,
          workspaceId: binding.workspaceId,
          uploadId: binding.uploadId,
          targetTemplateId: binding.targetTemplateId,
        },
        {
          sessionId: "session-1",
          runId: "run-1",
          ownerScope: "workspace:workspace-a",
          userId: "user-a",
          workspaceId: "workspace-a",
          uploadId: "upload-1",
          targetTemplateId: "bsn_sales",
        },
      );
    }
  } finally {
    if (previousServiceToken == null) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
    if (previousSecret == null) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("expired session metadata stays tombstoned until its state artifact is deleted", async () => {
  const repository = memorySessionRepository();
  const now = new Date("2026-07-28T00:00:00.000Z");
  repository.documents.push({
    ownerScope: "user:user-a",
    userId: "user-a",
    workspaceId: null,
    runId: "run-expired",
    sessionId: "session-expired",
    targetTemplateId: "bsn_sales",
    uploadId: "upload-expired",
    stateArtifactKey: "state-session-expired-r1",
    stateSha256: "a".repeat(64),
    revision: 1,
    expiresAt: new Date("2026-07-27T23:59:00.000Z"),
    status: "active",
  });
  let deleteAttempts = 0;
  const service = createConversionSessionStateService({
    repository,
    artifactService: {
      async deleteArtifact() {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("object store unavailable");
        return { deleted: true };
      },
    },
    now: () => now,
    tombstoneRetentionMs: 60_000,
  });

  const first = await service.sweepExpiredSessionStates({ limit: 10 });
  assert.deepEqual(first, { scanned: 1, deleted: 0, pending: 1 });
  assert.equal(repository.documents[0].status, "deletion_pending");
  assert.equal(repository.documents[0].purgeAt, undefined);
  assert.equal(repository.documents.length, 1);

  const second = await service.sweepExpiredSessionStates({ limit: 10 });
  assert.deepEqual(second, { scanned: 1, deleted: 1, pending: 0 });
  assert.equal(repository.documents[0].status, "expired");
  assert.ok(repository.documents[0].purgeAt > now);
  assert.equal(repository.documents.length, 1);
  assert.equal(deleteAttempts, 2);
});

test("session-state index migration replaces legacy expiresAt TTL with purgeAt TTL", async () => {
  const dropped = [];
  const model = {
    async createIndexes() {},
    collection: {
      async indexes() {
        return [
          { name: "_id_", key: { _id: 1 } },
          { name: "expiresAt_1", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
          { name: "expiresAt_lookup", key: { expiresAt: 1 } },
        ];
      },
      async dropIndex(name) {
        dropped.push(name);
      },
    },
  };
  const result = await ensureConversionSessionStateIndexes({ model });
  assert.deepEqual(result.droppedIndexes, ["expiresAt_1"]);
  assert.deepEqual(dropped, ["expiresAt_1"]);
});

test("session-state sweeper runs immediately, stays bounded and stops cleanly", async () => {
  const calls = [];
  let scheduled;
  let cleared;
  const handle = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const sweeper = startConversionSessionStateSweeper({
    service: {
      async sweepExpiredSessionStates(options) {
        calls.push(options);
        return { scanned: 0, deleted: 0, pending: 0 };
      },
    },
    env: {
      CONVERTER_SESSION_STATE_SWEEP_INTERVAL_SECONDS: "60",
      CONVERTER_SESSION_STATE_SWEEP_MAX_SESSIONS: "25",
    },
    setIntervalImpl(callback, intervalMs) {
      scheduled = { callback, intervalMs };
      return handle;
    },
    clearIntervalImpl(value) {
      cleared = value;
    },
  });
  await sweeper.ready;
  assert.deepEqual(calls, [{ limit: 25 }]);
  assert.equal(scheduled.intervalMs, 60_000);
  assert.equal(handle.unrefCalled, true);
  await scheduled.callback();
  assert.deepEqual(calls, [{ limit: 25 }, { limit: 25 }]);
  sweeper.stop();
  assert.equal(cleared, handle);
});

test("session-state reservation is metadata-only, idempotent and binding-safe", async () => {
  const repository = memorySessionRepository();
  const service = createConversionSessionStateService({
    repository,
    artifactService: {},
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  const reservation = {
    sessionId: "session-reserved",
    runId: "run-reserved",
    ownerScope: "user:user-a",
    userId: "user-a",
    workspaceId: null,
    targetTemplateId: "bsn_sales",
    expiresAt: new Date("2026-07-28T01:00:00.000Z"),
  };

  const first = await service.reserveSessionState(reservation);
  const replay = await service.reserveSessionState(reservation);

  assert.equal(first.revision, 0);
  assert.equal(first.status, "allocated");
  assert.equal(first.uploadId, "");
  assert.equal(first.stateArtifactKey, "");
  assert.equal(first.stateSha256, "");
  assert.equal(repository.documents.length, 1);
  assert.deepEqual(replay, first);
  for (const forbidden of ["state", "payload", "rows", "content", "bytes"]) {
    assert.equal(repository.documents[0][forbidden], undefined);
  }

  await assert.rejects(
    service.reserveSessionState({ ...reservation, ownerScope: "user:user-b", userId: "user-b" }),
    (error) => error.statusCode === 403 && error.code === "SESSION_OWNER_MISMATCH",
  );
  await assert.rejects(
    service.reserveSessionState({ ...reservation, targetTemplateId: "foreign-template" }),
    (error) => error.statusCode === 409 && error.code === "SESSION_BINDING_MISMATCH",
  );
});

test("session-state upload binding and first revision update the allocated reservation", async () => {
  const repository = memorySessionRepository();
  const artifacts = new Map();
  const artifactService = {
    async putArtifact(input) {
      const storageKey = `state-${input.sessionId}-r${input.revision}`;
      const sha256 = require("node:crypto")
        .createHash("sha256")
        .update(input.content)
        .digest("hex");
      artifacts.set(input.revision, { ...input, storageKey, sha256 });
      return { storageKey, sha256 };
    },
    async getArtifact(input) {
      const stored = artifacts.get(input.revision);
      return { metadata: stored, content: stored.content };
    },
  };
  const service = createConversionSessionStateService({
    repository,
    artifactService,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  const binding = {
    sessionId: "session-bound",
    runId: "run-bound",
    ownerScope: "workspace:workspace-a",
    userId: "user-a",
    workspaceId: "workspace-a",
    targetTemplateId: "bsn_sales",
    expiresAt: new Date("2026-07-28T01:00:00.000Z"),
  };
  await service.reserveSessionState(binding);
  const bound = await service.bindSessionUpload({ ...binding, uploadId: "upload-a" });
  assert.equal(bound.uploadId, "upload-a");
  assert.equal((await service.bindSessionUpload({ ...binding, uploadId: "upload-a" })).uploadId, "upload-a");
  await assert.rejects(
    service.bindSessionUpload({ ...binding, uploadId: "upload-foreign" }),
    (error) => error.statusCode === 409 && error.code === "SESSION_BINDING_MISMATCH",
  );

  await assert.rejects(
    service.putSessionState({
      ...binding,
      uploadId: "upload-a",
      revision: 1,
      state: {
        session: {
          session_id: "foreign-session",
          upload_id: "upload-a",
          owner_scope: binding.ownerScope,
          user_id: binding.userId,
          workspace_id: binding.workspaceId,
          target_template_id: binding.targetTemplateId,
        },
        table: { rows: [] },
      },
    }),
    (error) => error.statusCode === 409 && error.code === "SESSION_BINDING_MISMATCH",
  );

  const stored = await service.putSessionState({
    ...binding,
    uploadId: "upload-a",
    revision: 1,
    state: {
      session: {
        session_id: binding.sessionId,
        upload_id: "upload-a",
        owner_scope: binding.ownerScope,
        user_id: binding.userId,
        workspace_id: binding.workspaceId,
        target_template_id: binding.targetTemplateId,
      },
      table: { rows: [{ value: 10 }] },
    },
  });
  assert.equal(stored.status, "active");
  assert.equal(stored.revision, 1);
  assert.equal(stored.uploadId, "upload-a");
  assert.equal(repository.documents.length, 1);
  assert.equal(repository.documents[0].state, undefined);

  await assert.rejects(
    service.assertSessionBinding({ ...binding, uploadId: "upload-a", userId: "user-b" }),
    (error) => error.statusCode === 403 && error.code === "SESSION_OWNER_MISMATCH",
  );
  await assert.rejects(
    service.assertSessionBinding({ ...binding, uploadId: "upload-a", targetTemplateId: "foreign" }),
    (error) => error.statusCode === 409 && error.code === "SESSION_BINDING_MISMATCH",
  );
  repository.documents[0].expiresAt = new Date("2026-07-27T23:59:59.000Z");
  await assert.rejects(
    service.assertSessionBinding({ ...binding, uploadId: "upload-a" }),
    (error) => error.statusCode === 410 && error.code === "SESSION_EXPIRED",
  );
  assert.equal(repository.documents[0].status, "expired");
});

test("session-state service persists JSON in artifact storage and uses optimistic revisions", async () => {
  const repository = memorySessionRepository();
  const artifacts = new Map();
  const artifactService = {
    async putArtifact(input) {
      const storageKey = `state-${input.sessionId}-r${input.revision}`;
      const sha256 = require("node:crypto")
        .createHash("sha256")
        .update(input.content)
        .digest("hex");
      artifacts.set(input.revision, { ...input, storageKey, sha256 });
      return { storageKey, sha256 };
    },
    async getArtifact(input) {
      const stored = artifacts.get(input.revision);
      return { metadata: stored, content: stored.content };
    },
  };
  const service = createConversionSessionStateService({
    repository,
    artifactService,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });

  const stateInput = {
    sessionId: "session-1",
    runId: "run-1",
    ownerScope: "user:user-a",
    userId: "user-a",
    workspaceId: null,
    targetTemplateId: "bsn_sales",
    uploadId: "upload-1",
    revision: 1,
    state: {
      session: {
        session_id: "session-1",
        upload_id: "upload-1",
        owner_scope: "user:user-a",
        user_id: "user-a",
        workspace_id: null,
        target_template_id: "bsn_sales",
      },
      table: { rows: [{ value: 10 }] },
    },
    expiresAt: new Date("2026-07-28T01:00:00.000Z"),
  };
  await service.reserveSessionState(stateInput);
  await service.bindSessionUpload(stateInput);
  await service.putSessionState(stateInput);
  assert.equal((await service.putSessionState(stateInput)).revision, 1);
  await assert.rejects(
    service.putSessionState({
      ...stateInput,
      state: { ...stateInput.state, table: { changed: true } },
    }),
    (error) => error.statusCode === 409 && error.code === "SESSION_REVISION_CONFLICT",
  );
  const result = await service.getSessionState(stateInput);

  assert.deepEqual(result.state, stateInput.state);
  assert.equal(repository.documents[0].state, undefined);
  assert.equal(repository.documents[0].payload, undefined);
  assert.equal(repository.documents[0].stateArtifactKey, "state-session-1-r1");
  await assert.rejects(
    service.putSessionState({
      ...stateInput,
      revision: 3,
      state: { ...stateInput.state, table: { skipped: true } },
    }),
    (error) => error.statusCode === 409 && error.code === "SESSION_REVISION_CONFLICT",
  );
  await assert.rejects(
    service.getSessionState({
      ...stateInput,
      ownerScope: "user:user-b",
      userId: "user-b",
    }),
    (error) => error.statusCode === 403 && error.code === "SESSION_OWNER_MISMATCH",
  );
});

test("internal session authentication requires service token and bound signed context", () => {
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  const contextToken = jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: "user-a",
      owner_scope: "user:user-a",
      workspace_id: null,
      conversion_run_id: "run-1",
      operation_session_id: "session-1",
      upload_id: "upload-1",
      target_template_id: "bsn_sales",
      scopes: ["preview"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" },
  );
  try {
    const claims = authenticateInternalConversionRequest(
      {
        headers: {
          "x-converter-service-token": "service-secret",
          "x-conversion-context": contextToken,
        },
      },
      {
        sessionId: "session-1",
        runId: "run-1",
        uploadId: "upload-1",
        targetTemplateId: "bsn_sales",
        requiredScopes: ["preview"],
      },
    );
    assert.equal(claims.owner_scope, "user:user-a");

    assert.throws(
      () =>
        authenticateInternalConversionRequest(
          {
            headers: {
              "x-converter-service-token": "wrong",
              "x-conversion-context": contextToken,
            },
          },
          {
            sessionId: "session-1",
            runId: "run-1",
            uploadId: "upload-1",
            targetTemplateId: "bsn_sales",
            requiredScopes: ["preview"],
          },
        ),
      (error) => error.statusCode === 401 && error.code === "INVALID_SERVICE_TOKEN",
    );
    assert.throws(
      () =>
        authenticateInternalConversionRequest(
          { headers: { "x-converter-service-token": "service-secret" } },
          {
            sessionId: "session-1",
            runId: "run-1",
            uploadId: "upload-1",
            targetTemplateId: "bsn_sales",
            requiredScopes: ["preview"],
          },
        ),
      (error) => error.statusCode === 401 && error.code === "SIGNED_CONTEXT_REQUIRED",
    );
    assert.throws(
      () =>
        authenticateInternalConversionRequest(
          {
            headers: {
              "x-converter-service-token": "service-secret",
              "x-conversion-context": contextToken,
            },
          },
          {
            sessionId: "session-foreign",
            runId: "run-1",
            uploadId: "upload-1",
            targetTemplateId: "bsn_sales",
            requiredScopes: ["preview"],
          },
        ),
      (error) => error.statusCode === 403 && error.code === "CONTEXT_BINDING_MISMATCH",
    );
    assert.throws(
      () =>
        authenticateInternalConversionRequest(
          {
            headers: {
              "x-converter-service-token": "service-secret",
              "x-conversion-context": contextToken,
            },
          },
          {
            sessionId: "session-1",
            runId: "run-1",
            uploadId: "upload-1",
            targetTemplateId: "bsn_sales",
            requiredScopes: ["export"],
          },
        ),
      (error) => error.statusCode === 403 && error.code === "CONTEXT_SCOPE_MISMATCH",
    );
    assert.throws(
      () =>
        authenticateInternalConversionRequest(
          {
            headers: {
              "x-converter-service-token": "service-secret",
              "x-conversion-context": contextToken,
            },
          },
          {
            sessionId: "session-1",
            runId: "run-1",
            uploadId: "upload-foreign",
            targetTemplateId: "bsn_sales",
            requiredScopes: ["preview"],
          },
        ),
      (error) => error.statusCode === 403 && error.code === "CONTEXT_BINDING_MISMATCH",
    );
    const wrongPurpose = jwt.sign(
      {
        purpose: "misa_reconstruction",
        user_id: "user-a",
        owner_scope: "user:user-a",
        conversion_run_id: "run-1",
        operation_session_id: "session-1",
      },
      process.env.CONVERSION_CONTEXT_SECRET,
      { algorithm: "HS256", expiresIn: "10m" },
    );
    assert.throws(
      () =>
        authenticateInternalConversionRequest(
          {
            headers: {
              "x-converter-service-token": "service-secret",
              "x-conversion-context": wrongPurpose,
            },
          },
          {
            sessionId: "session-1",
            runId: "run-1",
            uploadId: "upload-1",
            targetTemplateId: "bsn_sales",
            requiredScopes: ["preview"],
          },
        ),
      (error) => error.statusCode === 401 && error.code === "SIGNED_CONTEXT_INVALID",
    );
  } finally {
    if (previousServiceToken == null) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
    if (previousSecret == null) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("internal state controller derives ownership from context and never trusts request body", async () => {
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  let captured;
  const controller = createInternalConversionSessionController({
    sessionStateService: {
      async putSessionState(input) {
        captured = input;
        return { sessionId: input.sessionId, revision: input.revision };
      },
    },
  });
  const contextToken = jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: "user-a",
      owner_scope: "user:user-a",
      workspace_id: null,
      conversion_run_id: "run-1",
      operation_session_id: "session-1",
      upload_id: "upload-1",
      target_template_id: "bsn_sales",
      scopes: ["confirm"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" },
  );
  const res = responseRecorder();
  try {
    await controller.putState(
      {
        headers: {
          "x-converter-service-token": "service-secret",
          "x-conversion-context": contextToken,
        },
        params: { sessionId: "session-1" },
        body: {
          run_id: "run-1",
          owner_scope: "user:attacker",
          revision: 1,
          state: { ready: true },
          expires_at: "2026-07-29T00:00:00.000Z",
        },
      },
      res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(captured.ownerScope, "user:user-a");
    assert.equal(captured.userId, "user-a");
  } finally {
    if (previousServiceToken == null) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
    if (previousSecret == null) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("analyze-only context cannot read output artifacts", async () => {
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  let artifactReads = 0;
  const controller = createInternalConversionSessionController({
    artifactService: {
      async getArtifact() {
        artifactReads += 1;
        return {
          metadata: { contentType: "application/vnd.ms-excel", revision: 1, sha256: "a".repeat(64) },
          content: Buffer.from("must-not-read"),
        };
      },
    },
  });
  const contextToken = jwt.sign(
    {
      purpose: "misa_conversion",
      user_id: "user-a",
      owner_scope: "user:user-a",
      workspace_id: null,
      conversion_run_id: "run-1",
      operation_session_id: "session-1",
      upload_id: "upload-1",
      target_template_id: "bsn_sales",
      scopes: ["analyze"],
    },
    process.env.CONVERSION_CONTEXT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" },
  );

  try {
    await assert.rejects(
      controller.getArtifact(
        {
          headers: {
            "x-converter-service-token": "service-secret",
            "x-conversion-context": contextToken,
          },
          params: { sessionId: "session-1", kind: "output" },
          query: { run_id: "run-1", revision: "1" },
        },
        responseRecorder(),
      ),
      (error) => error.statusCode === 403 && error.code === "CONTEXT_SCOPE_MISMATCH",
    );
    assert.equal(artifactReads, 0);
  } finally {
    if (previousServiceToken == null) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
    if (previousSecret == null) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  }
});

test("analyze artifact writes resolve the persisted session binding and fail closed", async (t) => {
  const previousServiceToken = process.env.CONVERTER_SERVICE_TOKEN;
  const previousSecret = process.env.CONVERSION_CONTEXT_SECRET;
  process.env.CONVERTER_SERVICE_TOKEN = "service-secret";
  process.env.CONVERSION_CONTEXT_SECRET = "context-secret";
  t.after(() => {
    if (previousServiceToken == null) delete process.env.CONVERTER_SERVICE_TOKEN;
    else process.env.CONVERTER_SERVICE_TOKEN = previousServiceToken;
    if (previousSecret == null) delete process.env.CONVERSION_CONTEXT_SECRET;
    else process.env.CONVERSION_CONTEXT_SECRET = previousSecret;
  });

  function contextToken({
    sessionId,
    runId,
    uploadId = "",
    targetTemplateId = "bsn_sales",
    ownerScope = "user:user-a",
    userId = "user-a",
  }) {
    return jwt.sign(
      {
        purpose: "misa_conversion",
        user_id: userId,
        owner_scope: ownerScope,
        workspace_id: null,
        conversion_run_id: runId,
        operation_session_id: sessionId,
        upload_id: uploadId,
        target_template_id: targetTemplateId,
        scopes: ["analyze"],
      },
      process.env.CONVERSION_CONTEXT_SECRET,
      { algorithm: "HS256", expiresIn: "10m" },
    );
  }

  async function harness(name, { autoDetect = false } = {}) {
    let clock = new Date("2026-07-28T00:00:00.000Z");
    const artifactRepository = memoryArtifactRepository();
    const objects = new Map();
    const artifactService = createConversionArtifactService({
      repository: artifactRepository,
      storageAdapter: {
        async putArtifact({ key, content }) {
          objects.set(key, Buffer.from(content));
          return { key, created: true };
        },
        async getArtifact({ key }) {
          return objects.get(key) || null;
        },
        async deleteArtifact({ key }) {
          return { deleted: objects.delete(key) };
        },
      },
      now: () => clock,
    });
    const sessionStateService = createConversionSessionStateService({
      repository: memorySessionRepository(),
      artifactService,
      now: () => clock,
    });
    const controller = createInternalConversionSessionController({
      artifactService,
      sessionStateService,
    });
    const binding = {
      sessionId: `session-${name}`,
      runId: `run-${name}`,
      ownerScope: "user:user-a",
      userId: "user-a",
      workspaceId: null,
      uploadId: `upload-${name}`,
      targetTemplateId: "bsn_sales",
      expiresAt: new Date("2026-07-28T01:00:00.000Z"),
    };
    await sessionStateService.reserveSessionState(binding);
    const token = contextToken({
      ...binding,
      uploadId: "",
      targetTemplateId: autoDetect ? "" : binding.targetTemplateId,
    });
    return {
      artifactRepository,
      binding,
      controller,
      expire() {
        clock = new Date("2026-07-28T02:00:00.000Z");
      },
      token,
      async bindState() {
        await controller.putState(
          {
            headers: {
              "x-converter-service-token": "service-secret",
              "x-conversion-context": token,
            },
            params: { sessionId: binding.sessionId },
            body: {
              run_id: binding.runId,
              revision: 1,
              state: {
                session: {
                  session_id: binding.sessionId,
                  upload_id: binding.uploadId,
                  owner_scope: binding.ownerScope,
                  user_id: binding.userId,
                  workspace_id: binding.workspaceId,
                  target_template_id: binding.targetTemplateId,
                },
                table: { headers: [], rows: [] },
              },
              expires_at: binding.expiresAt.toISOString(),
            },
          },
          responseRecorder(),
        );
      },
      putUpload(context = token) {
        return controller.putArtifact(
          {
            headers: {
              "x-converter-service-token": "service-secret",
              "x-conversion-context": context,
            },
            params: { sessionId: binding.sessionId, kind: "upload" },
            body: {
              run_id: binding.runId,
              upload_id: "request-body-must-not-be-trusted",
              target_template_id: "request-body-must-not-be-trusted",
              revision: 1,
              content_base64: Buffer.from("raw workbook").toString("base64"),
              content_type: "application/vnd.ms-excel",
              expires_at: binding.expiresAt.toISOString(),
            },
          },
          responseRecorder(),
        );
      },
    };
  }

  await t.test("reserved then state-bound analyze session stores the upload", async () => {
    const fixture = await harness("success");
    await fixture.bindState();

    const response = await fixture.putUpload();

    assert.equal(response.statusCode, 201);
    const upload = fixture.artifactRepository.documents.find((item) => item.kind === "upload");
    assert.equal(upload.uploadId, fixture.binding.uploadId);
    assert.equal(upload.targetTemplateId, fixture.binding.targetTemplateId);
  });

  await t.test("auto-detect analyze context binds the detected template in state", async () => {
    const fixture = await harness("auto-detect", { autoDetect: true });
    await fixture.bindState();

    const response = await fixture.putUpload();

    assert.equal(response.statusCode, 201);
    const upload = fixture.artifactRepository.documents.find((item) => item.kind === "upload");
    assert.equal(upload.targetTemplateId, fixture.binding.targetTemplateId);
  });

  await t.test("unbound reservation cannot store an upload", async () => {
    const fixture = await harness("missing");
    await assert.rejects(
      fixture.putUpload(),
      (error) => error.statusCode === 409 && error.code === "SESSION_STATE_NOT_ACTIVE",
    );
    assert.equal(fixture.artifactRepository.documents.length, 0);
  });

  await t.test("token binding mismatch cannot store an upload", async () => {
    const fixture = await harness("wrong");
    await fixture.bindState();
    const wrongToken = contextToken({
      ...fixture.binding,
      uploadId: "upload-foreign",
    });
    await assert.rejects(
      fixture.putUpload(wrongToken),
      (error) => error.statusCode === 409 && error.code === "SESSION_BINDING_MISMATCH",
    );
    assert.equal(
      fixture.artifactRepository.documents.filter((item) => item.kind === "upload").length,
      0,
    );
  });

  await t.test("expired session cannot store an upload", async () => {
    const fixture = await harness("stale");
    await fixture.bindState();
    fixture.expire();
    await assert.rejects(
      fixture.putUpload(),
      (error) => error.statusCode === 410 && error.code === "SESSION_EXPIRED",
    );
    assert.equal(
      fixture.artifactRepository.documents.filter((item) => item.kind === "upload").length,
      0,
    );
  });
});

test("internal converter session router exposes Node-only state and artifact endpoints", () => {
  const router = createInternalConversionSessionsRouter({
    putState() {},
    getState() {},
    putArtifact() {},
    getArtifact() {},
    deleteArtifact() {},
  });
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.deepEqual(routes, [
    "PUT /:sessionId/state",
    "GET /:sessionId/state",
    "PUT /:sessionId/artifacts/:kind",
    "GET /:sessionId/artifacts/:kind",
    "DELETE /:sessionId/artifacts/:kind",
  ]);
});

test("backend mounts the internal converter session router", () => {
  const { app } = require("../server");
  const mounted = app._router.stack.some(
    (layer) =>
      layer.name === "router" &&
      String(layer.regexp).includes("converter-sessions"),
  );
  assert.equal(mounted, true);
});
