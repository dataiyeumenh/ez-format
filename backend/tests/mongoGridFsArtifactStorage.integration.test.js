const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const { MongoGridFsArtifactStorageAdapter } = require("../services/mongoGridFsArtifactStorage");

const testUri = String(process.env.GRIDFS_INTEGRATION_TEST_URI || "").trim();
const databaseName = testUri.split("?")[0].split("/").at(-1) || "";
const skipReason = !testUri
  ? "GRIDFS_INTEGRATION_TEST_URI is not set; real MongoDB/GridFS round-trip is skipped."
  : !/(?:^|[-_])test$/i.test(databaseName)
    ? "GRIDFS_INTEGRATION_TEST_URI must use a database name ending in -test or _test."
    : false;

test("real MongoDB/GridFS adapter round-trips and deletes an artifact", { skip: skipReason || false }, async () => {
  const client = new mongoose.mongo.MongoClient(testUri);
  await client.connect();
  const db = client.db();
  const bucketName = `qa_task11_${process.pid}_${Date.now()}`;
  const adapter = new MongoGridFsArtifactStorageAdapter({
    db,
    bucketName,
    maxBytes: 1024,
  });
  const bytes = Buffer.from("Task 11 GridFS evidence");

  try {
    const published = await adapter.putArtifact({
      bytes,
      metadata: {
        ownerScope: "qa:task11",
        runId: "task11-gridfs-roundtrip",
        mime: "text/plain",
      },
    });
    const found = await adapter.getArtifact({ objectId: published.objectId });
    assert.ok(found);
    const chunks = [];
    for await (const chunk of found.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(found.sizeBytes, bytes.length);
    assert.equal(found.mime, "text/plain");

    await adapter.deleteArtifact({ objectId: published.objectId });
    assert.equal(await adapter.getArtifact({ objectId: published.objectId }), null);
  } finally {
    await db.collection(`${bucketName}.files`).deleteMany({});
    await db.collection(`${bucketName}.chunks`).deleteMany({});
    await client.close();
  }
});
