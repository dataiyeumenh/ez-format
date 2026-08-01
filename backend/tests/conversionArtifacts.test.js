const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { Readable } = require("node:stream");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const {
  createConversionArtifactService,
  createMongooseArtifactRepository,
  createMongooseOperationLifecycleRepository,
  assertArtifactLifecycleKeyCoverage,
  ensureConversionArtifactIndexes,
  migrateConversionOperationLifecycles,
  normalizeArtifactLifecycleMigrationMode,
  startConversionArtifactSweeper,
} = require("../services/conversionArtifactService");

function repository() {
  const documents = [];
  const tombstones = [];
  const lifecycles = new Map();
  let leaseSequence = 0;
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
    async createWriteIntent(metadata) {
      const intent = { ...metadata, status: "write_intent" };
      documents.push(intent);
      return intent;
    },
    async publishWriteIntent(objectId, metadata) {
      const intent = documents.find((item) => item.gridFsObjectId === objectId);
      if (!intent || intent.status !== "write_intent") return null;
      Object.assign(intent, metadata, { status: "available" });
      return intent;
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
        .filter((item) => item.status === "write_intent" || item.status === "deletion_pending" || (item.status === "available" && item.expiresAt <= now))
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
    async findSessionRetentionHorizon(binding) {
      const siblings = documents.filter(
        (item) =>
          item.ownerScope === binding.ownerScope &&
          item.userId === binding.userId &&
          item.sessionId === binding.sessionId &&
          item.runId === binding.runId &&
          item.uploadId === binding.uploadId &&
          item.targetTemplateId === binding.targetTemplateId,
      );
      return siblings.reduce(
        (latest, item) => item.expiresAt > latest ? item.expiresAt : latest,
        new Date(0),
      );
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
    async acquireWriteLease(binding, { retainUntil } = {}) {
      const key = lifecycleKey(binding);
      const lifecycle = lifecycles.get(key);
      if (lifecycle && lifecycle.status !== "active") return null;
      const active = lifecycle || { ...binding, status: "active", activeLeases: 0, renewals: 0 };
      const leaseId = `lease-${++leaseSequence}`;
      active.activeLeases += 1;
      active.leaseId = leaseId;
      if (retainUntil && (!active.retainUntil || retainUntil > active.retainUntil)) {
        active.retainUntil = retainUntil;
      }
      lifecycles.set(key, active);
      return { ...active, leaseId };
    },
    async renewWriteLease(binding, leaseId) {
      const lifecycle = lifecycles.get(lifecycleKey(binding));
      if (!lifecycle || lifecycle.status !== "active" || lifecycle.leaseId !== leaseId) return null;
      lifecycle.renewals += 1;
      return { ...lifecycle, leaseId };
    },
    async validateWriteLease(binding, leaseId) {
      const lifecycle = lifecycles.get(lifecycleKey(binding));
      if (!lifecycle || lifecycle.status !== "active" || lifecycle.leaseId !== leaseId) return null;
      return { ...lifecycle, leaseId };
    },
    async releaseWriteLease(binding, leaseId) {
      const lifecycle = lifecycles.get(lifecycleKey(binding));
      if (lifecycle && lifecycle.leaseId === leaseId) lifecycle.activeLeases = Math.max(0, lifecycle.activeLeases - 1);
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
      const objectId = input.objectId || `object-${id++}`;
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

test("Mongo lease renewal remains in the cast update", () => {
  const mongoose = require("mongoose");
  const Model = mongoose.models.ConversionOperationLifecycle;
  const leaseExpiresAt = new Date("2026-08-02T00:00:00.000Z");
  const query = Model.updateOne(
    { operationKey: "a".repeat(64), "writeLeases.leaseId": "lease-1" },
    { $set: { "writeLeases.$.leaseExpiresAt": leaseExpiresAt } },
  );

  const cast = query._castUpdate(query.getUpdate());

  assert.equal(
    cast.$set["writeLeases.$.leaseExpiresAt"].toISOString(),
    leaseExpiresAt.toISOString(),
  );
});

test("artifact lifecycle migration modes are explicit", () => {
  assert.equal(normalizeArtifactLifecycleMigrationMode(), "off");
  assert.equal(normalizeArtifactLifecycleMigrationMode(" DRY-RUN "), "dry-run");
  assert.equal(normalizeArtifactLifecycleMigrationMode("apply"), "apply");
  assert.throws(
    () => normalizeArtifactLifecycleMigrationMode("rollback"),
    /off, dry-run, or apply/,
  );
});

function lifecycleMigrationHarness(initialDocuments, extraIndexes = []) {
  const documents = initialDocuments.map((document) => ({ ...document }));
  const oldIndexName = "ownerScope_1_userId_1_sessionId_1_uploadId_1_runId_1_targetTemplateId_1";
  const oldIndex = {
    name: oldIndexName,
    unique: true,
    key: {
      ownerScope: 1,
      userId: 1,
      sessionId: 1,
      uploadId: 1,
      runId: 1,
      targetTemplateId: 1,
    },
  };
  const events = [];
  const canaries = keyCanaryCollection();
  let indexes = [{ name: "_id_", key: { _id: 1 } }, oldIndex, ...extraIndexes];
  const hasRawBinding = (document) => [
    "ownerScope", "userId", "sessionId", "uploadId", "runId", "targetTemplateId",
  ].some((field) => Object.hasOwn(document, field));
  const hasLegacyLifecycle = (document) =>
    hasRawBinding(document) ||
    !Array.isArray(document.operationKeys);
  const cursorFor = (filter) => {
    let limit = 100;
    const minimumId = filter?._id?.$gt;
    const matches = documents
      .filter(hasLegacyLifecycle)
      .filter((document) => minimumId == null || document._id > minimumId)
      .sort((left, right) => left._id - right._id);
    return {
      sort() { return this; },
      limit(value) { limit = value; return this; },
      async toArray() { return matches.slice(0, limit).map((document) => ({ ...document })); },
    };
  };
  const collection = {
    find(filter) {
      return filter?.recordType === "artifact_lifecycle_key_canary"
        ? canaries.find(filter)
        : cursorFor(filter);
    },
    findOne: (...args) => canaries.findOne(...args),
    updateOne: (...args) => canaries.updateOne(...args),
    async countDocuments() { return documents.filter(hasLegacyLifecycle).length; },
    async indexes() { return indexes.map((index) => ({ ...index, key: { ...index.key } })); },
    async dropIndex(name) {
      events.push(`drop:${name}`);
      indexes = indexes.filter((index) => index.name !== name);
    },
    async bulkWrite(operations) {
      const phase = operations.some((operation) => operation.updateOne.update.$unset)
        ? "unset"
        : "set";
      events.push(`bulk:${phase}`);
      for (const operation of operations) {
        const document = documents.find((item) => item._id === operation.updateOne.filter._id);
        assert.ok(document);
        Object.assign(document, operation.updateOne.update.$set || {});
        for (const field of Object.keys(operation.updateOne.update.$unset || {})) delete document[field];
      }
      return { matchedCount: operations.length, modifiedCount: operations.length };
    },
  };
  return {
    collection,
    documents,
    events,
    model: {
      collection,
      async createIndexes() { events.push("create:indexes"); },
    },
  };
}

test("artifact lifecycle migration dry-run reports legacy fences without writes", async () => {
  const harness = lifecycleMigrationHarness([{
    _id: 1,
    ownerScope: "user:user-1",
    userId: "user-1",
    sessionId: "session-1",
    uploadId: "upload-1",
    runId: "run-1",
    targetTemplateId: "bsn_sales",
    status: "active",
  }]);

  const off = await migrateConversionOperationLifecycles({
    model: new Proxy({}, { get() { throw new Error("off mode touched Mongo"); } }),
    mode: "off",
  });
  const dryRun = await migrateConversionOperationLifecycles({
    model: harness.model,
    mode: "dry-run",
    hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
  });

  assert.equal(off.mode, "off");
  assert.equal(dryRun.legacyDocuments, 1);
  assert.equal(dryRun.oldUniqueIndexPresent, true);
  assert.deepEqual(harness.events, []);
  assert.equal(Object.hasOwn(harness.documents[0], "operationKey"), false);
});

test("artifact lifecycle apply HMAC-backfills and preserves purged fences before exact index replacement", async () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const harness = lifecycleMigrationHarness([
    {
      _id: 1,
      ownerScope: "user:user-1",
      userId: "user-1",
      sessionId: "active-session",
      uploadId: "upload-1",
      runId: "run-1",
      targetTemplateId: "bsn_sales",
      status: "active",
      writeLeases: [{
        leaseId: "legacy-lease",
        expiresAt: new Date("2026-08-01T00:01:00.000Z"),
      }],
    },
    {
      _id: 2,
      ownerScope: "user:user-1",
      userId: "user-1",
      sessionId: "purged-session",
      uploadId: "upload-2",
      runId: "run-2",
      targetTemplateId: "bsn_sales",
      status: "purged",
      purgedAt: new Date("2026-07-31T00:00:00.000Z"),
      retainUntil: new Date("2026-08-10T00:00:00.000Z"),
    },
  ]);

  const report = await migrateConversionOperationLifecycles({
    model: harness.model,
    mode: "apply",
    hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
    now: () => now,
    batchSize: 1,
  });

  assert.equal(report.migratedDocuments, 2);
  assert.equal(report.remainingLegacyDocuments, 0);
  assert.deepEqual(report.droppedIndexes, [
    "ownerScope_1_userId_1_sessionId_1_uploadId_1_runId_1_targetTemplateId_1",
  ]);
  assert.deepEqual(harness.events, [
    "bulk:set",
    "bulk:set",
    "drop:ownerScope_1_userId_1_sessionId_1_uploadId_1_runId_1_targetTemplateId_1",
    "bulk:unset",
    "bulk:unset",
    "create:indexes",
  ]);
  for (const document of harness.documents) {
    assert.deepEqual(document.operationKeys.map(({ keyId }) => keyId), ["v1"]);
    assert.match(document.operationKeys[0].operationKey, /^[a-f0-9]{64}$/);
    assert.equal(document.operationKey, document.operationKeys[0].operationKey);
    for (const field of ["ownerScope", "userId", "sessionId", "uploadId", "runId", "targetTemplateId"]) {
      assert.equal(Object.hasOwn(document, field), false);
    }
  }
  assert.equal(harness.documents[1].status, "purged");
  assert.ok(harness.documents[1].purgeAt >= harness.documents[1].retainUntil);
  assert.equal(harness.documents[0].writeLeases[0].leaseId, "legacy-lease");
  assert.equal(Object.hasOwn(harness.documents[0].writeLeases[0], "expiresAt"), false);
  assert.ok(harness.documents[0].writeLeases[0].leaseExpiresAt instanceof Date);

  harness.events.length = 0;
  const reapplied = await migrateConversionOperationLifecycles({
    model: harness.model,
    mode: "apply",
    hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
    now: () => now,
    batchSize: 1,
  });
  assert.equal(reapplied.migratedDocuments, 0);
  assert.deepEqual(harness.events, ["create:indexes"]);
});

function keyCanaryCollection() {
  const documents = new Map();
  return {
    documents,
    async updateOne(filter, update, options) {
      const id = String(filter._id);
      if (!documents.has(id) && options?.upsert) {
        documents.set(id, structuredClone({ _id: filter._id, ...update.$setOnInsert }));
        return { upsertedCount: 1, matchedCount: 0 };
      }
      const document = documents.get(id);
      if (document && update.$max?.requiredUntil > (document.requiredUntil || new Date(0))) {
        document.requiredUntil = structuredClone(update.$max.requiredUntil);
      }
      return { upsertedCount: 0, matchedCount: document ? 1 : 0 };
    },
    async findOne(filter) {
      return structuredClone(documents.get(String(filter._id)) || null);
    },
    find(filter) {
      const matches = [...documents.values()].filter((document) =>
        !filter?.recordType || document.recordType === filter.recordType
      );
      return {
        async toArray() { return structuredClone(matches); },
      };
    },
  };
}

test("old HEAD and rotating lifecycle repositories share the legacy operationKey fence", async () => {
  const oldSecret = "old-artifact-lifecycle-secret-at-least-32-characters";
  const newSecret = "new-artifact-lifecycle-secret-at-least-32-characters";
  const rotationHorizon = new Date("2026-09-01T00:00:00.000Z");
  let document = null;
  const clone = (value) => value && structuredClone(value);
  const oldOperationKey = crypto.createHmac("sha256", oldSecret).update([
    binding.ownerScope,
    binding.userId,
    binding.sessionId,
    binding.uploadId,
    binding.runId,
    binding.targetTemplateId,
  ].join("\0")).digest("hex");
  const matchesClause = (clause) => {
    const legacyKeys = clause?.operationKey?.$in || (
      typeof clause?.operationKey === "string" ? [clause.operationKey] : []
    );
    const aliases = clause?.["operationKeys.operationKey"]?.$in || [];
    return legacyKeys.includes(document?.operationKey) || aliases.some((key) =>
      (document?.operationKeys || []).some((alias) => alias.operationKey === key)
    );
  };
  const matches = (filter) => document &&
    (!filter.status || filter.status === document.status) &&
    (filter.$or || [filter]).some(matchesClause);
  const model = {
    collection: keyCanaryCollection(),
    async countDocuments() { return 0; },
    async findOneAndUpdate(filter, update) {
      if (!matches(filter) || (filter.status && document.status !== filter.status)) return null;
      if (update.$addToSet?.operationKeys?.$each) {
        document.operationKeys ||= [];
        for (const alias of update.$addToSet.operationKeys.$each) {
          if (!document.operationKeys.some((item) => item.operationKey === alias.operationKey)) {
            document.operationKeys.push(clone(alias));
          }
        }
      }
      if (update.$addToSet?.requiredPreviousKeyIds?.$each) {
        document.requiredPreviousKeyIds = [
          ...new Set([
            ...(document.requiredPreviousKeyIds || []),
            ...update.$addToSet.requiredPreviousKeyIds.$each,
          ]),
        ];
      }
      if (update.$push?.writeLeases) document.writeLeases.push(clone(update.$push.writeLeases));
      if (update.$pull?.writeLeases) {
        document.writeLeases = document.writeLeases.filter(
          (lease) => lease.leaseExpiresAt > update.$pull.writeLeases.leaseExpiresAt.$lte,
        );
      }
      if (update.$set) Object.assign(document, clone(update.$set));
      if (update.$max?.retainUntil && update.$max.retainUntil > (document.retainUntil || new Date(0))) {
        document.retainUntil = update.$max.retainUntil;
      }
      if (update.$max?.keyRingRetainUntil && update.$max.keyRingRetainUntil > (document.keyRingRetainUntil || new Date(0))) {
        document.keyRingRetainUntil = update.$max.keyRingRetainUntil;
      }
      return clone(document);
    },
    async create(payload) {
      if (document) {
        const error = new Error("duplicate lifecycle");
        error.code = 11000;
        throw error;
      }
      document = clone(payload);
      return clone(document);
    },
    async findOne(filter) { return matches(filter) ? clone(document) : null; },
    async updateOne(filter, update) {
      if (!matches(filter)) return { matchedCount: 0 };
      if (update.$pull?.writeLeases?.leaseId) {
        document.writeLeases = document.writeLeases.filter(
          (lease) => lease.leaseId !== update.$pull.writeLeases.leaseId,
        );
      }
      return { matchedCount: 1 };
    },
  };
  const oldHeadInstance = {
    async acquireWriteLease() {
      const lease = {
        leaseId: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
      };
      const filter = { operationKey: oldOperationKey, status: "active" };
      const current = await model.findOneAndUpdate(filter, { $push: { writeLeases: lease } });
      if (current) return { ...current, leaseId: lease.leaseId };
      try {
        return { ...(await model.create({
          operationKey: oldOperationKey,
          status: "active",
          writeLeases: [lease],
        })), leaseId: lease.leaseId };
      } catch (error) {
        if (error.code === 11000) throw new Error("Operation session is no longer writable");
        throw error;
      }
    },
    async releaseWriteLease(leaseId) {
      await model.updateOne(
        { operationKey: oldOperationKey },
        { $pull: { writeLeases: { leaseId } } },
      );
    },
  };
  await assertArtifactLifecycleKeyCoverage({
    model,
    hmacSecret: oldSecret,
    activeKeyId: "v1",
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const rotatingInstance = createMongooseOperationLifecycleRepository(model, {
    hmacSecret: newSecret,
    activeKeyId: "v2",
    previousKeys: { v1: oldSecret },
    rotationHorizon,
  });

  const oldLease = await oldHeadInstance.acquireWriteLease();
  await oldHeadInstance.releaseWriteLease(oldLease.leaseId);
  const newLease = await rotatingInstance.acquireWriteLease(binding);
  await rotatingInstance.releaseWriteLease(binding, newLease.leaseId);

  assert.equal(document.operationKey, oldOperationKey);
  assert.deepEqual(document.operationKeys.map(({ keyId }) => keyId).sort(), ["v1", "v2"]);
  assert.deepEqual(document.requiredPreviousKeyIds, ["v1"]);
  assert.equal(document.keyRingRetainUntil.toISOString(), rotationHorizon.toISOString());

  await rotatingInstance.beginPurge(binding, new Date("2026-08-20T00:00:00.000Z"));
  await rotatingInstance.markPurged(binding, new Date("2026-08-20T00:00:00.000Z"));
  assert.equal(document.purgeAt.toISOString(), rotationHorizon.toISOString());
  await assert.rejects(oldHeadInstance.acquireWriteLease(), /no longer writable/i);

  await assert.rejects(
    assertArtifactLifecycleKeyCoverage({
      model: {
        async countDocuments(filter) {
          assert.deepEqual(filter.requiredPreviousKeyIds.$elemMatch.keyId.$nin, ["v2"]);
          return 1;
        },
      },
      hmacSecret: newSecret,
      activeKeyId: "v2",
      rotationHorizon,
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    }),
    /previous lifecycle key.*retention horizon/i,
  );
});

test("lifecycle key canaries require bootstrap, bind previous material, and retain rotation horizon", async () => {
  const collection = keyCanaryCollection();
  const model = {
    collection,
    async countDocuments() { return 0; },
  };
  const firstSecret = "first-artifact-lifecycle-secret-at-least-32-characters";
  const wrongSecret = "wrong-artifact-lifecycle-secret-at-least-32-characters";
  const nextSecret = "next-artifact-lifecycle-secret-at-least-32-characters";
  const rotationHorizon = new Date("2026-09-01T00:00:00.000Z");

  await assertArtifactLifecycleKeyCoverage({
    model,
    hmacSecret: firstSecret,
    activeKeyId: "v1",
  });
  await assert.rejects(
    assertArtifactLifecycleKeyCoverage({
      model,
      hmacSecret: wrongSecret,
      activeKeyId: "v1",
    }),
    /key id.*different secret material/i,
  );
  const missingCollection = keyCanaryCollection();
  await assert.rejects(
    assertArtifactLifecycleKeyCoverage({
      model: {
        collection: missingCollection,
        async countDocuments() { return 0; },
      },
      hmacSecret: nextSecret,
      activeKeyId: "v2",
      previousKeys: { v1: firstSecret },
      rotationHorizon,
    }),
    /previous.*canary.*bootstrap/i,
  );
  assert.equal(missingCollection.documents.size, 0);
  await assert.rejects(
    assertArtifactLifecycleKeyCoverage({
      model,
      hmacSecret: nextSecret,
      activeKeyId: "v2",
      previousKeys: { v1: wrongSecret },
      rotationHorizon,
    }),
    /key id.*different secret material/i,
  );
  assert.equal(collection.documents.size, 1);
  await assertArtifactLifecycleKeyCoverage({
    model,
    hmacSecret: nextSecret,
    activeKeyId: "v2",
    previousKeys: { v1: firstSecret },
    rotationHorizon,
  });
  const previousCanary = [...collection.documents.values()].find(({ keyId }) => keyId === "v1");
  assert.equal(previousCanary.requiredUntil.toISOString(), rotationHorizon.toISOString());
  await assert.rejects(
    assertArtifactLifecycleKeyCoverage({
      model,
      hmacSecret: nextSecret,
      activeKeyId: "v2",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    }),
    /previous lifecycle key.*retention horizon/i,
  );

  const serialized = JSON.stringify([...collection.documents.values()]);
  assert.equal(serialized.includes(firstSecret), false);
  assert.equal(serialized.includes(wrongSecret), false);
  assert.equal(serialized.includes(binding.sessionId), false);
});

test("lifecycle rotation guidance requires a one-key canary bootstrap release", async () => {
  const [rootEnv, backendEnv, runbook] = await Promise.all([
    readFile(path.join(__dirname, "..", "..", ".env.example"), "utf8"),
    readFile(path.join(__dirname, "..", ".env.example"), "utf8"),
    readFile(path.join(
      __dirname,
      "..",
      "..",
      "docs",
      "deployment",
      "main-experimental-rollback-runbook.md",
    ), "utf8"),
  ]);

  assert.match(rootEnv, /first deploy the current key alone to persist its canary/i);
  assert.match(backendEnv, /first deploy the current key alone to persist its Mongo[\s#]+canary/i);
  assert.match(runbook, /one-key bootstrap release before any\s+multi-key release/i);
  assert.match(runbook, /\*_PREVIOUS_KEYS=\{\}/);
});

test("artifact lifecycle migration never drops an index with the legacy name but wrong contract", async () => {
  const harness = lifecycleMigrationHarness([]);
  harness.collection.indexes = async () => [{
    name: "ownerScope_1_userId_1_sessionId_1_uploadId_1_runId_1_targetTemplateId_1",
    unique: false,
    key: { ownerScope: 1 },
  }];

  await assert.rejects(
    migrateConversionOperationLifecycles({
      model: harness.model,
      mode: "apply",
      hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
    }),
    /legacy lifecycle index contract/i,
  );
  assert.deepEqual(harness.events, []);
});

test("artifact lifecycle migration retains the old operationKey index and field for rolling compatibility", async () => {
  const legacyKey = "a".repeat(64);
  const harness = lifecycleMigrationHarness(
    [{
      _id: 1,
      operationKey: legacyKey,
      status: "purged",
      writeLeases: [],
      purgeAt: new Date("2026-09-01T00:00:00.000Z"),
    }],
    [{ name: "operationKey_1", unique: true, key: { operationKey: 1 } }],
  );

  const report = await migrateConversionOperationLifecycles({
    model: harness.model,
    mode: "apply",
    hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
    activeKeyId: "v1",
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });

  assert.deepEqual(report.droppedIndexes, [
    "ownerScope_1_userId_1_sessionId_1_uploadId_1_runId_1_targetTemplateId_1",
  ]);
  assert.equal(report.oldOperationKeyIndexPresent, true);
  assert.equal(harness.documents[0].operationKey, legacyKey);
  assert.deepEqual(harness.documents[0].operationKeys, [{
    keyId: "v1",
    operationKey: legacyKey,
  }]);
  assert.equal(harness.documents[0].status, "purged");

  harness.events.length = 0;
  const reapplied = await migrateConversionOperationLifecycles({
    model: harness.model,
    mode: "apply",
    hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
    activeKeyId: "v1",
  });
  assert.equal(reapplied.migratedDocuments, 0);
  assert.deepEqual(harness.events, ["create:indexes"]);
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
  await assert.rejects(
    write,
    (error) => error.code === "ARTIFACT_OPERATION_PURGED",
  );
  const result = await purge;
  assert.equal(result.remainingMetadata, 0);
  assert.equal(result.remainingBytes, 0);
  assert.equal(repo.documents.length, 0);
  assert.equal(backend.objects.size, 0);
});

test("artifact write heartbeat renews its lease until publication", async () => {
  const repo = repository();
  const backend = storage();
  const originalPut = backend.putArtifact.bind(backend);
  backend.putArtifact = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    return originalPut(input);
  };
  const service = createConversionArtifactService({
    repository: repo,
    lifecycleRepository: repo,
    storageAdapter: backend,
    leaseHeartbeatIntervalMs: 5,
  });

  await service.putArtifact({ ...binding, content: Buffer.from("long-write") });

  const lifecycle = [...repo.lifecycles.values()][0];
  assert.ok(lifecycle.renewals >= 2);
  assert.equal(lifecycle.activeLeases, 0);
});

test("Mongo-backed heartbeat keeps a write alive beyond its original lease", async () => {
  let document = null;
  let renewals = 0;
  let initialLeaseExpiry = null;
  const clone = (value) => value && {
    ...value,
    writeLeases: value.writeLeases.map((lease) => ({ ...lease })),
  };
  const activeLease = (filter) => {
    const condition = filter?.writeLeases?.$elemMatch;
    if (!document || document.status !== filter.status || !condition) return null;
    return document.writeLeases.find((lease) =>
      lease.leaseId === condition.leaseId &&
      lease.leaseExpiresAt > condition.leaseExpiresAt.$gt
    );
  };
  const model = {
    collection: keyCanaryCollection(),
    async findOneAndUpdate(filter, update) {
      if (!document) return null;
      if (update.$push?.writeLeases) {
        if (document.status !== "active") return null;
        document.writeLeases.push({ ...update.$push.writeLeases });
        return clone(document);
      }
      const lease = activeLease(filter);
      if (!lease) return null;
      lease.leaseExpiresAt = update.$set["writeLeases.$.leaseExpiresAt"];
      renewals += 1;
      return clone(document);
    },
    async create(payload) {
      document = clone(payload);
      initialLeaseExpiry = document.writeLeases[0].leaseExpiresAt;
      return clone(document);
    },
    async findOne(filter) {
      return activeLease(filter) ? clone(document) : null;
    },
    async updateOne(_filter, update) {
      const leaseId = update.$pull.writeLeases.leaseId;
      document.writeLeases = document.writeLeases.filter((lease) => lease.leaseId !== leaseId);
    },
  };
  const lifecycle = createMongooseOperationLifecycleRepository(model, {
    hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
    leaseLifetimeMs: 250,
  });
  const backend = storage();
  const originalPut = backend.putArtifact.bind(backend);
  backend.putArtifact = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    return originalPut(input);
  };
  const service = createConversionArtifactService({
    repository: repository(),
    lifecycleRepository: lifecycle,
    storageAdapter: backend,
    leaseHeartbeatIntervalMs: 25,
  });

  const published = await service.putArtifact({ ...binding, content: Buffer.from("renewed") });

  assert.equal(published.status, "available");
  assert.ok(Date.now() > initialLeaseExpiry.getTime());
  assert.ok(renewals >= 2);
  assert.equal(document.writeLeases.length, 0);
});

test("final lifecycle fence rejects publication and removes provisional state", async () => {
  const repo = repository();
  const backend = storage();
  repo.validateWriteLease = async (operationBinding) => {
    const lifecycle = repo.lifecycles.get([
      operationBinding.ownerScope,
      operationBinding.userId,
      operationBinding.sessionId,
      operationBinding.uploadId,
      operationBinding.runId,
      operationBinding.targetTemplateId,
    ].join("\0"));
    lifecycle.status = "purging";
    return null;
  };
  const service = createConversionArtifactService({
    repository: repo,
    lifecycleRepository: repo,
    storageAdapter: backend,
  });

  await assert.rejects(
    service.putArtifact({ ...binding, content: Buffer.from("provisional") }),
    (error) => error.code === "ARTIFACT_OPERATION_PURGED" && error.statusCode === 410,
  );
  assert.equal(repo.documents.length, 0);
  assert.equal(backend.objects.size, 0);
});

test("durable write intent exists before GridFS and survives cleanup bookkeeping failure", async () => {
  const repo = repository();
  const backend = storage();
  backend.putArtifact = async ({ objectId, bytes }) => {
    assert.equal(repo.documents.some((item) => item.gridFsObjectId === objectId && item.status === "write_intent"), true);
    backend.objects.set(objectId, Buffer.from(bytes));
    const error = new Error("simulated upload crash");
    error.code = "GRIDFS_UPLOAD_FAILED";
    error.orphanedArtifact = { objectId, sha256: "a".repeat(64), sizeBytes: 5, mime: "application/octet-stream" };
    throw error;
  };
  backend.deleteArtifact = async () => { throw new Error("byte cleanup unavailable"); };
  repo.markStatus = async () => { throw new Error("intent update unavailable"); };
  const service = createConversionArtifactService({
    repository: repo,
    lifecycleRepository: repo,
    storageAdapter: backend,
  });

  await assert.rejects(
    service.putArtifact({ ...binding, content: Buffer.from("crash") }),
    (error) => error.code === "ARTIFACT_CLEANUP_PENDING",
  );
  assert.equal(repo.documents.length, 1);
  assert.equal(repo.documents[0].status, "write_intent");
  assert.equal((await repo.findExpired({ now: new Date(), limit: 10 }))[0], repo.documents[0]);
});

test("Mongo lifecycle fence stores only an HMAC key and expires purged records", async () => {
  const calls = [];
  const model = {
    collection: keyCanaryCollection(),
    async findOneAndUpdate(filter, update) {
      calls.push({ filter, update });
      if (update.$set?.status === "purged") {
        return { ...filter, status: "purged", writeLeases: [], ...update.$set };
      }
      return null;
    },
    async create(payload) {
      calls.push({ create: payload });
      return payload;
    },
    async findOne() { return null; },
    async updateOne() {},
  };
  const lifecycle = createMongooseOperationLifecycleRepository(model, {
    hmacSecret: "artifact-lifecycle-test-secret-at-least-32-characters",
    lifecycleRetentionMs: 86_400_000,
  });

  const lease = await lifecycle.acquireWriteLease(binding, {
    retainUntil: new Date("2026-08-05T00:00:00.000Z"),
  });
  const created = calls.find((item) => item.create).create;
  assert.deepEqual(created.operationKeys.map(({ keyId }) => keyId), ["v1"]);
  assert.match(created.operationKeys[0].operationKey, /^[a-f0-9]{64}$/);
  for (const field of ["ownerScope", "userId", "sessionId", "uploadId", "runId", "targetTemplateId"]) {
    assert.equal(Object.hasOwn(created, field), false);
  }

  await lifecycle.releaseWriteLease(binding, lease.leaseId);
  await lifecycle.beginPurge(binding, new Date("2026-08-06T00:00:00.000Z"));
  await lifecycle.markPurged(binding, new Date("2026-08-06T00:00:00.000Z"));
  const terminal = calls.find((item) => item.update?.$set?.status === "purged");
  assert.ok(terminal.update.$set.purgeAt > new Date("2026-08-06T00:00:00.000Z"));
  const lifecycleSchema = require("mongoose").models.ConversionOperationLifecycle.schema;
  const ttl = lifecycleSchema.indexes().find(([, options]) => options.name === "conversion_operation_purged_ttl");
  assert.deepEqual(ttl[1].partialFilterExpression, { status: "purged" });
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

test("artifact sweeper waits for the maximum retention horizon across operation siblings", async () => {
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
    kind: "state",
    expiresAt: new Date("2026-07-31T00:01:00.000Z"),
    content: Buffer.from("early"),
  });
  await service.putArtifact({
    ...binding,
    kind: "output",
    expiresAt: new Date("2026-07-31T01:00:00.000Z"),
    content: Buffer.from("future-sibling"),
  });

  current = new Date("2026-07-31T00:02:00.000Z");
  const early = await service.sweepExpiredArtifacts({ limit: 10 });
  assert.equal(early.deleted, 0);
  assert.equal(repo.documents.length, 2);
  assert.equal(backend.objects.size, 2);
  assert.equal([...repo.lifecycles.values()][0].status, "active");

  current = new Date("2026-07-31T01:01:00.000Z");
  const expired = await service.sweepExpiredArtifacts({ limit: 10 });
  assert.equal(expired.deleted, 2);
  assert.equal(repo.documents.length, 0);
  assert.equal(backend.objects.size, 0);
});

test("artifact sweeper cursor advances past a future-retained prefix without unbounded scanning", async () => {
  const repo = repository();
  const backend = storage();
  const now = new Date("2026-08-01T00:00:00.000Z");
  const future = new Date("2026-08-02T00:00:00.000Z");
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    _id: index + 1,
    ...binding,
    revision: index + 1,
    gridFsObjectId: `live-${index + 1}`,
    status: "available",
    tombstoneOnly: false,
    expiresAt: new Date("2026-07-31T00:00:00.000Z"),
  }));
  const eligible = {
    _id: 11,
    gridFsObjectId: "eligible-tombstone",
    status: "deletion_pending",
    tombstoneOnly: true,
  };
  candidates.push(eligible);
  repo.tombstones.push(eligible);
  backend.objects.set(eligible.gridFsObjectId, Buffer.from("orphan"));
  repo.findExpired = async ({ afterId, limit }) => candidates
    .filter((candidate) => afterId == null || candidate._id > afterId)
    .slice(0, limit);
  repo.findSessionRetentionHorizon = async () => future;
  const service = createConversionArtifactService({
    repository: repo,
    lifecycleRepository: repo,
    storageAdapter: backend,
    now: () => now,
  });

  const first = await service.sweepExpiredArtifacts({ limit: 1 });
  const second = await service.sweepExpiredArtifacts({ limit: 1 });

  assert.equal(first.deleted, 0);
  assert.equal(first.scanned <= 8, true);
  assert.equal(second.deleted, 1);
  assert.equal(second.scanned <= 8, true);
  assert.equal(backend.objects.has(eligible.gridFsObjectId), false);
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
  failingRepo.publishWriteIntent = async () => {
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

test("metadata failure plus GridFS delete failure leaves a purgeable write intent", async () => {
  const repo = repository();
  repo.publishWriteIntent = async () => { throw new Error("metadata failed"); };
  const backend = storage();
  backend.failDeletes = true;
  const service = createConversionArtifactService({
    repository: repo,
    storageAdapter: backend,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });

  await assert.rejects(
    service.putArtifact({ ...binding, content: Buffer.from("orphan") }),
    (error) => error.code === "ARTIFACT_CLEANUP_PENDING",
  );
  assert.equal(repo.documents.length, 1);
  assert.equal(repo.documents[0].status, "deletion_pending");
  assert.equal(repo.documents[0].purgeAt.toISOString(), "2026-08-06T00:00:00.000Z");
});

test("GridFS write cleanup failure remains discoverable through its durable intent", async () => {
  const repo = repository();
  const backend = storage();
  backend.failDeletes = true;
  backend.putArtifact = async ({ objectId, bytes }) => {
    backend.objects.set(objectId, Buffer.from(bytes));
    const error = new Error("upload failed");
    error.code = "GRIDFS_UPLOAD_FAILED";
    error.orphanedArtifact = {
      objectId,
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

  await assert.rejects(
    service.putArtifact({ ...binding, content: Buffer.from("orphan") }),
    (error) => error.code === "ARTIFACT_CLEANUP_PENDING",
  );
  assert.equal(repo.documents.length, 1);
  assert.equal(repo.documents[0].status, "deletion_pending");
  assert.equal(repo.documents[0].purgeAt.toISOString(), "2026-08-06T00:00:00.000Z");
});

test("metadata failure never hides an undurable write-intent cleanup failure", async () => {
  const repo = repository();
  repo.publishWriteIntent = async () => { throw new Error("metadata secret"); };
  repo.markStatus = async () => { throw new Error("repository secret"); };
  const backend = storage();
  backend.failDeletes = true;
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });

  await assert.rejects(
    service.putArtifact({ ...binding, content: Buffer.from("orphan") }),
    (error) => error.code === "ARTIFACT_CLEANUP_PENDING" && !error.message.includes("secret"),
  );
  assert.equal(repo.documents[0].status, "write_intent");
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
  [...repo.lifecycles.values()][0].retainUntil = new Date("2026-07-29T00:00:00.000Z");
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
