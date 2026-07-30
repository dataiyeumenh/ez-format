const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable } = require("node:stream");

const {
  MongoGridFsArtifactStorageAdapter,
} = require("../services/mongoGridFsArtifactStorage");

function memoryGridFs() {
  const files = new Map();
  let nextId = 1;
  let failDeletes = false;

  class FakeBucket {
    openUploadStream(filename, options = {}) {
      const id = `grid-${nextId++}`;
      const chunks = [];
      const stream = new (require("node:stream").Writable)({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          files.set(id, {
            id,
            filename,
            metadata: options.metadata || {},
            bytes: Buffer.concat(chunks),
          });
          callback();
        },
      });
      stream.id = id;
      return stream;
    }

    openDownloadStream(id) {
      const file = files.get(id);
      return Readable.from(file ? [file.bytes] : []);
    }

    find(query) {
      return {
        limit: () => ({
          toArray: async () => [...files.values()]
            .filter((file) => String(file.id) === String(query._id))
            .map((file) => ({ _id: file.id, length: file.bytes.length, metadata: file.metadata })),
        }),
      };
    }

    async delete(id) {
      if (failDeletes) throw new Error("delete backend secret");
      if (!files.delete(id)) {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
    }
  }

  return {
    files,
    FakeBucket,
    setFailDeletes(value) { failDeletes = value; },
  };
}

test("GridFS adapter streams bounded bytes, hashes them, and never accepts a browser key", async () => {
  const gridFs = memoryGridFs();
  const adapter = new MongoGridFsArtifactStorageAdapter({
    db: {},
    bucketName: "conversion_artifacts",
    maxBytes: 32,
    GridFSBucket: gridFs.FakeBucket,
  });

  const published = await adapter.putArtifact({
    bytes: Readable.from([Buffer.from("hello")]),
    metadata: { ownerScope: "user:user-1", runId: "run-1", mime: "text/plain" },
    key: "../../browser-chosen-path",
  });

  assert.equal(published.sizeBytes, 5);
  assert.equal(published.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(gridFs.files.size, 1);
  assert.equal(gridFs.files.get(published.objectId).filename, "temporary");

  const read = await adapter.getArtifact({ objectId: published.objectId });
  assert.equal(read.bytes, undefined);
  assert.equal(read.sha256, undefined);
  assert.equal(read.sizeBytes, 5);
  assert.deepEqual(Buffer.concat(await read.stream.toArray()), Buffer.from("hello"));

  await assert.rejects(
    adapter.putArtifact({
      bytes: Readable.from([Buffer.alloc(33)]),
      metadata: { ownerScope: "user:user-1", runId: "run-1" },
    }),
    (error) => error.code === "ARTIFACT_TOO_LARGE",
  );
});

test("GridFS adapter deletes only the generated object id", async () => {
  const gridFs = memoryGridFs();
  const adapter = new MongoGridFsArtifactStorageAdapter({
    db: {},
    bucketName: "conversion_artifacts",
    maxBytes: 32,
    GridFSBucket: gridFs.FakeBucket,
  });
  const published = await adapter.putArtifact({
    bytes: Buffer.from("delete-me"),
    metadata: { ownerScope: "user:user-1", runId: "run-1" },
  });

  await adapter.deleteArtifact({ objectId: published.objectId });
  assert.equal(gridFs.files.size, 0);
});

test("GridFS download source errors terminate the returned artifact stream", async () => {
  const gridFs = memoryGridFs();
  const adapter = new MongoGridFsArtifactStorageAdapter({
    db: {},
    bucketName: "conversion_artifacts",
    maxBytes: 32,
    GridFSBucket: gridFs.FakeBucket,
  });
  const published = await adapter.putArtifact({ bytes: Buffer.from("hello"), metadata: {} });
  const sourceError = new Error("GridFS source failed");
  adapter.bucket.openDownloadStream = () => Readable.from((async function* () {
    yield Buffer.from("hello");
    throw sourceError;
  })());

  const found = await adapter.getArtifact({ objectId: published.objectId });
  await assert.rejects((async () => {
    for await (const chunk of found.stream) void chunk;
  })(), (error) => error === sourceError);
});

test("GridFS write cleanup failure exposes only bounded orphan metadata for tombstoning", async () => {
  const gridFs = memoryGridFs();
  const adapter = new MongoGridFsArtifactStorageAdapter({
    db: {},
    bucketName: "conversion_artifacts",
    maxBytes: 4,
    GridFSBucket: gridFs.FakeBucket,
  });
  gridFs.setFailDeletes(true);

  await assert.rejects(
    adapter.putArtifact({ bytes: Buffer.from("oversized"), metadata: { mime: "text/plain" } }),
    (error) => error.code === "ARTIFACT_TOO_LARGE"
      && error.orphanedArtifact?.objectId
      && /^[a-f0-9]{64}$/.test(error.orphanedArtifact.sha256)
      && error.orphanedArtifact.sizeBytes === 9
      && !error.message.includes("secret"),
  );
});
