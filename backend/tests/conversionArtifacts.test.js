const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createConversionArtifactService,
} = require("../services/conversionArtifactService");

function repository() {
  const documents = [];
  const tombstones = [];
  return {
    documents,
    tombstones,
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
      const item = documents.find((document) => document.gridFsObjectId === objectId);
      if (item) Object.assign(item, updates, { status });
    },
    async findExpired() {
      return documents.filter((item) => item.status === "deletion_pending");
    },
    async createTombstone(metadata) {
      tombstones.push(metadata);
      return metadata;
    },
  };
}

function storage() {
  const objects = new Map();
  let id = 1;
  return {
    objects,
    failDeletes: false,
    async putArtifact(input) {
      const objectId = `object-${id++}`;
      objects.set(objectId, Buffer.from(input.bytes));
      return {
        objectId,
        sha256: require("node:crypto").createHash("sha256").update(input.bytes).digest("hex"),
        sizeBytes: input.bytes.length,
      };
    },
    async getArtifact({ objectId }) {
      const bytes = objects.get(objectId);
      return bytes ? { bytes } : null;
    },
    async deleteArtifact({ objectId }) {
      if (this.failDeletes) throw new Error("delete failed");
      objects.delete(objectId);
      return { deleted: true };
    },
  };
}

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

test("artifact service binds metadata, validates checksum, and compensates storage on metadata failure", async () => {
  const repo = repository();
  const backend = storage();
  const service = createConversionArtifactService({ repository: repo, storageAdapter: backend });
  const saved = await service.putArtifact({ ...binding, content: Buffer.from("artifact") });

  assert.equal(saved.ownerScope, binding.ownerScope);
  assert.equal(saved.runId, binding.runId);
  assert.equal(saved.status, "available");
  assert.deepEqual((await service.getArtifact(binding)).content, Buffer.from("artifact"));

  await assert.rejects(
    service.getArtifact({ ...binding, ownerScope: "user:other" }),
    (error) => error.code === "ARTIFACT_OWNER_MISMATCH",
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
