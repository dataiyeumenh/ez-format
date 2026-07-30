const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable } = require("node:stream");

const {
  MongoGridFsArtifactStorageAdapter,
} = require("../services/mongoGridFsArtifactStorage");

function memoryGridFs() {
  const files = new Map();
  let nextId = 1;

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

    async delete(id) {
      if (!files.delete(id)) {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
    }
  }

  return { files, FakeBucket };
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
  assert.deepEqual(read.bytes, Buffer.from("hello"));
  assert.equal(read.sha256, published.sha256);

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
