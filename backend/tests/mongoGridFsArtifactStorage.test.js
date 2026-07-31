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
            .filter((file) => Object.entries(query).every(([field, expected]) => {
              if (field === "_id") return String(file.id) === String(expected);
              if (!field.startsWith("metadata.")) return false;
              return String(file.metadata[field.slice("metadata.".length)] ?? "") === String(expected);
            }))
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

test("GridFS binding lookup requires every operation identity field without over-match", async () => {
  const gridFs = memoryGridFs();
  const adapter = new MongoGridFsArtifactStorageAdapter({
    db: {},
    bucketName: "conversion_artifacts",
    maxBytes: 32,
    GridFSBucket: gridFs.FakeBucket,
  });
  const exact = {
    ownerScope: "user:user-1",
    userId: "user-1",
    sessionId: "session-1",
    uploadId: "upload-1",
    runId: "run-1",
    targetTemplateId: "bsn_sales",
    kind: "state",
    revision: 1,
  };
  const exactArtifact = await adapter.putArtifact({ bytes: Buffer.from("exact"), metadata: exact });
  for (const [field, value] of Object.entries({
    ownerScope: "user:user-2",
    userId: "user-2",
    sessionId: "session-2",
    uploadId: "upload-2",
    runId: "run-2",
    targetTemplateId: "bsn_purchase",
  })) {
    await adapter.putArtifact({
      bytes: Buffer.from(field),
      metadata: { ...exact, [field]: value },
    });
  }
  await adapter.putArtifact({ bytes: Buffer.from("kind"), metadata: { ...exact, kind: "output" } });
  await adapter.putArtifact({ bytes: Buffer.from("revision"), metadata: { ...exact, revision: 2 } });

  const operationMatches = await adapter.findArtifactsByBinding((({ kind, revision, ...value }) => value)(exact));
  const exactMatches = await adapter.findArtifactsByBinding(exact);

  await assert.rejects(
    adapter.findArtifactsByBinding({ ownerScope: exact.ownerScope, runId: exact.runId }),
    (error) => error.code === "INVALID_ARTIFACT_BINDING",
  );

  assert.deepEqual(operationMatches.map((item) => item.objectId), [exactArtifact.objectId,
    [...gridFs.files.values()].find((item) => item.metadata.kind === "output").id,
    [...gridFs.files.values()].find((item) => item.metadata.revision === 2).id,
  ]);
  assert.deepEqual(exactMatches, [{ objectId: exactArtifact.objectId }]);
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
